import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRepository, doc } from '../apps/api/src/adapters.ts';
import { CloudTasksQueue, reconcileGenerationJobs } from '../apps/api/src/cloud-tasks.ts';
import { createCloudHandler } from '../apps/generator/src/cloud-handler.ts';
import { createWorker } from '../apps/generator/src/worker.ts';
import { LocalStorage } from '../apps/api/src/adapters.ts';
import { FakeModel } from '../apps/generator/src/model.ts';

const config = { project: 'project', location: 'asia-northeast1', queue: 'generation', target: 'https://generator.example/api/v1/internal/generate', audience: 'https://generator.example', serviceAccount: 'tasks@project.iam.gserviceaccount.com' };
test('Cloud Tasks sends OIDC, deadline and bounded deterministic recovery names', async () => {
    const calls: any[] = [];
    const queue = new CloudTasksQueue(config, { async request(input) { calls.push(input); return {}; } });
    await queue.enqueue('job-1', 1);
    await queue.enqueue('job-1', 2);
    await queue.enqueue('job-1', 300001);
    const task = calls[0].data.task;
    assert.equal(task.dispatchDeadline, '240s');
    assert.equal(task.httpRequest.url, config.target);
    assert.deepEqual(task.httpRequest.oidcToken, { serviceAccountEmail: config.serviceAccount, audience: config.audience });
    assert.deepEqual(JSON.parse(Buffer.from(task.httpRequest.body, 'base64').toString()), { jobId: 'job-1' });
    assert.equal(task.name, calls[1].data.task.name);
    assert.notEqual(task.name, calls[2].data.task.name);
    const dup = new CloudTasksQueue(config, { async request() { throw { response: { status: 409 } }; } });
    await dup.enqueue('job-1');
    const fail = new CloudTasksQueue(config, { async request() { throw Error('secret'); } });
    await assert.rejects(fail.enqueue('job-1'), /^Error: TASK_ENQUEUE_FAILED$/);
    assert.throws(() => new CloudTasksQueue({ ...config, target: 'http://generator.example' }), /INVALID_TASKS_TARGET/);
});

test('reconciliation retries queued, expired and missing-lease jobs but ignores live and terminal jobs', async () => {
    const db = new MemoryRepository();
    for (const [id, status, leaseUntil] of [['queued', 'queued', 0], ['expired', 'running', 9], ['live', 'running', 11], ['finished', 'succeeded', 0]] as const)
        db.put('generationJobs', doc('org', { id, status, leaseUntil }));
    db.put('generationJobs', doc('org', { id: 'missing-lease', status: 'running' }));
    const sent: string[] = [];
    await reconcileGenerationJobs(db, { async enqueue(id) { sent.push(id); } }, 10);
    assert.deepEqual(sent.sort(), ['expired', 'missing-lease', 'queued']);
    await assert.rejects(reconcileGenerationJobs(db, { async enqueue() { throw Error('offline'); } }, 10), /TASK_RECONCILIATION_FAILED/);
});

test('generator verifies each service account and retries a live lease', async () => {
    const db = new MemoryRepository();
    db.put('generationJobs', doc('org', { id: 'job', status: 'running', leaseUntil: Date.now() + 100000 }));
    let seen: string[] = [];
    const app = createCloudHandler({ db, queue: { async enqueue() {} }, runJob: createWorker(db, new LocalStorage(), new FakeModel(), 30),
        audience: 'audience', taskServiceAccount: 'task', schedulerServiceAccount: 'scheduler',
        verify: async (token, aud, email) => { seen.push(`${aud}:${email}`); return token === email; } });
    const request = (path: string, token: string, body = '{}') => app.fetch(new Request(`http://local${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body }));
    assert.equal((await request('/api/v1/internal/generate', 'scheduler', '{"jobId":"job"}')).status, 403);
    assert.equal((await request('/api/v1/internal/generate', 'task', '{"jobId":"job"}')).status, 503);
    assert.equal((await request('/api/v1/internal/generate', 'task', '{"jobId":"../escape"}')).status, 400);
    assert.equal((await request('/api/v1/internal/reconcile', 'task')).status, 403);
    assert.equal((await request('/api/v1/internal/reconcile', 'scheduler')).status, 204);
    assert.ok(seen.includes('audience:task') && seen.includes('audience:scheduler'));
});

test('failed initial enqueue leaves a committed job for a later reconciliation', async () => {
    const { createApp } = await import('../apps/api/src/app.ts');
    const { seed } = await import('../apps/api/src/adapters.ts');
    const db = new MemoryRepository(); seed(db);
    db.put('tasks', doc('demo', { id: 'task', status: 'ready' }));
    const app = createApp({ db, queue: { async enqueue() { throw Error('offline'); } } }).app;
    const response = await app.fetch(new Request('http://localhost/api/v1/tasks/task/generations', {
        method: 'POST', headers: { authorization: 'Bearer staff', 'content-type': 'application/json' }, body: JSON.stringify({ learnerId: 'a' })
    }));
    assert.equal(response.status, 202);
    const internal = await app.fetch(new Request('http://localhost/api/v1/internal/drain', { method: 'POST', headers: { authorization: 'Bearer local-generator-only', 'content-type': 'application/json' }, body: '{}' }));
    assert.equal(internal.status, 404);
    const result = await response.json() as { jobId: string };
    assert.equal(db.get('generationJobs', result.jobId)?.status, 'queued');
    const sent: string[] = [];
    await reconcileGenerationJobs(db, { async enqueue(id) { sent.push(id); } });
    assert.deepEqual(sent, [result.jobId]);
});

test('local drain recovers a running job without a lease', async () => {
    const { createApp } = await import('../apps/api/src/app.ts');
    const db = new MemoryRepository();
    db.put('generationJobs', doc('org', { id: 'missing-lease', status: 'running' }));
    const processed: string[] = [];
    const app = createApp({ db, internalToken: 'test-internal', runJob: async id => { processed.push(id); } }).app;
    const response = await app.fetch(new Request('http://localhost/api/v1/internal/drain', {
        method: 'POST', headers: { authorization: 'Bearer test-internal', 'content-type': 'application/json' }, body: '{}'
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(processed, ['missing-lease']);
});
