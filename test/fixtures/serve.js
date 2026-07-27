import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Starts the fixture server and resolves once it's listening. Callers own shutdown via server.close(). */
export function startFixtureServer(port = 8973) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(__dirname, 'sample-page.html')));
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = process.argv[2] ? parseInt(process.argv[2], 10) : 8973;
  startFixtureServer(port).then((server) => {
    console.log(`fixture server on http://127.0.0.1:${server.address().port}`);
  });
}
