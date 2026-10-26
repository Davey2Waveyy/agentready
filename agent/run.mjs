// AgentReady demo agent: Muse Spark drives a real Chrome tab through the site's WebMCP tools.
// npm run agent -- http://localhost:3100/barbershop/
// The browser is visible on purpose: bookings need a human click on the page's confirm dialog.
import { chromium } from 'playwright';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

// Which model drives the agent. The gauntlet passes its own per skeptic.
export const DEFAULT_LLM = {
  baseUrl: process.env.AGENT_BASE_URL || 'https://api.meta.ai/v1',
  model: process.env.AGENT_MODEL || 'muse-spark-1.3',
  apiKey: process.env.AGENT_API_KEY || process.env.MODEL_API_KEY,
};

// Tools register after agentready.js loads its config; wait until some exist.
// NOTE: page.waitForFunction can't do this — it never awaits async predicates
// (a Promise is truthy, so it returns on the first poll). Poll via evaluate.
export async function waitForTools(page, timeoutMs = 15_000) {
  const t0 = Date.now();
  for (;;) {
    const n = await page.evaluate(async () => (await document.modelContext?.getTools())?.length || 0).catch(() => 0);
    if (n > 0) return;
    if (Date.now() - t0 > timeoutMs) throw new Error('timed out waiting for WebMCP tools');
    await new Promise((r) => setTimeout(r, 200));
  }
}

export async function openSite(url, { headless = false } = {}) {
  const browser = await chromium.launch({ channel: 'chrome', headless, args: ['--enable-features=WebMCPTesting'] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  await page.goto(url);
  await waitForTools(page);
  return { browser, page, tools: await listTools(page) };
}

export const listTools = (page) => page.evaluate(async () =>
  (await document.modelContext.getTools()).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })));

// Chrome 155 takes (RegisteredTool, inputObject) and resolves to a JSON string.
const callTool = (page, name, args) => page.evaluate(async ({ name, args }) => {
  const tool = (await document.modelContext.getTools()).find((t) => t.name === name);
  if (!tool) return JSON.stringify({ error: `no tool named ${name}` });
  try { return await document.modelContext.executeTool(tool, args); } catch (e) { return JSON.stringify({ error: e.message }); }
}, { name, args });

async function complete(messages, tools, { baseUrl, model, apiKey }) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model, messages,
      tools: tools.map(({ name, description, inputSchema }) => ({ type: 'function', function: { name, description, parameters: inputSchema } })),
    }),
  });
  if (!res.ok) throw new Error(`${model} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).choices[0].message;
}

export function systemPrompt(url) {
  return `You are the user's personal AI assistant. You are on the website ${url} and can only act through its tools.
Today is ${new Date().toDateString()} (user's local time). Resolve dates like "tomorrow" yourself.
Use the tools for facts; never guess hours, prices or availability. Before booking you need the service, an exact start from check_availability, and the user's name and email; ask for anything missing.
book_appointment asks the user to confirm on the page. Only say an appointment is booked if the tool result has booked: true. Keep replies short.`;
}

// One user turn: loop model ↔ tools until the model answers in text. `log` sees every step.
export async function turn({ page, tools, messages, log = () => {}, llm = DEFAULT_LLM }) {
  for (let i = 0; i < 12; i++) {
    const msg = await complete(messages, tools, llm);
    messages.push(msg);
    if (!msg.tool_calls?.length) return msg.content;
    for (const call of msg.tool_calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch {}
      log({ type: 'call', name: call.function.name, args });
      const result = await callTool(page, call.function.name, args);
      log({ type: 'result', name: call.function.name, result });
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }
  return 'Stopped after 12 tool rounds.';
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!DEFAULT_LLM.apiKey) throw new Error('Set MODEL_API_KEY in .env (Meta Model API key).');
  const url = process.argv[2] || 'http://localhost:3100/barbershop/';
  const { browser, page, tools } = await openSite(url);
  console.log(`${DEFAULT_LLM.model} on ${url}\ntools: ${tools.map((t) => t.name).join(', ')}\n`);
  const messages = [{ role: 'system', content: systemPrompt(url) }];
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const log = (e) => console.log(e.type === 'call'
    ? `  → ${e.name}(${JSON.stringify(e.args)})`
    : `  ← ${e.result.length > 200 ? e.result.slice(0, 200) + '…' : e.result}`);
  rl.on('close', () => browser.close());
  for (;;) {
    const input = await rl.question('you> ').catch(() => null);
    if (input === null || input === 'exit') break;
    messages.push({ role: 'user', content: input });
    console.log(`agent> ${await turn({ page, tools, messages, log })}\n`);
  }
  rl.close();
}
