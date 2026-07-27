const app = document.getElementById('app');
const navLinks = document.querySelectorAll('[data-nav]');

function setActiveNav(name) {
  navLinks.forEach((a) => a.classList.toggle('active', a.dataset.nav === name));
}

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const body = isJson ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    const message = (body && body.error) || `${res.status} ${res.statusText}`;
    const err = new Error(message);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function pagePath(u) {
  try {
    return new URL(u).pathname || '/';
  } catch {
    return u;
  }
}

// ---------- Router ----------

function currentRoute() {
  const hash = location.hash.replace(/^#/, '') || '/new';
  const jobMatch = hash.match(/^\/jobs\/(.+)$/);
  if (jobMatch) return { view: 'job', id: decodeURIComponent(jobMatch[1]) };
  if (hash === '/history') return { view: 'history' };
  return { view: 'new' };
}

window.addEventListener('hashchange', render);
window.addEventListener('DOMContentLoaded', render);

let activeEventSource = null;
function teardown() {
  if (activeEventSource) {
    activeEventSource.close();
    activeEventSource = null;
  }
  closeLightbox();
}

function render() {
  teardown();
  const route = currentRoute();
  setActiveNav(route.view === 'job' ? '' : route.view);
  if (route.view === 'job') renderJobView(route.id);
  else if (route.view === 'history') renderHistoryView();
  else renderNewAuditView();
}

// ---------- New audit view ----------

async function renderNewAuditView() {
  const tpl = document.getElementById('tpl-new-audit');
  app.replaceChildren(tpl.content.cloneNode(true));

  const urlBulk = document.getElementById('url-bulk');
  const urlCount = document.getElementById('url-count');

  function parsedUrls() {
    return urlBulk.value
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  function updateCount() {
    const n = parsedUrls().length;
    urlCount.textContent = `${n} page${n === 1 ? '' : 's'}`;
  }
  urlBulk.addEventListener('input', updateCount);
  updateCount();

  const presetSelect = document.getElementById('preset-select');
  try {
    const presets = await fetchJSON('/api/presets');
    presets.forEach((p, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `${p.name} (${p.urls.length} page${p.urls.length === 1 ? '' : 's'})`;
      presetSelect.appendChild(opt);
    });
    presetSelect.addEventListener('change', () => {
      if (presetSelect.value === '') return;
      const p = presets[Number(presetSelect.value)];
      document.getElementById('site-name').value = p.name;
      if (p.viewport) {
        document.getElementById('viewport-width').value = p.viewport.width;
        document.getElementById('viewport-height').value = p.viewport.height;
      }
      urlBulk.value = p.urls.join('\n');
      updateCount();
    });
  } catch {
    // presets are a convenience only — a fetch failure here shouldn't block manual entry
  }

  document.getElementById('start-audit').addEventListener('click', async () => {
    const errorEl = document.getElementById('form-error');
    errorEl.textContent = '';
    const siteName = document.getElementById('site-name').value.trim();
    const urls = parsedUrls();
    const width = Number(document.getElementById('viewport-width').value) || null;
    const height = Number(document.getElementById('viewport-height').value) || null;
    const concurrency = Number(document.getElementById('concurrency').value) || 3;

    if (!urls.length) {
      errorEl.textContent = 'Add at least one page to audit.';
      return;
    }

    const button = document.getElementById('start-audit');
    button.disabled = true;
    button.textContent = 'Starting…';
    try {
      const job = await fetchJSON('/api/audits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          siteName,
          urls,
          concurrency,
          viewport: width && height ? { width, height } : null,
        }),
      });
      location.hash = `#/jobs/${encodeURIComponent(job.id)}`;
    } catch (e) {
      errorEl.textContent = e.message;
      button.disabled = false;
      button.textContent = 'Start audit';
    }
  });
}

// ---------- Job view ----------

