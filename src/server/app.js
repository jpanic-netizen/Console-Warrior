import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
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
} from './jobManager.js';
import { listCheckTypes } from '../report/findings.js';

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

export function createApp() {
  const app = express();
  app.use(express.json());

  app.use(express.static(WEB_DIR));

  app.get('/api/checks', (req, res) => {
    res.json(listCheckTypes());
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

  app.post('/api/audits', (req, res) => {
    const { siteName, urls, viewport, concurrency } = req.body || {};
    const cleanUrls = Array.isArray(urls)
      ? urls.map((u) => String(u).trim()).filter(Boolean)
      : [];
    if (!cleanUrls.length) {
      res.status(400).json({ error: 'At least one URL is required.' });
      return;
    }
    for (const u of cleanUrls) {
      try {
        // eslint-disable-next-line no-new
        new URL(u);
      } catch {
        res.status(400).json({ error: `Not a valid URL: ${u}` });
        return;
      }
    }
    const job = createJob({
      siteName: siteName && String(siteName).trim(),
      urls: cleanUrls,
      viewport: viewport && viewport.width && viewport.height ? viewport : null,
      concurrency: Number(concurrency) > 0 ? Number(concurrency) : 3,
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

  app.get('/api/audits/:id/findings', (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const all = getJobFindings(req.params.id);
    if (!all) return res.status(202).json({ status: job.status, message: 'Findings not ready yet.' });

    let findings = all;
    const { page, check, severity, manualReview } = req.query;
    if (page) findings = findings.filter((f) => f.page === page);
    if (check) findings = findings.filter((f) => f.checkKey === check);
    if (severity) findings = findings.filter((f) => f.severity === severity);
    if (manualReview === 'true') findings = findings.filter((f) => f.manualReview);
    if (manualReview === 'false') findings = findings.filter((f) => !f.manualReview);

    res.json(rewriteFindingShots(job.id, findings));
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
