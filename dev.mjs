// Local stand-in for Vercel: static files from public/, /api/<name> → api/<name>.js GET/POST exports.
// ponytail: `vercel dev` does the same once the project is linked; this avoids needing a login to start
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = process.env.PORT || 3100;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.txt': 'text/plain' };

export const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const api = url.pathname.match(/^\/api\/([a-z-]+)$/);
  if (api) {
    // Open to every origin: agentready.js runs on the owner's own site and calls this API from there.
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
    const handler = (await import(`./api/${api[1]}.js`).catch(() => ({})))[req.method];
    if (!handler) return res.writeHead(404).end();
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
    const out = await handler(new Request(url, { method: req.method, headers: req.headers, body }));
    res.writeHead(out.status, { ...Object.fromEntries(out.headers), ...cors });
    if (out.body) for await (const chunk of out.body) res.write(chunk); // streams (NDJSON) pass through as they come
    return res.end();
  }
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  if (path.endsWith('/')) path += 'index.html';
  try {
    const file = await readFile(join('public', path));
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' }).end(file);
  } catch {
    res.writeHead(404).end('Not found');
  }
});

if (import.meta.url === pathToFileURL(process.argv[1]).href) server.listen(PORT, () => console.log(`http://localhost:${PORT}/`));