const SEVERITY_LABEL = { critical: 'Critical', serious: 'Serious', moderate: 'Moderate', minor: 'Minor' };
const SEVERITY_ORDER = ['critical', 'serious', 'moderate', 'minor', 'manual'];

function renderKpis(summary) {
  const totals = Object.values(summary.totals).reduce((a, b) => a + b, 0);
  return `
    <div class="kpi accent"><div class="num">${summary.pagesAudited}</div><div class="label">Pages audited</div></div>
    <div class="kpi"><div class="num">${totals}</div><div class="label">Automated failures</div></div>
    <div class="kpi manual"><div class="num">${summary.manualReviewCount}</div><div class="label">Manual-review items</div></div>
    <div class="kpi critical"><div class="num">${summary.pagesErrored}</div><div class="label">Pages errored</div></div>
  `;
}

function renderBreakdown(breakdown) {
  const total = Object.values(breakdown.bySeverity).reduce((a, b) => a + b, 0) || 1;
  const sevHtml = SEVERITY_ORDER.filter((k) => breakdown.bySeverity[k] > 0)
    .map((k) => {
      const n = breakdown.bySeverity[k];
      const pct = Math.round((n / total) * 100);
      const label = k === 'manual' ? 'Manual review' : SEVERITY_LABEL[k];
      const cls = k === 'manual' ? 'manual' : k;
      return `
        <div class="breakdown-bar-row">
          <span class="breakdown-bar-label"><span class="chip ${cls}">${label}</span></span>
          <div class="breakdown-bar-track"><div class="breakdown-bar-fill ${cls}" style="width:${pct}%"></div></div>
          <span class="breakdown-bar-num">${n}</span>
        </div>`;
    })
    .join('');
  document.getElementById('breakdown-severity').innerHTML = sevHtml || '<p class="empty-note">No findings.</p>';

  const checkRows = breakdown.byCheck
    .map((c) => `<tr><td>${escapeHtml(c.checkLabel)}</td><td class="num">${c.count}</td><td class="num">${c.pages}</td></tr>`)
    .join('');
  document.getElementById('breakdown-check-rows').innerHTML = checkRows || '<tr><td colspan="3" class="empty-note">No findings.</td></tr>';

  const pageRows = breakdown.byPage
    .map((p) => `<tr><td class="pagecell" title="${escapeHtml(p.page)}">${escapeHtml(pagePath(p.page))}</td><td class="num">${p.automated}</td><td class="num">${p.manual}</td></tr>`)
    .join('');
  document.getElementById('breakdown-page-rows').innerHTML = pageRows || '<tr><td colspan="3" class="empty-note">No findings.</td></tr>';
}

function severityChip(f) {
  if (f.manualReview) return '<span class="chip manual">Manual</span>';
  if (f.severity) return `<span class="chip ${f.severity}">${SEVERITY_LABEL[f.severity] || f.severity}</span>`;
  return '';
}

function thumbHtml(screenshot, fullPageScreenshot, altLabel) {
  const src = screenshot || fullPageScreenshot;
  if (!src) return '<div class="finding-thumb empty">no capture</div>';
  return `<img class="finding-thumb" src="${escapeHtml(src)}" alt="${escapeHtml(altLabel)}" aria-label="${escapeHtml(altLabel)}" loading="lazy" data-full="${escapeHtml(src)}" tabindex="0" role="button" aria-haspopup="dialog">`;
}

// Decorative-only variant for the sample thumbnail shown inside a <summary> —
// a <summary> is itself an interactive disclosure control, so nesting another
// focusable/interactive element inside it violates the nested-interactive rule.
function thumbPreviewHtml(screenshot, fullPageScreenshot) {
  const src = screenshot || fullPageScreenshot;
  if (!src) return '<div class="finding-thumb-preview empty">no capture</div>';
  return `<img class="finding-thumb-preview" src="${escapeHtml(src)}" alt="" loading="lazy">`;
}

