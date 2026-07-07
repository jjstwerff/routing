// Minimal static file server for the browser shell — serves the repo root so /browser/* and the
// test-set under /lib/* are both reachable, with the correct application/wasm MIME (jco loads the
// core module via WebAssembly.compileStreaming, which requires it). Dev/test only.
//   node browser/serve.mjs [port]   (default 8099); root = repo root (this file's parent's parent)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));   // repo root
const port = Number(process.argv[2] || 8099);
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.wasm': 'application/wasm', '.json': 'application/json', '.css': 'text/css',
  '.map': 'application/json', '.ts': 'text/plain',
};

createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    let rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
    if (rel === '/') rel = '/browser/index.html';       // root → the app
    else if (rel.endsWith('/')) rel += 'index.html';    // any dir URL → its index.html
    const file = join(root, rel);
    if (!file.startsWith(root)) { res.writeHead(403).end('forbidden'); return; }
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`serving ${root} at http://127.0.0.1:${port}/browser/`));
