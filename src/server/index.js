#!/usr/bin/env node
import { createApp } from './app.js';
import { hydrateFromDisk, cleanupOldOutputs } from './jobManager.js';

const port = Number(process.env.PORT) || Number(process.argv[2]) || 3000;
const CLEANUP_INTERVAL_MS = 6 * 60 * 60_000; // every 6 hours

async function runCleanup() {
  const { deleted } = await cleanupOldOutputs();
  if (deleted.length) console.log(`Cleaned up ${deleted.length} old audit output(s): ${deleted.join(', ')}`);
}

await hydrateFromDisk();
await runCleanup();
setInterval(() => { runCleanup().catch((err) => console.error('Cleanup failed:', err)); }, CLEANUP_INTERVAL_MS).unref();

const app = createApp();
app.listen(port, () => {
  console.log(`Console Warrior dashboard listening on http://localhost:${port}`);
});
