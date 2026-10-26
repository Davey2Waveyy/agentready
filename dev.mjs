// Local stand-in for Vercel: static files from public/, /api/<name> → api/<name>.js GET/POST exports.
// ponytail: `vercel dev` does the same once the project is linked; this avoids needing a login to start
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const PORT = process.env.PORT || 3100;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain' };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const api = url.pathname.match(/^\/api\/([a-z-]+)$/);
  if (api) {
    const handler = (await import(`./api/${api[1]}.js`).catch(() => ({})))[req.method];
    if (!handler) return res.writeHead(404).end();
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
    const out = await handler(new Request(url, { method: req.method, headers: req.headers, body }));
    res.writeHead(out.status, Object.fromEntries(out.headers)).end(Buffer.from(await out.arrayBuffer()));
    return;
  }
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  if (path.endsWith('/')) path += 'index.html';
  try {
    const file = await readFile(join('public', path));
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' }).end(file);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}/barbershop/`));
