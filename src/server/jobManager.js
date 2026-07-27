import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { auditSite } from '../engine/siteAudit.js';
import { buildSummary } from '../report/buildSummary.js';
import { renderHtmlReport } from '../report/html/render.js';
import { renderDocxReport } from '../report/docx/render.js';
import { extractFindings } from '../report/findings.js';
import { slugify, timestampSlug } from '../util/slug.js';

const OUTPUT_ROOT = path.join(process.cwd(), 'output');
const jobs = new Map();

function jobToJSON(job) {
  return {
    id: job.id,
    siteName: job.siteName,
    urls: job.urls,
    viewport: job.viewport,
    concurrency: job.concurrency,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    progress: {
      total: job.urls.length,
      // Prefer the actual results count once the run has finished (true for
      // both a live job and one hydrated from disk, whose event log is
      // always empty — see hydrateFromDisk) over counting log events, which
      // only reflects real-time progress while a job is still in memory.
      done: job.results ? job.results.length : job.log.filter((e) => e.type === 'page-done' || e.type === 'page-error').length,
      inFlight: [...job.inFlight],
    },
    // Tells the client whether GET .../events has real history to replay.
    // A job hydrated from disk after a server restart has no in-memory log
    // (see hydrateFromDisk) even though it's already finished — the client
    // needs to know that so it doesn't wait on a replay that will never come.
    hasLog: job.log.length > 0,
    summary: job.summary,
  };
}

/**
 * Persists just enough to rediscover a job's outputs after a server
 * restart — the actual report files (html/docx/json/screenshots) already
 * live under outDir regardless of this.
 */
async function persistManifest(job) {
  const manifest = jobToJSON(job);
  await fs.writeFile(path.join(job.outDir, 'job.json'), JSON.stringify(manifest, null, 2)).catch(() => {});
}

export function createJob({ siteName, urls, viewport, concurrency }) {
  const name = siteName || 'Accessibility Audit';
  const id = `${slugify(name)}-${timestampSlug()}`;
  const outDir = path.join(OUTPUT_ROOT, id);
  const job = {
    id,
    siteName: name,
    urls,
    viewport: viewport || null,
    concurrency: concurrency || 3,
    outDir,
    status: 'pending',
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    error: null,
    results: null,
    summary: null,
    inFlight: new Set(),
    log: [],
    emitter: new EventEmitter(),
    abortController: new AbortController(),
  };
  job.emitter.setMaxListeners(50);
  jobs.set(id, job);
  return job;
}

function emit(job, event) {
  const stamped = { ...event, timestamp: Date.now() };
  job.log.push(stamped);
  job.emitter.emit('event', stamped);
}

export async function runJob(job) {
  job.status = 'running';
  job.startedAt = Date.now();
  await fs.mkdir(job.outDir, { recursive: true });
  await persistManifest(job);
  emit(job, { type: 'status', status: 'running' });

  try {
    const results = await auditSite({
      urls: job.urls,
      outDir: job.outDir,
      viewport: job.viewport,
      concurrency: job.concurrency,
      signal: job.abortController.signal,
      onPageStart: (url) => {
        job.inFlight.add(url);
        emit(job, { type: 'page-start', url });
      },
      onPageDone: (r) => {
        job.inFlight.delete(r.url);
        if (r.error) emit(job, { type: 'page-error', url: r.url, error: r.error.split('\n')[0] });
        else emit(job, { type: 'page-done', url: r.url });
      },
    });

    job.results = results;
    const cancelled = job.abortController.signal.aborted;

    if (results.length) {
      job.summary = buildSummary(results);
      const report = {
        siteName: job.siteName,
        generatedAt: new Date().toISOString(),
        urls: job.urls,
        results,
        summary: job.summary,
      };
      await fs.writeFile(path.join(job.outDir, 'results.json'), JSON.stringify(results, null, 2));
      await fs.writeFile(path.join(job.outDir, 'summary.json'), JSON.stringify(job.summary, null, 2));
      await renderHtmlReport(report, path.join(job.outDir, 'report.html'));
      await renderDocxReport(report, path.join(job.outDir, 'report.docx'));
    }

    job.status = cancelled ? 'cancelled' : 'completed';
    job.finishedAt = Date.now();
    emit(job, { type: 'status', status: job.status });
    emit(job, { type: 'done', status: job.status });
  } catch (e) {
    job.status = 'error';
    job.error = String(e && e.stack ? e.stack : e);
    job.finishedAt = Date.now();
    emit(job, { type: 'status', status: 'error', error: job.error });
    emit(job, { type: 'done', status: 'error' });
  } finally {
    await persistManifest(job);
  }
}

export function startJob(job) {
  runJob(job).catch(() => {});
  return job;
}

export function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.status === 'pending' || job.status === 'running') {
    emit(job, { type: 'status', status: 'cancelling' });
    job.abortController.abort();
    return true;
  }
  return false;
}

export function getJob(id) {
  return jobs.get(id) || null;
}

export function listJobs() {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map(jobToJSON);
}

export function getJobFindings(id) {
  const job = jobs.get(id);
  if (!job || !job.results) return null;
  return extractFindings(job.results);
}

export { jobToJSON, OUTPUT_ROOT };

/**
 * Hydrates the in-memory registry from job.json manifests left on disk by a
 * previous process, so history survives a server restart. Jobs found
 * "running" at hydrate time are marked "interrupted" — the process that was
 * running them is gone.
 */
export async function hydrateFromDisk() {
  let entries;
  try {
    entries = await fs.readdir(OUTPUT_ROOT, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const outDir = path.join(OUTPUT_ROOT, entry.name);
    const manifestPath = path.join(outDir, 'job.json');
    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    } catch {
      continue;
    }
    if (jobs.has(manifest.id)) continue;
    const job = {
      id: manifest.id,
      siteName: manifest.siteName,
      urls: manifest.urls,
      viewport: manifest.viewport,
      concurrency: manifest.concurrency,
      outDir,
      status: manifest.status === 'running' || manifest.status === 'pending' ? 'interrupted' : manifest.status,
      createdAt: manifest.createdAt,
      startedAt: manifest.startedAt,
      finishedAt: manifest.finishedAt,
      error: manifest.error,
      results: null,
      summary: manifest.summary,
      inFlight: new Set(),
      log: [],
      emitter: new EventEmitter(),
      abortController: new AbortController(),
    };
    job.emitter.setMaxListeners(50);
    try {
      job.results = JSON.parse(await fs.readFile(path.join(outDir, 'results.json'), 'utf8'));
    } catch {
      // no results persisted (job never got far enough) — fine, downloads for it just won't be available
    }
    jobs.set(job.id, job);
  }
}