function findingCard(f) {
  const path = pagePath(f.page);
  return `
    <div class="finding-card">
      ${thumbHtml(f.screenshot, f.fullPageScreenshot, `Evidence for ${f.checkLabel} on ${path}`)}
      <div class="finding-body">
        <div class="finding-top">${severityChip(f)}<span class="finding-page" title="${escapeHtml(f.page)}">${escapeHtml(path)}</span><strong>${escapeHtml(f.checkLabel)}</strong></div>
        <div class="finding-summary">${escapeHtml(f.summary)}</div>
      </div>
    </div>`;
}

function findingGroupCard(g) {
  const sample = g.instances.find((i) => i.screenshot) || g.instances[0] || {};
  const pageListHtml = g.pages
    .map((page) => {
      const inst = g.instances.find((i) => i.page === page) || {};
      return `
        <li class="finding-page-row">
          ${thumbHtml(inst.screenshot, inst.fullPageScreenshot, `Evidence for ${g.checkLabel} on ${pagePath(page)}`)}
          <span class="finding-page-row-label" title="${escapeHtml(page)}">${escapeHtml(pagePath(page))}</span>
        </li>`;
    })
    .join('');
  return `
    <details class="finding-group">
      <summary class="finding-group-summary">
        <span class="finding-thumb-wrap">${thumbPreviewHtml(sample.screenshot, sample.fullPageScreenshot)}</span>
        <span class="finding-group-meta">
          <span class="finding-top">${severityChip(g)}<strong>${escapeHtml(g.checkLabel)}</strong></span>
          <span class="finding-summary">${escapeHtml(g.summary)}</span>
        </span>
        <span class="finding-page-count">${g.pageCount} page${g.pageCount === 1 ? '' : 's'}</span>
      </summary>
      <ul class="finding-page-list">${pageListHtml}</ul>
    </details>`;
}

// ---------- Lightbox ----------

function collectVisibleThumbs() {
  return [...document.querySelectorAll('.finding-thumb:not(.empty)')];
}

let lightboxIndex = -1;
function openLightboxAt(index) {
  const thumbs = collectVisibleThumbs();
  if (!thumbs.length) return;
  lightboxIndex = ((index % thumbs.length) + thumbs.length) % thumbs.length;
  const el = thumbs[lightboxIndex];
  const src = el.dataset.full || el.src;
  document.getElementById('lightbox-img').src = src;
  document.getElementById('lightbox-caption').textContent = el.alt || '';
  document.getElementById('lightbox-download').href = src;
  const lightbox = document.getElementById('lightbox');
  lightbox.hidden = false;
  document.getElementById('lightbox-close').focus();
}
function closeLightbox() {
  const lightbox = document.getElementById('lightbox');
  if (!lightbox || lightbox.hidden) return;
  lightbox.hidden = true;
  lightboxIndex = -1;
}
function lightboxStep(delta) {
  if (lightboxIndex < 0) return;
  openLightboxAt(lightboxIndex + delta);
}

document.addEventListener('click', (e) => {
  const thumb = e.target.closest('.finding-thumb:not(.empty)');
  if (!thumb) return;
  const thumbs = collectVisibleThumbs();
  openLightboxAt(thumbs.indexOf(thumb));
});
document.addEventListener('keydown', (e) => {
  const thumb = document.activeElement;
  if (e.key === 'Enter' && thumb && thumb.classList.contains('finding-thumb')) {
    const thumbs = collectVisibleThumbs();
    openLightboxAt(thumbs.indexOf(thumb));
  }
});
document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
document.getElementById('lightbox-prev').addEventListener('click', () => lightboxStep(-1));
document.getElementById('lightbox-next').addEventListener('click', () => lightboxStep(1));
document.getElementById('lightbox').addEventListener('click', (e) => {
  if (e.target.id === 'lightbox') closeLightbox();
});
document.addEventListener('keydown', (e) => {
  const lightbox = document.getElementById('lightbox');
  if (lightbox.hidden) return;
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowLeft') lightboxStep(-1);
  else if (e.key === 'ArrowRight') lightboxStep(1);
});

