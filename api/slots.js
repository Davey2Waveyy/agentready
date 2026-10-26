import { json, service, slots, MOCK } from './_lib.js';

export async function GET(request) {
  const q = new URL(request.url).searchParams;
  const svc = service(q.get('service'));
  const date = q.get('date') ?? '';
  if (!svc) return json({ error: 'unknown_service' }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return json({ error: 'date must be YYYY-MM-DD' }, 400);
  try {
    return json({ service: svc.id, date, slots: await slots(svc, date), ...(MOCK && { mock: true }) });
  } catch (e) {
    return json({ error: e.message }, 502);
  }
}
