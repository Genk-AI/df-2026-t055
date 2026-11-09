import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import http from '../../api/src/http.ts';
import type { Repository } from '../../api/src/adapters.ts';
import { reconcileGenerationJobs, type GenerationQueue } from '../../api/src/cloud-tasks.ts';

type Verifier = (token: string, audience: string, serviceAccount: string) => Promise<boolean>;
export function googleOidcVerifier(): Verifier {
  const client = new OAuth2Client();
  return async (token, audience, serviceAccount) => {
    try {
      const ticket = await client.verifyIdToken({ idToken: token, audience });
      const payload = ticket.getPayload();
      return payload?.email_verified === true && payload.email === serviceAccount;
    } catch {
      return false;
    }
  };
}
export function createCloudHandler(options: {
  db: Repository;
  queue: GenerationQueue;
  runJob: (jobId: string) => Promise<unknown>;
  audience: string;
  taskServiceAccount: string;
  schedulerServiceAccount: string;
  verify?: Verifier;
}) {
  if (
    !options.audience ||
    !options.taskServiceAccount ||
    !options.schedulerServiceAccount ||
    options.taskServiceAccount === options.schedulerServiceAccount
  )
    throw Error('INVALID_GENERATOR_OIDC_CONFIG');
  const verify = options.verify ?? googleOidcVerifier();
  const app = http();
  app.use(http.json({ limit: '1mb' }));
  const authorized = async (header: string | undefined, serviceAccount: string) => {
    const token = /^Bearer (\S+)$/.exec(header ?? '')?.[1];
    return !!token && (await verify(token, options.audience, serviceAccount));
  };
  app.post('/api/v1/internal/generate', async (req, res) => {
    if (!(await authorized(req.headers.authorization, options.taskServiceAccount)))
      return res.sendStatus(403);
    const body = z
      .object({ jobId: z.string().regex(/^[A-Za-z0-9_-]+$/) })
      .strict()
      .safeParse(req.body);
    if (!body.success) return res.sendStatus(400);
    try {
      const outcome = await options.runJob(body.data.jobId);
      if (outcome === 'busy') return res.sendStatus(503);
      res.sendStatus(204);
    } catch {
      res.sendStatus(503);
    }
  });
  app.post('/api/v1/internal/reconcile', async (req, res) => {
    if (!(await authorized(req.headers.authorization, options.schedulerServiceAccount)))
      return res.sendStatus(403);
    try {
      await reconcileGenerationJobs(options.db, options.queue);
      res.sendStatus(204);
    } catch {
      res.sendStatus(503);
    }
  });
  return app;
}
