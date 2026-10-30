import { json, siteConfig, slots, isMock } from './_lib.js';

export async function GET(request) {
  const q = new URL(request.url).searchParams;
  const config = siteConfig(q.get('site'));
  if (!config) return json({ error: 'unknown_site' }, 404);
  const svc = config.services.find((s) => s.id === q.get('service'));
  const date = q.get('date') ?? '';
  if (!svc) return json({ error: 'unknown_service' }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return json({ error: 'date must be YYYY-MM-DD' }, 400);
  try {
    return json({ service: svc.id, date, slots: await slots(config, svc, date), ...(isMock(config) && { mock: true }) });
  } catch (e) {
    return e.status === 409 ? json({ error: e.message, next_action: e.next_action }, 409) : json({ error: e.message }, 502);
  }
}
