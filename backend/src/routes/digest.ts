// Digest routes: preview the weekly budget digest (data + rendered text) and
// send it on demand. The scheduler in digest.ts is the automatic path; these
// endpoints are for checking it and triggering manually.

import { FastifyInstance } from 'fastify';
import { getBudgetOrThrow } from '../engineLoad';
import { buildDigestData, buildDigest, sendDigestNow, digestRecipient } from '../digest';

export default async function digestRoutes(app: FastifyInstance) {
  app.get('/digest/preview', async () => {
    const budget = await getBudgetOrThrow();
    const data = await buildDigestData(budget.id);
    const digest = buildDigest(data);
    return { data, ...digest, recipient: digestRecipient() };
  });

  app.post('/digest/send', async (_req, reply) => {
    try {
      return await sendDigestNow();
    } catch (e) {
      // config errors (no recipient/provider) and delivery failures surface
      // in the app's { error } shape so the UI can show + act on them
      return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });
}
