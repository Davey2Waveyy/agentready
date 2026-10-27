import { followJob } from './_lib.js';

// GET ?id&from → NDJSON events of a generate/verify job, from index `from`. Reconnect until an {type:'end'} event.
export function GET(request) {
  const q = new URL(request.url).searchParams;
  return followJob(q.get('id'), Math.max(0, Number(q.get('from')) || 0));
}
