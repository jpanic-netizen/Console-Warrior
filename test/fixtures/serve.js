import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = process.argv[2] ? parseInt(process.argv[2], 10) : 8973;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(path.join(__dirname, 'sample-page.html')));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`fixture server on http://127.0.0.1:${port}`);
});
