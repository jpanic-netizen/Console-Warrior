#!/usr/bin/env node
import { createApp } from './app.js';
import { hydrateFromDisk } from './jobManager.js';

const port = Number(process.env.PORT) || Number(process.argv[2]) || 3000;

await hydrateFromDisk();
const app = createApp();
app.listen(port, () => {
  console.log(`Console Warrior dashboard listening on http://localhost:${port}`);
});
