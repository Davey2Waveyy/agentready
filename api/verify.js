// POST {url, config} → NDJSON stream of gauntlet results (3 skeptics × site + broken twin), then the verdict.
// The draft is served only inside the test browser and always in mock mode: verifying never books for real.
import { gauntlet, SKEPTICS, FAULTS } from '../agent/gauntlet.mjs';
import { validate } from '../agent/generate.mjs';
import { DEFAULT_LLM } from '../agent/run.mjs';
import { ndjson, addDraft } from './_lib.js';

export async function POST(request) {
  const { url, config } = await request.json().catch(() => ({}));
  if (!/^https?:\/\//.test(url ?? '')) return Response.json({ error: 'url must start with http(s)://' }, { status: 400 });
  const { errors } = validate(config ?? {});
  if (errors.length) return Response.json({ error: `Fix these first: ${errors.join('; ')}` }, { status: 400 });
  const site = addDraft(config);
  return ndjson(async (send) => {
    let started = false;
    const runs = [];
    for (const model of SKEPTICS) {
      runs.push(await gauntlet(url, {
        config, site, llm: { ...DEFAULT_LLM, model },
        onTasks: (tasks) => started || (started = true, send({ type: 'start', models: SKEPTICS, tasks: tasks.map(({ id, ask }) => ({ id, ask })), faults: FAULTS })),
        onRunning: (side, id) => send({ type: 'running', model, side, id }),
        onResult: (side, r) => send({ type: 'result', model, side, ...r }),
      }));
    }
    send({ type: 'verdict', site, verdict: { verified: runs.every((r) => r.verdict.verified), skeptics: runs.map((r) => ({ model: r.model, ...r.verdict })) } });
  });
}
