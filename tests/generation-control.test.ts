import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../apps/api/src/app.ts';
import { MemoryRepository, doc, seed } from '../apps/api/src/adapters.ts';

test('pause rejects generation while ordinary reads and edits stay available', async () => {
  const db = new MemoryRepository();
  seed(db);
  db.put('tasks', doc('demo', { id: 'task', title: '作業', status: 'ready' }));
  db.put('operations', doc('demo', { id: 'generation-control', enabled: false }));
  const { app } = createApp({ db });
  const request = (path: string, method = 'GET', body?: object) =>
    app.fetch(
      new Request(`http://localhost/api/v1${path}`, {
        method,
        headers: { authorization: 'Bearer staff', 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  const rejected = await request('/tasks/task/generations', 'POST', { learnerId: 'a' });
  assert.equal(rejected.status, 409);
  assert.equal(((await rejected.json()) as any).error.code, 'GENERATION_PAUSED');
  assert.equal(db.all('generationJobs').length, 0);
  assert.equal((await request('/tasks/task')).status, 200);
  assert.equal((await request('/learners/a')).status, 200);
  assert.equal(
    (await request('/learners/a', 'PATCH', { expectedRevision: 1, displayName: '更新' })).status,
    200,
  );
  const record = db.get('operations', 'generation-control')!;
  db.put('operations', { ...record, enabled: true });
  assert.equal((await request('/tasks/task/generations', 'POST', { learnerId: 'a' })).status, 202);
});

test('malformed control values fail closed', async () => {
  const { generationEnabled } = await import('../apps/api/src/generation-control.ts');
  const db = new MemoryRepository();
  assert.equal(await generationEnabled(db), true);
  db.put('operations', doc('demo', { id: 'generation-control', enabled: 'true' }));
  assert.equal(await generationEnabled(db), false);
});
