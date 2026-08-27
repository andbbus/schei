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

  app.post('/digest/send', async () => {
    return sendDigestNow();
  });
}
