import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import url from 'node:url';
import express from 'express';
import { ZipArchive } from 'archiver';
import {
  createJob,
  startJob,
  cancelJob,
  getJob,
  listJobs,
  jobToJSON,
  getJobFindings,
  hasActiveJob,
  LIMITS,
} from './jobManager.js';
import { listCheckTypes, groupFindings, summarizeBreakdown } from '../report/findings.js';
import { sortFindings, searchFindings, defaultSortDir } from '../report/sortSearch.js';
import { checkTargetSafety } from '../engine/ssrfGuard.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', '..', 'web');

function shotUrl(jobId, absPath) {
  if (!absPath) return null;
  return `/api/audits/${jobId}/shot/${encodeURIComponent(path.basename(absPath))}`;
}

function rewriteFindingShots(jobId, findings) {
  return findings.map((f) => ({
    ...f,
    screenshot: shotUrl(jobId, f.screenshot),
    fullPageScreenshot: shotUrl(jobId, f.fullPageScreenshot),
  }));
}

function rewriteGroupShots(jobId, groups) {
  return groups.map((g) => ({ ...g, instances: rewriteFindingShots(jobId, g.instances) }));
}

/**
 * Read live (not cached at import time — see jobManager's outputRoot() for
 * why that matters) so tests can flip it per-process before making
 * requests. Sanctioned only for automated testing against the local
 * fixture server; never set this in a real deployment.
 */
function allowPrivateTargets() {
  return process.env.DASHBOARD_ALLOW_PRIVATE_TARGETS === 'true';
}

/**
 * HTTP Basic Auth, active only when both env vars are set. Deliberately
 * fails closed: if only one of the pair is set, every request is rejected
 * rather than silently running unauthenticated — a half-configured secret
 * is a misconfiguration, not an opt-out.
 */
function basicAuthMiddleware() {
  const user = process.env.DASHBOARD_USERNAME;
  const pass = process.env.DASHBOARD_PASSWORD;
  if (!user && !pass) return (req, res, next) => next();

  return (req, res, next) => {
    if (!user || !pass) {
      res.status(500).json({ error: 'Server misconfigured: only one of DASHBOARD_USERNAME/DASHBOARD_PASSWORD is set.' });
      return;
    }
    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      const reqUser = sep === -1 ? decoded : decoded.slice(0, sep);
      const reqPass = sep === -1 ? '' : decoded.slice(sep + 1);
      const userOk = reqUser.length === user.length && crypto.timingSafeEqual(Buffer.from(reqUser), Buffer.from(user));
      const passOk = reqPass.length === pass.length && crypto.timingSafeEqual(Buffer.from(reqPass), Buffer.from(pass));
      if (userOk && passOk) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Console Warrior Dashboard"');
    res.status(401).send('Authentication required.');
  };
}

