import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createJob, cleanupOldOutputs } from '../src/server/jobManager.js';

/**
 * cleanupOldOutputs() is the enforcement mechanism behind the
 * DASHBOARD_RETENTION_DAYS/DASHBOARD_RETENTION_MAX_JOBS limits (see README
 * "Hosting this safely") — src/server/index.js runs it on startup and every
 * 6 hours. These tests exercise it directly against a sandboxed output/
 * directory rather than waiting on that schedule.
 */
async function withSandboxedCwd(t) {
  const originalCwd = process.cwd();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-retention-test-'));
  process.chdir(tmpDir);
  const outputDir = path.join(tmpDir, 'output');
  await fs.mkdir(outputDir, { recursive: true });
  t.after(async () => {
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });
  return outputDir;
}

async function makeAgedDir(outputDir, name, ageMs) {
  const dir = path.join(outputDir, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'summary.json'), '{}');
  const when = new Date(Date.now() - ageMs);
  await fs.utimes(dir, when, when);
}

test('cleanupOldOutputs deletes directories older than maxAgeMs and keeps recent ones', async (t) => {
  const outputDir = await withSandboxedCwd(t);
  await makeAgedDir(outputDir, 'ancient-run', 30 * 86_400_000);
  await makeAgedDir(outputDir, 'recent-run', 60_000);

  const { deleted } = await cleanupOldOutputs({ maxAgeMs: 14 * 86_400_000, maxJobs: 1000 });

  assert.deepEqual(deleted, ['ancient-run']);
  await assert.rejects(fs.stat(path.join(outputDir, 'ancient-run')));
  await assert.doesNotReject(fs.stat(path.join(outputDir, 'recent-run')));
});

test('cleanupOldOutputs enforces maxJobs by deleting the oldest beyond the cap, even if not aged out', async (t) => {
  const outputDir = await withSandboxedCwd(t);
  await makeAgedDir(outputDir, 'run-a', 3000);
  await makeAgedDir(outputDir, 'run-b', 2000);
  await makeAgedDir(outputDir, 'run-c', 1000);

  const { deleted } = await cleanupOldOutputs({ maxAgeMs: 999_999_999_999, maxJobs: 2 });

  assert.deepEqual(deleted, ['run-a']); // oldest mtime, beyond the top-2 cap
  await assert.doesNotReject(fs.stat(path.join(outputDir, 'run-b')));
  await assert.doesNotReject(fs.stat(path.join(outputDir, 'run-c')));
});

test('cleanupOldOutputs never deletes a pending or running job, no matter how old its directory is', async (t) => {
  const outputDir = await withSandboxedCwd(t);

  const activeJob = createJob({ siteName: 'Still Running', urls: ['https://example.com/'] });
  activeJob.status = 'running';
  await makeAgedDir(outputDir, activeJob.id, 30 * 86_400_000);
  await makeAgedDir(outputDir, 'finished-old-run', 30 * 86_400_000);

  const { deleted } = await cleanupOldOutputs({ maxAgeMs: 14 * 86_400_000, maxJobs: 1000 });

  assert.deepEqual(deleted, ['finished-old-run']);
  await assert.doesNotReject(fs.stat(path.join(outputDir, activeJob.id)));
});
