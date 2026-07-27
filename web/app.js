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

  const urlRows = document.getElementById('url-rows');
  const addRow = (value = '') => {
    const row = document.createElement('div');
    row.className = 'url-row';
    row.innerHTML = `<input type="url" placeholder="https://example.com/page" value="${escapeHtml(value)}"><button type="button" class="btn-icon" aria-label="Remove page">&times;</button>`;
    row.querySelector('button').addEventListener('click', () => {
      row.remove();
      if (!urlRows.children.length) addRow();
    });
    urlRows.appendChild(row);
    return row;
  };
  addRow();

  document.getElementById('add-url-row').addEventListener('click', () => addRow());
  document.getElementById('paste-urls').addEventListener('click', () => {
    const text = prompt('Paste one URL per line (or comma-separated):');
    if (!text) return;
    const urls = text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
    if (!urls.length) return;
    urlRows.replaceChildren();
    urls.forEach((u) => addRow(u));
  });

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
      urlRows.replaceChildren();
      p.urls.forEach((u) => addRow(u));
    });
  } catch {
    // presets are a convenience only — a fetch failure here shouldn't block manual entry
  }

  document.getElementById('start-audit').addEventListener('click', async () => {
    const errorEl = document.getElementById('form-error');
    errorEl.textContent = '';
    const siteName = document.getElementById('site-name').value.trim();
    const urls = [...urlRows.querySelectorAll('input')].map((i) => i.value.trim()).filter(Boolean);
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

function renderKpis(summary) {
  const totals = Object.values(summary.totals).reduce((a, b) => a + b, 0);
  return `
    <div class="kpi accent"><div class="num">${summary.pagesAudited}</div><div class="label">Pages audited</div></div>
    <div class="kpi"><div class="num">${totals}</div><div class="label">Automated failures</div></div>
    <div class="kpi manual"><div class="num">${summary.manualReviewCount}</div><div class="label">Manual-review items</div></div>
    <div class="kpi critical"><div class="num">${summary.pagesErrored}</div><div class="label">Pages errored</div></div>
  `;
}

function findingCard(f) {
  const chip = f.manualReview
    ? '<span class="chip manual">Manual</span>'
    : f.severity
      ? `<span class="chip ${f.severity}">${SEVERITY_LABEL[f.severity] || f.severity}</span>`
      : '';
  const thumbSrc = f.screenshot || f.fullPageScreenshot;
  const thumb = thumbSrc
    ? `<img class="finding-thumb" src="${escapeHtml(thumbSrc)}" alt="Evidence screenshot" loading="lazy" data-full="${escapeHtml(thumbSrc)}">`
    : `<div class="finding-thumb empty">no capture</div>`;
  let path = '/';
  try { path = new URL(f.page).pathname || '/'; } catch { /* keep default */ }
  return `
    <div class="finding-card">
      ${thumb}
      <div class="finding-body">
        <div class="finding-top">${chip}<span class="finding-page" title="${escapeHtml(f.page)}">${escapeHtml(path)}</span><strong>${escapeHtml(f.checkLabel)}</strong></div>
        <div class="finding-summary">${escapeHtml(f.summary)}</div>
      </div>
    </div>`;
}

async function renderJobView(id) {
  const tpl = document.getElementById('tpl-job');
  app.replaceChildren(tpl.content.cloneNode(true));

  const titleEl = document.getElementById('job-title');
  const metaEl = document.getElementById('job-meta');
  const statusEl = document.getElementById('job-status');
  const cancelBtn = document.getElementById('cancel-job');
  const progressFill = document.getElementById('progress-bar-fill');
  const progressCaption = document.getElementById('progress-caption');
  const pageList = document.getElementById('page-list');
  const resultsSection = document.getElementById('results-section');

  const pageRows = new Map();
  let total = 0;
  let done = 0;
  let es;

  function setStatus(status) {
    statusEl.textContent = status;
    statusEl.className = `status-pill ${status}`;
    cancelBtn.hidden = !(status === 'pending' || status === 'running');
  }

  function updateProgress() {
    const pct = total ? Math.round((done / total) * 100) : 0;
    progressFill.style.width = `${pct}%`;
    progressCaption.textContent = `${done} / ${total} pages complete`;
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
      done += 1;
      updateProgress();
    } else if (event.type === 'page-error') {
      const li = ensureRow(event.url);
      li.className = 'error';
      const errText = document.createElement('div');
      errText.className = 'err-text';
      errText.textContent = event.error || 'error';
      li.appendChild(errText);
      done += 1;
      updateProgress();
    } else if (event.type === 'status') {
      setStatus(event.status);
    } else if (event.type === 'done') {
      setStatus(event.status);
      if (es) es.close();
      loadResults();
    }
  }

  // Safe to call more than once (SSE replay + the hydrated-job fallback both
  // may trigger it) — resets the filter dropdowns each time instead of
  // duplicating their options.
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
        try { opt.textContent = new URL(url).pathname || '/'; } catch { opt.textContent = url; }
        pageSelect.appendChild(opt);
      });

      const grid = document.getElementById('findings-grid');
      const countEl = document.getElementById('filter-count');

      async function applyFilters() {
        const params = new URLSearchParams();
        if (pageSelect.value) params.set('page', pageSelect.value);
        if (checkSelect.value) params.set('check', checkSelect.value);
        const severityValue = document.getElementById('filter-severity').value;
        if (severityValue) params.set('severity', severityValue);
        const manualValue = document.getElementById('filter-manual').value;
        if (manualValue) params.set('manualReview', manualValue);

        const findings = await fetchJSON(`/api/audits/${encodeURIComponent(id)}/findings?${params.toString()}`);
        countEl.textContent = `${findings.length} finding${findings.length === 1 ? '' : 's'}`;
        grid.innerHTML = findings.length
          ? findings.map(findingCard).join('')
          : '<p class="empty-note">No findings match these filters.</p>';
      }

      [pageSelect, checkSelect, document.getElementById('filter-severity'), document.getElementById('filter-manual')].forEach((el) =>
        el.addEventListener('change', applyFilters)
      );
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

  es = new EventSource(`/api/audits/${encodeURIComponent(id)}/events`);
  activeEventSource = es;
  es.onmessage = (msg) => applyEvent(JSON.parse(msg.data));
  es.onerror = () => {
    // SSE stream ends normally once the job is done; nothing to recover here.
  };

  if (job.status === 'completed' || job.status === 'cancelled' || job.status === 'interrupted') {
    done = job.progress.done;
    total = job.urls.length;
    updateProgress();
    job.urls.forEach((u, i) => {
      const li = ensureRow(u);
      li.className = i < done ? 'done' : '';
    });
    loadResults();
  }
}

document.addEventListener('click', (e) => {
  const img = e.target.closest('.finding-thumb:not(.empty)');
  if (!img) return;
  const lightbox = document.getElementById('lightbox');
  document.getElementById('lightbox-img').src = img.dataset.full || img.src;
  lightbox.hidden = false;
});
document.getElementById('lightbox-close').addEventListener('click', () => {
  document.getElementById('lightbox').hidden = true;
});
document.getElementById('lightbox').addEventListener('click', (e) => {
  if (e.target.id === 'lightbox') e.currentTarget.hidden = true;
});

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
        <td><a href="#/jobs/${encodeURIComponent(j.id)}">View →</a></td>
      </tr>`
    )
    .join('');
}