export function createApp() {
  const app = express();
  app.use(basicAuthMiddleware());
  app.use(express.json());

  app.use(express.static(WEB_DIR));

  app.get('/api/checks', (req, res) => {
    res.json(listCheckTypes());
  });

  app.get('/api/limits', (req, res) => {
    res.json(LIMITS);
  });

  app.get('/api/presets', async (req, res) => {
    const configDir = path.join(process.cwd(), 'config', 'sites');
    let entries;
    try {
      entries = await fsp.readdir(configDir);
    } catch {
      return res.json([]);
    }
    const presets = [];
    for (const entry of entries.filter((f) => f.endsWith('.json'))) {
      try {
        const config = JSON.parse(await fsp.readFile(path.join(configDir, entry), 'utf8'));
        presets.push({ id: entry, name: config.name || entry, urls: config.urls || [], viewport: config.viewport || null });
      } catch {
        // skip unparseable config files rather than failing the whole list
      }
    }
    res.json(presets);
  });

  app.get('/api/audits', (req, res) => {
    res.json(listJobs());
  });

  app.post('/api/audits', async (req, res) => {
    const { siteName, urls, viewport, concurrency } = req.body || {};
    const cleanUrls = Array.isArray(urls)
      ? urls.map((u) => String(u).trim()).filter(Boolean)
      : [];
    if (!cleanUrls.length) {
      res.status(400).json({ error: 'At least one URL is required.' });
      return;
    }
    if (cleanUrls.length > LIMITS.maxPages) {
      res.status(400).json({ error: `Too many pages: ${cleanUrls.length} requested, ${LIMITS.maxPages} allowed per run.` });
      return;
    }
    const requestedConcurrency = Number(concurrency) > 0 ? Number(concurrency) : 3;
    if (requestedConcurrency > LIMITS.maxConcurrency) {
      res.status(400).json({ error: `Concurrency ${requestedConcurrency} exceeds the maximum of ${LIMITS.maxConcurrency}.` });
      return;
    }

    if (hasActiveJob()) {
      res.status(409).json({ error: 'An audit is already running. Cancel it or wait for it to finish before starting another.' });
      return;
    }

    const skipSsrfCheck = allowPrivateTargets();
    if (!skipSsrfCheck) {
      for (const u of cleanUrls) {
        // eslint-disable-next-line no-await-in-loop
        const result = await checkTargetSafety(u);
        if (!result.ok) {
          res.status(400).json({ error: result.reason });
          return;
        }
      }
    } else {
      // Still reject garbage URLs even with the private-target check bypassed for testing.
      for (const u of cleanUrls) {
        try {
          // eslint-disable-next-line no-new
          new URL(u);
        } catch {
          res.status(400).json({ error: `Not a valid URL: ${u}` });
          return;
        }
      }
    }

    const job = createJob({
      siteName: siteName && String(siteName).trim(),
      urls: cleanUrls,
      viewport: viewport && viewport.width && viewport.height ? viewport : null,
      concurrency: requestedConcurrency,
      ssrf: skipSsrfCheck ? null : {},
    });
    startJob(job);
    res.status(201).json(jobToJSON(job));
  });

  app.get('/api/audits/:id', (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(jobToJSON(job));
  });

  app.post('/api/audits/:id/cancel', (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const cancelled = cancelJob(req.params.id);
    if (!cancelled) {
      return res.status(409).json({ error: `Job is already ${job.status}; nothing to cancel.` });
    }
    res.json({ cancelling: true });
  });

  app.get('/api/audits/:id/events', (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders?.();

    const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    for (const event of job.log) send(event);
    if (job.status !== 'pending' && job.status !== 'running') {
      res.end();
      return;
    }

    const onEvent = (event) => send(event);
    job.emitter.on('event', onEvent);
    const keepalive = setInterval(() => res.write(': ping\n\n'), 20000);

    const cleanup = () => {
      clearInterval(keepalive);
      job.emitter.off('event', onEvent);
    };
    req.on('close', cleanup);
    job.emitter.on('event', (event) => {
      if (event.type === 'done') {
        cleanup();
        res.end();
      }
    });
  });

  app.get('/api/audits/:id/results', (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!job.results) return res.status(202).json({ status: job.status, message: 'Results not ready yet.' });
    res.json(job.results);
  });

  app.get('/api/audits/:id/summary', (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!job.summary) return res.status(202).json({ status: job.status, message: 'Summary not ready yet.' });
    res.json(job.summary);
  });

  app.get('/api/audits/:id/breakdown', (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const all = getJobFindings(req.params.id);
    if (!all) return res.status(202).json({ status: job.status, message: 'Breakdown not ready yet.' });
    res.json(summarizeBreakdown(all));
  });

  app.get('/api/audits/:id/findings', (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const all = getJobFindings(req.params.id);
    if (!all) return res.status(202).json({ status: job.status, message: 'Findings not ready yet.' });

    const { page, check, severity, manualReview, q, grouped, sortBy, sortDir, limit, offset } = req.query;

    let findings = all;
    if (page) findings = findings.filter((f) => f.page === page);
    if (check) findings = findings.filter((f) => f.checkKey === check);
    if (severity) findings = findings.filter((f) => f.severity === severity);
    if (manualReview === 'true') findings = findings.filter((f) => f.manualReview);
    if (manualReview === 'false') findings = findings.filter((f) => !f.manualReview);
    findings = searchFindings(findings, q);

    const isGrouped = grouped === 'true';
    let items = isGrouped ? groupFindings(findings) : findings;

    const effectiveSortBy = sortBy || (isGrouped ? 'pageCount' : 'severity');
    const effectiveSortDir = sortDir || defaultSortDir(effectiveSortBy);
    items = sortFindings(items, effectiveSortBy, effectiveSortDir);

    const total = items.length;
    const limitNum = Math.min(Math.max(Number(limit) || 50, 1), 500);
    const offsetNum = Math.max(Number(offset) || 0, 0);
    const pageItems = items.slice(offsetNum, offsetNum + limitNum);

    const rewritten = isGrouped ? rewriteGroupShots(job.id, pageItems) : rewriteFindingShots(job.id, pageItems);
    res.json({ total, offset: offsetNum, limit: limitNum, grouped: isGrouped, items: rewritten });
  });

  const DOWNLOADS = {
    html: { file: 'report.html', type: 'text/html', name: 'report.html' },
    docx: {
      file: 'report.docx',
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      name: 'report.docx',
    },
    json: { file: 'results.json', type: 'application/json', name: 'results.json' },
    summary: { file: 'summary.json', type: 'application/json', name: 'summary.json' },
  };

  app.get('/api/audits/:id/download/:format', async (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    if (req.params.format === 'screenshots') {
      const shotDir = path.join(job.outDir, 'screenshots');
      if (!fs.existsSync(shotDir)) return res.status(404).json({ error: 'No screenshots for this job.' });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${job.id}-screenshots.zip"`);
      const archive = new ZipArchive({ zlib: { level: 9 } });
      archive.on('error', (err) => res.status(500).end(String(err)));
      archive.pipe(res);
      archive.directory(shotDir, 'screenshots');
      await archive.finalize();
      return;
    }

    const spec = DOWNLOADS[req.params.format];
    if (!spec) return res.status(400).json({ error: `Unknown format: ${req.params.format}` });
    const filePath = path.join(job.outDir, spec.file);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: `${spec.file} not generated for this job (status: ${job.status}).` });
    res.setHeader('Content-Type', spec.type);
    res.setHeader('Content-Disposition', `attachment; filename="${job.id}-${spec.name}"`);
    fs.createReadStream(filePath).pipe(res);
  });

  app.get('/api/audits/:id/shot/:filename', async (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).end();
    const filename = path.basename(req.params.filename);
    const filePath = path.join(job.outDir, 'screenshots', filename);
    const shotDir = path.join(job.outDir, 'screenshots');
    if (!filePath.startsWith(shotDir + path.sep)) return res.status(400).end();
    try {
      await fsp.access(filePath);
    } catch {
      return res.status(404).end();
    }
    res.sendFile(filePath);
  });

  return app;
}
