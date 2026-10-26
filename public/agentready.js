// AgentReady: exposes a small business's hours, services and booking to AI agents via WebMCP.
// <script src="/agentready.js" data-config="agentready.json" data-api="/api" defer></script>
(() => {
  const script = document.currentScript;
  const configUrl = new URL(script?.dataset.config || 'agentready.json', location.href);
  const api = script?.dataset.api || '/api';
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
    const res = await fetch(api + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { data });
    return data;
  }

  // The write gate: a human must click Confirm on the page. The agent never gets a way around it.
  function confirmWithHuman(summary) {
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
        <h2>Confirm this appointment?</h2>
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
        execute: async () => ({ services: c.services.map(({ id, name, minutes, price, currency }) => ({ id, name, minutes, price, currency })) }),
      },
      {
        name: 'check_availability',
        description: `Open appointment times for a service on one date (business timezone ${c.timezone}). Service ids: ${serviceIds}.`,
        inputSchema: {
          type: 'object',
          properties: {
            service_id: { type: 'string', description: `One of: ${serviceIds}` },
            date: { type: 'string', description: 'YYYY-MM-DD in the business timezone' },
          },
          required: ['service_id', 'date'],
        },
        annotations: { readOnlyHint: true },
        async execute({ service_id, date }) {
          if (!service(service_id)) return { error: 'unknown_service', next_action: `Use one of: ${serviceIds}` };
          const res = await fetch(`${api}/slots?${new URLSearchParams({ service: service_id, date })}`);
          const data = await res.json();
          if (!res.ok) return { error: data.error, next_action: 'Fix the input and try again.' };
          return { ...data, next_action: data.slots.length ? 'Offer these times; pass the chosen start to book_appointment.' : 'No times that day; try another date.' };
        },
      },
      {
        name: 'book_appointment',
        description: 'Book an appointment. Opens a confirmation dialog the customer must approve on the page; nothing is booked until they click Confirm. Use a start value returned by check_availability.',
        inputSchema: {
          type: 'object',
          properties: {
            service_id: { type: 'string', description: `One of: ${serviceIds}` },
            start: { type: 'string', description: 'ISO 8601 start time exactly as returned by check_availability' },
            name: { type: 'string', description: "Customer's full name" },
            email: { type: 'string', description: "Customer's email for the confirmation" },
          },
          required: ['service_id', 'start', 'name', 'email'],
        },
        annotations: { readOnlyHint: false },
        async execute({ service_id, start, name, email }) {
          const s = service(service_id);
          if (!s) return { error: 'unknown_service', next_action: `Use one of: ${serviceIds}` };
          if (Number.isNaN(Date.parse(start))) return { error: 'invalid_start', next_action: 'Call check_availability and use one of its start values.' };
          const answer = await confirmWithHuman({
            Service: `${s.name} · ${s.minutes} min`, Price: `$${s.price} ${s.currency}`,
            When: fmt(start, c.timezone), Name: String(name), Email: String(email), At: c.name,
          });
          if (answer !== 'yes') return { booked: false, reason: answer === 'timeout' ? 'no_response' : 'declined_by_customer', next_action: 'Tell the customer nothing was booked. Do not retry unless they ask.' };
          try {
            const b = await post('/book', { service_id, start, name, email });
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
