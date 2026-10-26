import { json, service, book } from './_lib.js';

// Called only after the customer clicks Confirm in agentready.js. Everything here is untrusted input.
// ponytail: no rate limit yet; add a Vercel Firewall rate-limit rule on /api/book before sharing the URL widely
export async function POST(request) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'invalid_json' }, 400);
  const { service_id, start, name, email } = body;
  const svc = service(service_id);
  const t = Date.parse(start);
  if (!svc) return json({ error: 'unknown_service' }, 400);
  if (typeof start !== 'string' || Number.isNaN(t) || t < Date.now()) return json({ error: 'invalid_start', next_action: 'Call check_availability and pick a future time.' }, 400);
  if (typeof name !== 'string' || !name.trim() || name.length > 80) return json({ error: 'invalid_name' }, 400);
  if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'invalid_email' }, 400);
  try {
    const b = await book(svc, new Date(t).toISOString(), { name: name.trim(), email });
    return json({ ...b, service: svc.name, price: svc.price, currency: svc.currency });
  } catch (e) {
    return json({ error: e.message, next_action: 'Call check_availability again and offer another time.' }, e.status === 409 || e.status === 400 ? 409 : 502);
  }
}