// ---------- Job view ----------

async function renderJobView(id) {
  const tpl = document.getElementById('tpl-job');
  app.replaceChildren(tpl.content.cloneNode(true));

  const titleEl = document.getElementById('job-title');
  const metaEl = document.getElementById('job-meta');
  const statusEl = document.getElementById('job-status');
  const cancelBtn = document.getElementById('cancel-job');
  const progressFill = document.getElementById('progress-bar-fill');
  const progressTrack = document.getElementById('progress-bar-track');
  const progressCaption = document.getElementById('progress-caption');
  const pageList = document.getElementById('page-list');
  const resultsSection = document.getElementById('results-section');

  const pageRows = new Map();
  let total = 0;
  let es;

  function setStatus(status) {
    statusEl.textContent = status;
    statusEl.className = `status-pill ${status}`;
    cancelBtn.hidden = !(status === 'pending' || status === 'running');
  }

  // Derived from row state rather than incremented by event count: the SSE
  // stream always replays a job's *entire* history on connect (not just new
  // events since last time), so a counter that adds on every 'page-done' it
  // sees would double-count when opening an already-finished job. Recounting
  // from the DOM is naturally idempotent no matter how many times a page's
  // events get (re)applied.
  function updateProgress() {
    const done = [...pageRows.values()].filter((li) => li.classList.contains('done') || li.classList.contains('error')).length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    progressFill.style.width = `${pct}%`;
    progressCaption.textContent = `${done} / ${total} pages complete`;
    progressTrack.setAttribute('aria-valuemax', String(total || 1));
    progressTrack.setAttribute('aria-valuenow', String(done));
  }

  function ensureRow(url) {
    if (pageRows.has(url)) return pageRows.get(url);
    const li = document.createElement('li');
    li.innerHTML = `<span class="dot"></span><span class="url-text"></span>`;
    li.querySelector('.url-text').textContent = url;
    pageList.appendChild(li);
    pageRows.set(url, li);
    return li;
  }

  function applyEvent(event) {
    if (event.type === 'page-start') {
      const li = ensureRow(event.url);
      li.className = 'active';
    } else if (event.type === 'page-done') {
      const li = ensureRow(event.url);
      li.className = 'done';
      updateProgress();
    } else if (event.type === 'page-error') {
      const li = ensureRow(event.url);
      li.className = 'error';
      li.replaceChildren(...li.querySelectorAll('.dot, .url-text'));
      const errText = document.createElement('div');
      errText.className = 'err-text';
      errText.textContent = event.error || 'error';
      li.appendChild(errText);
      updateProgress();
    } else if (event.type === 'status') {
      setStatus(event.status);
    } else if (event.type === 'done') {
      setStatus(event.status);
      if (es) es.close();
      loadResults();
    }
  }

  // ---- Results: breakdown + findings (grouped/raw, filter/search/sort/paginate) ----

  const state = { view: 'grouped', page: 0, pageSize: 25 };
  let resultsLoading = null;

  async function loadResults() {
    if (resultsLoading) return resultsLoading;
    resultsLoading = (async () => {
      let summary;
      try {
        summary = await fetchJSON(`/api/audits/${encodeURIComponent(id)}/summary`);
      } catch {
        return;
      }
      document.getElementById('kpi-strip').innerHTML = renderKpis(summary);
      resultsSection.hidden = false;

      document.getElementById('dl-html').href = `/api/audits/${encodeURIComponent(id)}/download/html`;
      document.getElementById('dl-docx').href = `/api/audits/${encodeURIComponent(id)}/download/docx`;
      document.getElementById('dl-json').href = `/api/audits/${encodeURIComponent(id)}/download/json`;
      document.getElementById('dl-summary').href = `/api/audits/${encodeURIComponent(id)}/download/summary`;
      document.getElementById('dl-screenshots').href = `/api/audits/${encodeURIComponent(id)}/download/screenshots`;

      try {
        const breakdown = await fetchJSON(`/api/audits/${encodeURIComponent(id)}/breakdown`);
        renderBreakdown(breakdown);
      } catch {
        // breakdown is supplementary — KPIs above still convey the totals
      }

      const pageSelect = document.getElementById('filter-page');
      const checkSelect = document.getElementById('filter-check');
      pageSelect.replaceChildren(new Option('All pages', ''));
      checkSelect.replaceChildren(new Option('All checks', ''));

      let checks = [];
      try {
        checks = await fetchJSON('/api/checks');
      } catch { /* filter dropdown just stays generic */ }
      checks.forEach((c) => {
        const opt = document.createElement('option');
        opt.value = c.key;
        opt.textContent = `${c.section.split(' · ')[1] || c.section} — ${c.label}`;
        checkSelect.appendChild(opt);
      });

      [...pageRows.keys()].forEach((url) => {
        const opt = document.createElement('option');
        opt.value = url;
        opt.textContent = pagePath(url);
        pageSelect.appendChild(opt);
      });

      const grid = document.getElementById('findings-grid');
      const countEl = document.getElementById('filter-count');
      const pagerPrev = document.getElementById('pager-prev');
      const pagerNext = document.getElementById('pager-next');
      const pagerStatus = document.getElementById('pager-status');
      const sortSelect = document.getElementById('filter-sort');
      const pageSizeSelect = document.getElementById('filter-page-size');
      const searchInput = document.getElementById('filter-search');
      const viewGroupedBtn = document.getElementById('view-grouped');
      const viewRawBtn = document.getElementById('view-raw');

      function setView(view) {
        state.view = view;
        state.page = 0;
        viewGroupedBtn.setAttribute('aria-pressed', String(view === 'grouped'));
        viewRawBtn.setAttribute('aria-pressed', String(view === 'raw'));
        // "Pages affected" sort only means something for the grouped view.
        sortSelect.querySelector('option[value="pageCount"]').hidden = view !== 'grouped';
        if (view !== 'grouped' && sortSelect.value === 'pageCount') sortSelect.value = 'severity';
        applyFilters();
      }
      viewGroupedBtn.addEventListener('click', () => setView('grouped'));
      viewRawBtn.addEventListener('click', () => setView('raw'));

      let searchDebounce;
      async function applyFilters() {
        const params = new URLSearchParams();
        if (pageSelect.value) params.set('page', pageSelect.value);
        if (checkSelect.value) params.set('check', checkSelect.value);
        const severityValue = document.getElementById('filter-severity').value;
        if (severityValue) params.set('severity', severityValue);
        const manualValue = document.getElementById('filter-manual').value;
        if (manualValue) params.set('manualReview', manualValue);
        if (searchInput.value.trim()) params.set('q', searchInput.value.trim());
        if (state.view === 'grouped') params.set('grouped', 'true');
        params.set('sortBy', sortSelect.value);
        state.pageSize = Number(pageSizeSelect.value) || 25;
        params.set('limit', String(state.pageSize));
        params.set('offset', String(state.page * state.pageSize));

        const body = await fetchJSON(`/api/audits/${encodeURIComponent(id)}/findings?${params.toString()}`);
        const totalPages = Math.max(1, Math.ceil(body.total / state.pageSize));
        countEl.textContent = `${body.total} ${state.view === 'grouped' ? 'group' : 'finding'}${body.total === 1 ? '' : 's'}`;
        pagerStatus.textContent = `Page ${body.total ? state.page + 1 : 0} of ${totalPages}`;
        pagerPrev.disabled = state.page <= 0;
        pagerNext.disabled = state.page + 1 >= totalPages;

        grid.innerHTML = body.items.length
          ? body.items.map((item) => (body.grouped ? findingGroupCard(item) : findingCard(item))).join('')
          : '<p class="empty-note">No findings match these filters.</p>';
      }

      [pageSelect, checkSelect, document.getElementById('filter-severity'), document.getElementById('filter-manual'), sortSelect, pageSizeSelect].forEach((el) =>
        el.addEventListener('change', () => {
          state.page = 0;
          applyFilters();
        })
      );
      searchInput.addEventListener('input', () => {
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => {
          state.page = 0;
          applyFilters();
        }, 250);
      });
      pagerPrev.addEventListener('click', () => {
        if (state.page > 0) {
          state.page -= 1;
          applyFilters();
        }
      });
      pagerNext.addEventListener('click', () => {
        state.page += 1;
        applyFilters();
      });

      await applyFilters();
    })();
    return resultsLoading;
  }

  cancelBtn.addEventListener('click', async () => {
    cancelBtn.disabled = true;
    try {
      await fetchJSON(`/api/audits/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
    } catch (e) {
      alert(`Could not cancel: ${e.message}`);
      cancelBtn.disabled = false;
    }
  });

  let job;
  try {
    job = await fetchJSON(`/api/audits/${encodeURIComponent(id)}`);
  } catch (e) {
    app.innerHTML = `<section class="panel"><h1>Audit not found</h1><p class="sub">${escapeHtml(e.message)}</p></section>`;
    return;
  }

  titleEl.textContent = job.siteName;
  metaEl.textContent = `${job.urls.length} page(s) · started ${fmtTime(job.startedAt)}`;
  setStatus(job.status);
  total = job.urls.length;
  job.urls.forEach((u) => ensureRow(u));
  updateProgress();

  const isTerminal = job.status === 'completed' || job.status === 'cancelled' || job.status === 'interrupted' || job.status === 'error';

  if (isTerminal && job.hasLog) {
    // A finished job whose owning process never restarted still has its full
    // event history — the SSE connection below replays it in full, which is
    // enough on its own to paint every row and load results. Nothing more to
    // do here; adding a second source of truth is what caused the
    // double-counted progress bug this comment is here to warn against.
  } else if (isTerminal) {
    // Hydrated from a job.json manifest after a server restart: no in-memory
    // log, so there's nothing for SSE to replay. Approximate row state from
    // the aggregate done count instead.
    total = job.urls.length;
    job.urls.forEach((u, i) => {
      const li = ensureRow(u);
      li.className = i < job.progress.done ? 'done' : '';
    });
    updateProgress();
    loadResults();
  }

  es = new EventSource(`/api/audits/${encodeURIComponent(id)}/events`);
  activeEventSource = es;
  es.onmessage = (msg) => applyEvent(JSON.parse(msg.data));
  es.onerror = () => {
    // SSE stream ends normally once the job is done; nothing to recover here.
  };
}

// ---------- History view ----------

async function renderHistoryView() {
  const tpl = document.getElementById('tpl-history');
  app.replaceChildren(tpl.content.cloneNode(true));
  const tbody = document.getElementById('history-rows');

  let jobs = [];
  try {
    jobs = await fetchJSON('/api/audits');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-note">${escapeHtml(e.message)}</td></tr>`;
    return;
  }

  if (!jobs.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-note">No audits yet — start one from "New audit".</td></tr>';
    return;
  }

  tbody.innerHTML = jobs
    .map(
      (j) => `
      <tr>
        <td>${escapeHtml(j.siteName)}</td>
        <td>${j.urls.length}</td>
        <td><span class="status-pill ${j.status}">${j.status}</span></td>
        <td>${fmtTime(j.startedAt || j.createdAt)}</td>
        <td><a href="#/jobs/${encodeURIComponent(j.id)}">View &rarr;<span class="sr-only"> ${escapeHtml(j.siteName)}</span></a></td>
      </tr>`
    )
    .join('');
}
