// POST {url} → NDJSON stream: log lines, one event per page read (with screenshot), then the draft config.
// Needs Chrome (Playwright), so it runs on the long-lived app server, not a serverless function.
import { generate } from '../agent/generate.mjs';
import { ndjson } from './_lib.js';

export async function POST(request) {
  const { url } = await request.json().catch(() => ({}));
  if (!/^https?:\/\//.test(url ?? '')) return Response.json({ error: 'url must start with http(s)://' }, { status: 400 });
  return ndjson(async (send) => {
    const draft = await generate(url, { log: (text) => send({ type: 'log', text }), onPage: (p) => send({ type: 'page', url: p.url, thumb: `data:image/jpeg;base64,${p.shot}` }) });
    send({ type: 'draft', draft });
  });
}
