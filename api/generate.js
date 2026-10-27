// POST {url} → {job}. Follow it at /api/job: log lines, one event per page read (with screenshot), then the draft config.
// Drives Chrome (Playwright), so it runs on the long-lived app server, not a serverless function.
import { generate } from '../agent/generate.mjs';
import { json, startJob, runningJobs, targetUrl } from './_lib.js';

export async function POST(request) {
  const { url } = await request.json().catch(() => ({}));
  const target = targetUrl(request, url ?? '');
  if (!target) return json({ error: 'Enter a public http(s) URL.' }, 400);
  if (runningJobs() >= 3) return json({ error: 'Busy reading other sites. Try again in a minute.' }, 429); // ponytail: global cap, per-IP limits if abused
  return json({ job: startJob(async (send) => {
    const draft = await generate(target, { log: (text) => send({ type: 'log', text }), onPage: (p) => send({ type: 'page', url: p.url, thumb: `data:image/jpeg;base64,${p.shot}` }) });
    send({ type: 'draft', draft: { ...draft, url } }); // the URL the owner typed, not our internal one
  }) });
}
