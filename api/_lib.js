// Shared by the API routes. Files starting with _ are not deployed as routes on Vercel.
// ponytail: demo sites are bundled JSON; a real multi-business deploy loads configs from a database by site id
import barbershop from '../public/barbershop/agentready.json' with { type: 'json' };
import salon from '../public/salon/agentready.json' with { type: 'json' };
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const SITES = { barbershop, salon };
// Generated configs (drafts, then installs) by id. Saved under AGENTREADY_DATA when set (a volume on the host), else memory only.
const DATA = process.env.AGENTREADY_DATA;
const saved = new Map();
export function addSite(config) {
  const id = `s-${crypto.randomUUID().slice(0, 8)}`;
  saved.set(id, config);
  if (DATA) { mkdirSync(`${DATA}/sites`, { recursive: true }); writeFileSync(`${DATA}/sites/${id}.json`, JSON.stringify(config)); }
  return id;
}
export function siteConfig(id) {
  id ||= 'barbershop';
  if (SITES[id]) return SITES[id];
  if (!saved.has(id) && DATA && /^s-[0-9a-f]{8}$/.test(id)) { // id pattern: never a path
    try { saved.set(id, JSON.parse(readFileSync(`${DATA}/sites/${id}.json`, 'utf8'))); } catch {}
  }
  return saved.get(id) ?? null;
}

// Configs under verification always book in mock mode, whatever their booking settings.
export const verifying = new Set();
// Fake slots + bookings (flagged mock:true): no Cal.com username, under verification, or AGENTREADY_MOCK=1 (tests)
export const isMock = (config) => process.env.AGENTREADY_MOCK === '1' || !config.booking?.username || verifying.has(config);

// ---- background jobs: generate/verify outlive one HTTP request (Modal cuts requests at 150 s) ----
const jobs = new Map();
export const runningJobs = () => [...jobs.values()].filter((j) => !j.done).length;
export function startJob(work) {
  const id = crypto.randomUUID(), job = { events: [], done: false, wake: () => {} };
  jobs.set(id, job);
  const send = (ev) => { job.events.push(ev); job.wake(); };
  work(send).catch((e) => send({ type: 'error', message: e.message })).finally(() => {
    job.done = true;
    send({ type: 'end' });
    setTimeout(() => jobs.delete(id), 3600e3);
  });
  return id;
}
// NDJSON of a job's events from index `from`, following live ones. Ends after maxMs; the client reconnects with from=<events seen>.
export function followJob(id, from = 0, maxMs = 100_000) {
  const job = jobs.get(id);
  if (!job) return json({ error: 'unknown_job' }, 404);
  const enc = new TextEncoder(), t0 = Date.now();
  const body = new ReadableStream({
    async start(ctl) {
      let i = from;
      for (;;) {
        while (i < job.events.length) ctl.enqueue(enc.encode(JSON.stringify(job.events[i++]) + '\n'));
        if (job.done || Date.now() - t0 > maxMs) break;
        await new Promise((r) => { job.wake = r; setTimeout(r, 15_000); }); // wake on new events; heartbeat-ish timeout
      }
      ctl.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } });
}

// The URL the visitor used to reach us (not the internal one dev.mjs builds), and whether it's this machine.
export const visitorOrigin = (request) => `${request.headers.get('x-forwarded-proto') || 'http'}://${request.headers.get('host')}`;
const PRIVATE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$|.*\.internal$)/;
// Hosted: only public URLs (ponytail: hostname check, no DNS resolution). Our own pages map to the local server, skipping the public proxy.
export function targetUrl(request, raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const visitor = new URL(visitorOrigin(request));
  if (u.host === visitor.host) return new URL(u.pathname + u.search, `http://localhost:${process.env.PORT || 3100}`).href;
  if (PRIVATE.test(u.hostname) && !PRIVATE.test(visitor.hostname)) return null;
  return u.href;
}

const CAL = 'https://api.cal.com/v2';

export const json = (body, status = 200) => Response.json(body, { status });

export function local(when, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(when).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, day: p.weekday.slice(0, 3).toLowerCase(), hm: `${p.hour}:${p.minute}` };
}

// Cal.com versions each endpoint separately: slots 404s on 2024-08-13, bookings uses it.
async function cal(path, init = {}, version = '2024-08-13') {
  const res = await fetch(CAL + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'cal-api-version': version,
      ...(process.env.CAL_API_KEY && { authorization: `Bearer ${process.env.CAL_API_KEY}` }),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error?.message || data.message || `Cal.com ${res.status}`), { status: res.status });
  return data.data;
}

const mockBooked = new WeakMap(); // config → Set of booked ms. ponytail: per-instance memory, mock only
const booked = (config) => mockBooked.get(config) ?? mockBooked.set(config, new Set()).get(config);

// Slots for one local date. Query a UTC window around it, keep what falls on that date locally (no offset math).
export async function slots(config, svc, date) {
  const tz = config.timezone;
  const from = new Date(`${date}T00:00:00Z`).getTime() - 864e5;
  const to = from + 3 * 864e5;
  let starts;
  if (isMock(config)) {
    starts = [];
    for (let t = from; t < to; t += 30 * 6e4) {
      const l = local(t, tz), end = local(t + svc.minutes * 6e4, tz), h = config.hours[l.day];
      if (h && l.hm >= h[0] && end.hm <= h[1] && end.date === l.date && t > Date.now() && !booked(config).has(t)) starts.push(new Date(t).toISOString());
    }
  } else {
    const data = await cal(`/slots?${new URLSearchParams({
      username: config.booking.username, eventTypeSlug: svc.calEventSlug,
      start: new Date(from).toISOString(), end: new Date(to).toISOString(),
    })}`, {}, '2024-09-04');
    starts = Object.values(data).flat().map((s) => s.start); // { "YYYY-MM-DD": [{ start }] }
  }
  const label = (iso) => new Date(iso).toLocaleTimeString('en-CA', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  return starts.filter((s) => local(new Date(s), tz).date === date).map((start) => ({ start, label: label(start) }));
}

export async function book(config, svc, start, attendee) {
  if (isMock(config)) {
    const t = Date.parse(start);
    if (booked(config).has(t)) throw Object.assign(new Error('That time was just taken.'), { status: 409 });
    // Only a time check_availability would offer: open hours, on the half hour, fits before close (Cal.com enforces this itself).
    const open = await slots(config, svc, local(t, config.timezone).date);
    if (!open.some((s) => Date.parse(s.start) === t)) throw Object.assign(new Error('That time is not available.'), { status: 409 });
    booked(config).add(t);
    return { uid: `mock-${t.toString(36)}`, start, mock: true };
  }
  const b = await cal('/bookings', {
    method: 'POST',
    body: JSON.stringify({
      username: config.booking.username, eventTypeSlug: svc.calEventSlug, start,
      attendee: { ...attendee, timeZone: config.timezone },
    }),
  });
  return { uid: b.uid, start: b.start ?? start };
}
