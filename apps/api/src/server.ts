import http from './http.ts';
import { resolve } from 'node:path';
import { createApp } from './app.ts';
import { MemoryRepository, seed } from './adapters.ts';
import { createWorker } from '../../generator/src/worker.ts';
import { configuredCorrectionModel } from '../../generator/src/correction-model.ts';
import { configuredStorage } from './cloud-storage.ts';
import { configuredQueue } from './cloud-tasks.ts';
import { configuredRepository } from './firestore-repository.ts';
import { configuredModelConfig } from '../../generator/src/model-config.ts';
import { configuredModel } from '../../generator/src/model.ts';
if (process.env.NODE_ENV === 'production') {
  if (
    process.env.AUTH_BACKEND !== 'firebase' ||
    process.env.REPOSITORY_BACKEND !== 'firestore' ||
    process.env.STORAGE_BACKEND !== 'cloud' ||
    process.env.QUEUE_BACKEND !== 'cloud' ||
    process.env.MODEL_PROVIDER !== 'vertex' ||
    process.env.TTS_PROVIDER !== 'vertex' ||
    process.env.SPEECH_PROVIDER !== 'google'
  )
    throw Error('PRODUCTION_CLOUD_ADAPTERS_REQUIRED');
  const origin = new URL(process.env.WEB_ORIGIN ?? '');
  if (origin.protocol !== 'https:' || origin.origin !== process.env.WEB_ORIGIN)
    throw Error('PRODUCTION_HTTPS_ORIGIN_REQUIRED');
  if (
    process.env.FIRESTORE_EMULATOR_HOST ||
    process.env.FIREBASE_AUTH_EMULATOR_HOST ||
    process.env.STORAGE_EMULATOR_HOST
  )
    throw Error('PRODUCTION_EMULATORS_DISABLED');
}
const db = configuredRepository(),
  storage = configuredStorage();
if (db instanceof MemoryRepository) seed(db);
const modelConfig = configuredModelConfig(process.env);
const limit = Number(process.env.GENERATION_GLOBAL_LIMIT ?? 30);
const runJob = createWorker(
  db,
  storage,
  configuredModel(process.env),
  limit,
  configuredCorrectionModel(process.env),
);
const { app } = createApp({
  db,
  storage,
  globalLimit: limit,
  modelId: modelConfig.modelId,
  promptVersion: modelConfig.promptVersion,
  runJob,
  queue: configuredQueue(),
});
app.get('/', (_req, res) => res.sendFile(resolve('apps/web/dist/index.html')));
app.use(http.static(resolve('apps/web/dist')));
app.get(/^\/(staff|me|handover)(\/.*)?$/, (_req, res) =>
  res.sendFile(resolve('apps/web/dist/index.html')),
);
app.listen(Number(process.env.API_PORT ?? 3001), process.env.LISTEN_HOST ?? '127.0.0.1');
