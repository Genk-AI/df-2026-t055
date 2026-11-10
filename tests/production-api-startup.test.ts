import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const config = {
  NODE_ENV: 'production',
  AUTH_BACKEND: 'firebase',
  REPOSITORY_BACKEND: 'firestore',
  STORAGE_BACKEND: 'cloud',
  QUEUE_BACKEND: 'cloud',
  MODEL_PROVIDER: 'vertex',
  TTS_PROVIDER: 'vertex',
  SPEECH_PROVIDER: 'google',
  SPEECH_LOCATION: 'us',
  GOOGLE_CLOUD_PROJECT: 'startup-test',
  FIREBASE_PROJECT_ID: 'startup-test',
  FIRESTORE_ORG_ID: 'demo',
  STORAGE_BUCKET: 'startup-test',
  VIDEO_BUCKET: 'startup-test',
  GOOGLE_CLOUD_LOCATION: 'asia-northeast1',
  VERTEX_MODEL: 'test-model',
  TTS_LOCATION: 'us-central1',
  WEB_ORIGIN: 'https://example.test',
  TASKS_LOCATION: 'asia-northeast1',
  TASKS_QUEUE: 'generation',
  GENERATOR_URL: 'https://generator.example.test/api/v1/internal/generate',
  GENERATOR_AUDIENCE: 'https://generator.example.test',
  TASKS_SERVICE_ACCOUNT_EMAIL: 'tasks@startup-test.iam.gserviceaccount.com',
  FIRESTORE_EMULATOR_HOST: '',
  FIREBASE_AUTH_EMULATOR_HOST: '',
  STORAGE_EMULATOR_HOST: '',
  LISTEN_HOST: '127.0.0.1',
};
function start(changes: Record<string, string>) {
  const child = spawn(
    process.execPath,
    ['--experimental-transform-types', 'apps/api/src/server.ts'],
    {
      env: { ...process.env, ...config, ...changes },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stderr.on('data', (data) => {
    output += data;
  });
  return { child, output: () => output };
}

test(
  'production API refuses local adapters, insecure origins and emulators',
  { timeout: 30000 },
  async () => {
    const invalid = [
      ...[
        'AUTH_BACKEND',
        'REPOSITORY_BACKEND',
        'STORAGE_BACKEND',
        'QUEUE_BACKEND',
        'MODEL_PROVIDER',
        'TTS_PROVIDER',
        'SPEECH_PROVIDER',
      ].map((key) => ({ [key]: '' })),
      { WEB_ORIGIN: 'http://example.test' },
      { WEB_ORIGIN: 'https://example.test/path' },
      ...['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'STORAGE_EMULATOR_HOST'].map(
        (key) => ({
          [key]: 'localhost:9000',
        }),
      ),
    ];
    for (const changes of invalid) {
      const { child, output } = start(changes);
      const code = await new Promise((resolve) => child.once('exit', resolve));
      assert.notEqual(code, 0, JSON.stringify(changes));
      assert.match(
        output(),
        /PRODUCTION_(CLOUD_ADAPTERS_REQUIRED|HTTPS_ORIGIN_REQUIRED|EMULATORS_DISABLED)/,
      );
    }
  },
);

test(
  'configured production API starts and closes local internal endpoints',
  { timeout: 10000 },
  async () => {
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const { child, output } = start({ API_PORT: String(port) });
    try {
      let response: Response | undefined;
      for (let attempt = 0; attempt < 50; attempt++) {
        assert.equal(child.exitCode, null, output());
        try {
          response = await fetch(`http://127.0.0.1:${port}/api/v1/tasks`);
          break;
        } catch {
          await delay(100);
        }
      }
      assert.ok(response, output());
      assert.equal(response.status, 401);
      for (const path of ['generate', 'drain']) {
        const internal = await fetch(`http://127.0.0.1:${port}/api/v1/internal/${path}`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer local-generator-only',
            'content-type': 'application/json',
          },
          body: '{}',
        });
        assert.equal(internal.status, 404);
      }
    } finally {
      child.kill();
      if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
    }
  },
);
