// Shared by the API routes. Files starting with _ are not deployed as routes on Vercel.
// ponytail: demo sites are bundled JSON; a real multi-business deploy loads configs from a database by site id
import barbershop from '../public/barbershop/agentready.json' with { type: 'json' };
import salon from '../public/salon/agentready.json' with { type: 'json' };
import { readFileSync } from 'node:fs';

const SITES = { barbershop, salon };
// AGENTREADY_CONFIG: a generated draft under verification (local gauntlet only; dev.mjs serves the same file)
const draft = process.env.AGENTREADY_CONFIG && JSON.parse(readFileSync(process.env.AGENTREADY_CONFIG, 'utf8'));
export const siteConfig = (id) => draft || SITES[id || 'barbershop'] || null;

// Fake slots + bookings (flagged mock:true) with no Cal.com username, or AGENTREADY_MOCK=1 (tests: never book for real)
export const isMock = (config) => process.env.AGENTREADY_MOCK === '1' || !config.booking?.username;
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

const mockBooked = new Set(); // `${business}|${ms}`. ponytail: per-instance memory, mock only

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
      if (h && l.hm >= h[0] && end.hm <= h[1] && end.date === l.date && t > Date.now() && !mockBooked.has(`${config.name}|${t}`)) starts.push(new Date(t).toISOString());
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
    const t = Date.parse(start), key = `${config.name}|${t}`;
    if (mockBooked.has(key)) throw Object.assign(new Error('That time was just taken.'), { status: 409 });
    mockBooked.add(key);
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
