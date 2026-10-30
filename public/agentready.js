// AgentReady: exposes a small business's hours, services, menu and booking to AI agents via WebMCP.
// On any site:   <script src="https://AGENTREADY-HOST/agentready.js" data-site="id" defer></script>  (config + API from the AgentReady host)
// Self-hosted:    <script src="/agentready.js" data-config="agentready.json" data-api="/api" defer></script>
(() => {
  const script = document.currentScript;
  const fromHost = script && new URL(script.src, location.href).origin !== location.origin;
  const api = script?.dataset.api || (fromHost ? new URL('/api', script.src).href : '/api');
  const configUrl = script?.dataset.site && !script.dataset.config
    ? new URL(`${api}/config?site=${encodeURIComponent(script.dataset.site)}`, location.href)
    : new URL(script?.dataset.config || 'agentready.json', location.href);
  // Which business the API should load: data-site, else the folder the config sits in (/salon/agentready.json → salon).
  const site = script?.dataset.site || configUrl.pathname.split('/').at(-2) || '';
  const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

  // Date parts of `when` in the business's timezone, so "open now" is right wherever the agent runs.
  function local(when, timeZone) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(when).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, day: p.weekday.slice(0, 3).toLowerCase(), hm: `${p.hour}:${p.minute}` };
  }

  function fmt(iso, timeZone) {
    return new Date(iso).toLocaleString('en-CA', { timeZone, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function businessInfo(c) {
    const now = local(new Date(), c.timezone);
    const today = c.hours[now.day];
    const open = !!today && now.hm >= today[0] && now.hm < today[1];
    return {
      name: c.name, description: c.description, phone: c.phone, address: c.address, timezone: c.timezone,
      hours: Object.fromEntries(DAYS.map((d) => [d, c.hours[d] ? `${c.hours[d][0]}-${c.hours[d][1]}` : 'closed'])),
      open_now: open,
      local_time: `${now.date} ${now.hm} (${now.day})`,
    };
  }

  async function post(path, body) {
    const res = await fetch(api + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ site, ...body }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { data });
    return data;
  }

  // The write gate: a human must click Confirm on the page. The agent never gets a way around it.
  function confirmWithHuman(summary, what = 'appointment') {
    const dialog = document.createElement('dialog');
    dialog.className = 'agentready-confirm';
    dialog.innerHTML = `
      <style>
        .agentready-confirm{border:0;border-radius:16px;padding:0;max-width:min(420px,calc(100vw - 32px));font:15px/1.45 system-ui,sans-serif;color:#1a1714;box-shadow:0 24px 80px rgba(0,0,0,.35)}
        .agentready-confirm::backdrop{background:rgba(10,8,6,.55);backdrop-filter:blur(3px)}
        .agentready-confirm form{padding:24px}
        .agentready-confirm .ar-tag{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8a6d3b;margin:0 0 6px}
        .agentready-confirm h2{font-size:20px;margin:0 0 16px}
        .agentready-confirm dl{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:0 0 20px}
        .agentready-confirm dt{color:#6b625a}.agentready-confirm dd{margin:0;font-weight:600}
        .agentready-confirm .ar-row{display:flex;gap:10px;justify-content:flex-end}
        .agentready-confirm button{font:inherit;border-radius:999px;padding:10px 18px;cursor:pointer;border:1px solid #d6cfc6;background:#fff}
        .agentready-confirm button[value=yes]{background:#1a1714;color:#fff;border-color:#1a1714}
      </style>
      <form method="dialog">
        <p class="ar-tag">An AI assistant wants to book for you</p>
        <h2>Confirm this ${what}?</h2>
        <dl></dl>
        <div class="ar-row"><button value="no">Cancel</button><button value="yes" autofocus>Confirm booking</button></div>
      </form>`;
    const dl = dialog.querySelector('dl');
    for (const [k, v] of Object.entries(summary)) {
      dl.append(Object.assign(document.createElement('dt'), { textContent: k }), Object.assign(document.createElement('dd'), { textContent: v }));
    }
    document.body.append(dialog);
    dialog.showModal();
    return new Promise((resolve) => {
      // ponytail: 2 min auto-cancel; Ray-Ban Display caps tool calls at 10 s, needs async confirm if we target it
      const timer = setTimeout(() => dialog.close('timeout'), 120_000);
      dialog.addEventListener('close', () => { clearTimeout(timer); dialog.remove(); resolve(dialog.returnValue || 'no'); }, { once: true });
    });
  }

  function tools(c) {
    const service = (id) => c.services.find((s) => s.id === id);
    const serviceIds = c.services.map((s) => s.id).join(', ');
    // A restaurant table (kind "table") is booked for a party; the server checks the size too.
    const partyError = (s, n) => s.kind !== 'table' ? null
      : !Number.isInteger(n) || n < 1 ? { error: 'party_size_required', next_action: 'Ask how many people, then pass party_size.' }
      : s.maxParty && n > s.maxParty ? { error: 'party_too_large', next_action: `Online booking takes up to ${s.maxParty} people. Ask the customer to call ${c.phone || c.name}.` }
      : null;
    // Booked on another platform (OpenTable, Squire, Fresha…) or only by phone: hand the customer over, never fake a booking.
    // Same rule as bookingVia in api/_lib.js.
    const link = c.booking?.provider !== 'calcom' && /^https?:\/\/[^/\s]/i.test(c.booking?.url ?? '') && c.booking.url;
    const elsewhere = c.booking?.provider !== 'calcom' && {
      booked: false, ...(link ? { book_at: link } : { phone: c.phone ?? null }),
      next_action: link ? `Nothing was booked: ${c.name} takes bookings at ${link}. Give the customer this link to pick a time and book.`
        : `Nothing was booked: ${c.name} doesn't take bookings online. ${c.phone ? `Ask the customer to call ${c.phone}.` : 'Ask the customer to contact the business directly.'}`,
    };
    const menu = c.menu?.length ? [{
      name: 'get_menu',
      description: `Menu items at ${c.name} with prices. Read only: these are not bookable.`,
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      execute: async () => ({ menu: c.menu.map(({ name, section, price, currency }) => ({ name, section, price, currency })) }),
    }] : [];
    return [
      {
        name: 'get_business_info',
        description: `Hours, open-now status, address and phone for ${c.name}.`,
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
        execute: async () => businessInfo(c),
      },
      {
        name: 'get_services',
        description: `Services offered by ${c.name} with duration and price. Use the id with check_availability and book_appointment.`,
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
        execute: async () => ({ services: c.services.map(({ id, name, minutes, price, currency, kind, maxParty }) =>
          ({ id, name, minutes, price, currency, ...(kind === 'table' && { table_reservation: true, max_party: maxParty ?? null }) })) }),
      },
      ...menu,
      {
        name: 'check_availability',
        description: elsewhere ? `${c.name} doesn't show open times here: this returns where the customer books instead. Service ids: ${serviceIds}.`
          : `Open appointment times for a service on one date (business timezone ${c.timezone}). Service ids: ${serviceIds}.`,
        inputSchema: {
          type: 'object',
          properties: {
            service_id: { type: 'string', description: `One of: ${serviceIds}` },
            date: { type: 'string', description: 'YYYY-MM-DD in the business timezone' },
            party_size: { type: 'integer', description: 'Number of people, for table reservations' },
          },
          required: ['service_id', 'date'],
        },
        annotations: { readOnlyHint: true },
        async execute({ service_id, date, party_size }) {
          if (elsewhere) return elsewhere;
          const s = service(service_id);
          if (!s) return { error: 'unknown_service', next_action: `Use one of: ${serviceIds}` };
          if (party_size !== undefined && partyError(s, party_size)) return partyError(s, party_size);
          const res = await fetch(`${api}/slots?${new URLSearchParams({ site, service: service_id, date })}`);
          const data = await res.json();
          if (!res.ok) return { error: data.error, next_action: 'Fix the input and try again.' };
          return { ...data, next_action: data.slots.length ? 'Offer these times; pass the chosen start to book_appointment.' : 'No times that day; try another date.' };
        },
      },
      {
        name: 'book_appointment',
        description: elsewhere ? `${c.name} takes bookings ${link ? 'on its own booking page' : 'by phone'}: this returns the ${link ? 'link' : 'number'} to give the customer. Nothing is booked here.`
          : 'Book an appointment or table. Opens a confirmation dialog the customer must approve on the page; nothing is booked until they click Confirm. Use a start value returned by check_availability.',
        inputSchema: {
          type: 'object',
          properties: {
            service_id: { type: 'string', description: `One of: ${serviceIds}` },
            start: { type: 'string', description: 'ISO 8601 start time exactly as returned by check_availability' },
            name: { type: 'string', description: "Customer's full name" },
            email: { type: 'string', description: "Customer's email for the confirmation" },
            party_size: { type: 'integer', description: 'Number of people (required for table reservations)' },
          },
          required: ['service_id', 'start', 'name', 'email'],
        },
        annotations: { readOnlyHint: false },
        async execute({ service_id, start, name, email, party_size }) {
          if (elsewhere) return elsewhere;
          const s = service(service_id);
          if (!s) return { error: 'unknown_service', next_action: `Use one of: ${serviceIds}` };
          if (partyError(s, party_size)) return partyError(s, party_size);
          if (Number.isNaN(Date.parse(start))) return { error: 'invalid_start', next_action: 'Call check_availability and use one of its start values.' };
          const table = s.kind === 'table';
          const answer = await confirmWithHuman({
            ...(table ? { Table: `Party of ${party_size}` } : { Service: `${s.name} · ${s.minutes} min` }),
            ...(s.price > 0 && { Price: `$${s.price} ${s.currency}` }),
            When: fmt(start, c.timezone), Name: String(name), Email: String(email), At: c.name,
          }, table ? 'reservation' : 'appointment');
          if (answer !== 'yes') return { booked: false, reason: answer === 'timeout' ? 'no_response' : 'declined_by_customer', next_action: 'Tell the customer nothing was booked. Do not retry unless they ask.' };
          try {
            const b = await post('/book', { service_id, start, name, email, ...(table && { party_size }) });
            return { booked: true, ...b, next_action: b.mock ? 'Tell the customer it is booked (test mode: no email is sent).' : 'Tell the customer it is booked and a confirmation email is on its way.' };
          } catch (e) {
            return { booked: false, error: e.message, next_action: e.data?.next_action || 'Apologize and offer another time.' };
          }
        },
      },
    ];
  }

  const ready = fetch(configUrl).then((r) => r.json()).then(async (config) => {
    const list = tools(config);
    const mc = document.modelContext ?? navigator.modelContext;
    if (mc) for (const t of list) await mc.registerTool(t);
    return { config, tools: list, webmcp: !!mc };
  });
  // For the page's own UI and console testing: (await AgentReady.ready).tools
  window.AgentReady = { ready };
  ready.catch((e) => console.error('[AgentReady]', e));
})();
