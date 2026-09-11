// Zero-dependency server for e2e: serves the built PWA and proxies API calls
// to the Go backend, exactly like nginx does in docker-compose.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/dist');
const BACKEND = process.env.BACKEND_URL || 'http://127.0.0.1:8080';
const PORT = Number(process.env.PORT || 8090);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') {
    const backend = new URL(url.pathname + url.search, BACKEND);
    const proxyReq = http.request(backend, {
      method: req.method,
      headers: { ...req.headers, host: new URL(BACKEND).host }
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    });
    proxyReq.on('error', () => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'backend unavailable (offline simulation)' }));
    });
    req.pipe(proxyReq, { end: true });
    return;
  }
  try {
    let filePath = path.join(DIST, decodeURIComponent(url.pathname));
    if (!filePath.startsWith(DIST)) {
      res.writeHead(403); res.end(); return;
    }
    if (!existsSync(filePath) || url.pathname === '/') filePath = path.join(DIST, 'index.html');
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`e2e static server on http://127.0.0.1:${PORT} -> ${BACKEND}`);
});
