// POST {url, config} → {job}. Follow it at /api/job: gauntlet results (3 skeptics × site + broken twin), then the verdict.
// The draft is served only inside the test browser and always in mock mode: verifying never books for real.
import { gauntlet, SKEPTICS, FAULTS } from '../agent/gauntlet.mjs';
import { validate } from '../agent/generate.mjs';
import { DEFAULT_LLM } from '../agent/run.mjs';
import { json, startJob, runningJobs, targetUrl, addSite, verifying } from './_lib.js';

export async function POST(request) {
  const { url, config } = await request.json().catch(() => ({}));
  const target = targetUrl(request, url ?? '');
  if (!target) return json({ error: 'Enter a public http(s) URL.' }, 400);
  const { errors } = validate(config ?? {});
  if (errors.length) return json({ error: `Fix these first: ${errors.join('; ')}` }, 400);
  if (runningJobs() >= 3) return json({ error: 'Busy verifying other sites. Try again in a few minutes.' }, 429);
  const site = addSite(config);
  return json({ job: startJob(async (send) => {
    verifying.add(config);
    try {
      let started = false;
      const runs = [];
      for (const model of SKEPTICS) {
        runs.push(await gauntlet(target, {
          config, site, api: `http://localhost:${process.env.PORT || 3100}`, llm: { ...DEFAULT_LLM, model }, log: () => {},
          onTasks: (tasks) => started || (started = true, send({ type: 'start', models: SKEPTICS, tasks: tasks.map(({ id, ask }) => ({ id, ask })), faults: FAULTS })),
          onRunning: (side, id) => send({ type: 'running', model, side, id }),
          onResult: (side, r) => send({ type: 'result', model, side, ...r }),
        }));
      }
      send({ type: 'verdict', site, verdict: { verified: runs.every((r) => r.verdict.verified), skeptics: runs.map((r) => ({ model: r.model, ...r.verdict })) } });
    } finally {
      verifying.delete(config);
    }
  }) });
}
