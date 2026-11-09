import http from '../../api/src/http.ts';
import { configuredRepository } from '../../api/src/firestore-repository.ts';
import { configuredStorage } from '../../api/src/cloud-storage.ts';
import { configuredQueue } from '../../api/src/cloud-tasks.ts';
import { configuredModel } from './model.ts';
import { createWorker } from './worker.ts';
import { configuredCorrectionModel } from './correction-model.ts';
import { createCloudHandler } from './cloud-handler.ts';

if (process.env.GENERATOR_BACKEND === 'cloud') {
  if (
    process.env.REPOSITORY_BACKEND !== 'firestore' ||
    process.env.STORAGE_BACKEND !== 'cloud' ||
    process.env.QUEUE_BACKEND !== 'cloud' ||
    process.env.MODEL_PROVIDER !== 'vertex'
  )
    throw Error('CLOUD_GENERATOR_ADAPTERS_REQUIRED');
  const db = configuredRepository(),
    storage = configuredStorage(),
    queue = configuredQueue();
  if (!queue) throw Error('CLOUD_TASKS_REQUIRED');
  const limit = Number(process.env.GENERATION_GLOBAL_LIMIT ?? 30);
  if (!Number.isInteger(limit) || limit < 0) throw Error('INVALID_GENERATION_GLOBAL_LIMIT');
  const app = createCloudHandler({
    db,
    queue,
    runJob: createWorker(
      db,
      storage,
      configuredModel(process.env),
      limit,
      configuredCorrectionModel(process.env),
    ),
    audience: process.env.GENERATOR_AUDIENCE ?? '',
    taskServiceAccount: process.env.TASKS_SERVICE_ACCOUNT_EMAIL ?? '',
    schedulerServiceAccount: process.env.SCHEDULER_SERVICE_ACCOUNT_EMAIL ?? '',
  });
  app.listen(
    Number(process.env.PORT ?? process.env.GENERATOR_PORT ?? 3002),
    process.env.LISTEN_HOST ?? '0.0.0.0',
  );
} else {
  if (process.env.NODE_ENV === 'production') throw Error('Cloud Tasks OIDC adapter required');
  const app = http();
  app.use(http.json());
  const token = process.env.INTERNAL_TOKEN ?? 'local-generator-only';
  app.post('/api/v1/internal/generate', async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) return res.sendStatus(403);
    try {
      const r = await fetch(
        `${process.env.API_URL ?? 'http://127.0.0.1:3001'}/api/v1/internal/generate`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(req.body),
        },
      );
      res.status(r.status).send(await r.text());
    } catch {
      res.sendStatus(503);
    }
  });
  // Local Cloud Tasks substitute: recover queued jobs and expired leases using a private API-side poll.
  app.listen(Number(process.env.GENERATOR_PORT ?? 3002), process.env.LISTEN_HOST ?? '127.0.0.1');
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await fetch(`${process.env.API_URL ?? 'http://127.0.0.1:3001'}/api/v1/internal/drain`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{}',
      });
    } catch {
    } finally {
      running = false;
    }
  }, 1000);
}
