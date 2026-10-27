import { json, siteConfig } from './_lib.js';

// GET ?site → the business's approved config, for agentready.js installed on the owner's own site.
export function GET(request) {
  const config = siteConfig(new URL(request.url).searchParams.get('site'));
  return config ? json(config) : json({ error: 'unknown_site' }, 404);
}
