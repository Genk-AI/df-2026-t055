import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../apps/api/src/app.ts';
import { MemoryRepository, doc, seed } from '../apps/api/src/adapters.ts';

function setup() {
    const db = new MemoryRepository(); seed(db);
    db.put('tasks', doc('demo', { id: 'task', status: 'ready' }));
    db.put('releases', doc('demo', { id: 'release', taskId: 'task', learnerId: 'a', version: 1 }));
    db.put('assignments', doc('demo', { id: 'assignment', taskId: 'task', learnerId: 'a', releaseId: 'release' }));
    db.put('supportRecords', doc('demo', { id: 'record', taskId: 'task', learnerId: 'a', revision: 1, observedDifficulty: 'private raw note' }));
    const { app } = createApp({ db });
    const body = { learnerId: 'a', sourceReleaseId: 'release', supportInputs: [{ recordId: 'record', revision: 1, summary: '確認済み要約' }], clientRequestId: 'key' };
    const post = (input: object) => app.fetch(new Request('http://localhost/api/v1/tasks/task/generations', { method: 'POST', headers: { authorization: 'Bearer staff', 'content-type': 'application/json' }, body: JSON.stringify(input) }));
    return { db, body, post };
}

test('improvement is idempotent, fixed at acceptance, and preserves the accepted snapshot', async () => {
    const { db, body, post } = setup();
    const learner = db.get('learners', 'a')!;
    db.put('learners', { ...learner, preferences: { ...learner.preferences, sentenceLength: 17, splitHints: '赤い線で区切る' } });
    const [first, second] = await Promise.all([post(body), post(body)]);
    assert.equal(first.status, 202); assert.equal(second.status, 202);
    const result = await first.json() as { jobId: string; draftId: string };
    assert.deepEqual(await second.json(), result);
    assert.equal(db.all('generationJobs').length, 1);
    const job = db.get('generationJobs', result.jobId)!;
    assert.deepEqual(job.inputSnapshot.supportInputs, body.supportInputs);
    assert.deepEqual(job.inputSnapshot.preferences, { sentenceLength: 17, splitHints: '赤い線で区切る', audioGuidance: false });
    db.put('learners', { ...learner, preferences: { ...learner.preferences, sentenceLength: 30, splitHints: '変更後' } });
    assert.equal(JSON.stringify(job.inputSnapshot).includes('private raw note'), false);
    const record = db.get('supportRecords', 'record')!;
    db.put('supportRecords', { ...record, revision: 2, observedDifficulty: 'changed' });
    assert.equal((await post(body)).status, 202);
    assert.equal(db.get('generationJobs', result.jobId)!.inputSnapshot.supportInputs[0].revision, 1);
    assert.deepEqual(db.get('generationJobs', result.jobId)!.inputSnapshot.preferences, { sentenceLength: 17, splitHints: '赤い線で区切る', audioGuidance: false });
    assert.equal((await post({ ...body, supportInputs: [{ ...body.supportInputs[0], summary: '違う要約' }] })).status, 409);
    assert.equal((await post({ ...body, clientRequestId: 'new-key' })).status, 409);
});

test('source assignment and record ownership are checked on new requests', async () => {
    const { db, body, post } = setup();
    const assignment = db.get('assignments', 'assignment')!;
    db.put('assignments', { ...assignment, releaseId: 'different' });
    assert.equal((await post(body)).status, 409);
    db.put('assignments', assignment);
    const record = db.get('supportRecords', 'record')!;
    db.put('supportRecords', { ...record, learnerId: 'b' });
    assert.equal((await post(body)).status, 409);
    assert.equal(db.all('generationJobs').length, 0);
});

test('improvement uses preferences captured at acceptance after the profile changes', async () => {
    const { db, body, post } = setup();
    const learner = db.get('learners', 'a')!;
    db.put('learners', { ...learner, preferences: { ...learner.preferences, sentenceLength: 18, splitHints: '赤い線で分ける' } });
    db.put('tasks', { ...db.get('tasks', 'task')!, title: '作業', videoAssetId: 'video' });
    db.put('assets', doc('demo', { id: 'video', objectPath: 'source/demo/task/video.mp4', durationMs: 1000 }));
    db.put('releases', { ...db.get('releases', 'release')!, learnerSteps: [{ order: 1, text: '折る', imageAltText: '写真', visibleCaution: '' }] });
    const result = await (await post(body)).json() as { jobId: string };
    db.put('learners', { ...learner, preferences: { ...learner.preferences, sentenceLength: 35, splitHints: '変更後' } });
    const { createWorker } = await import('../apps/generator/src/worker.ts');
    const { LocalStorage } = await import('../apps/api/src/adapters.ts');
    let captured: unknown;
    await createWorker(db, new LocalStorage(), { async generate(input) { captured = input.preferences; return {}; } }, 30)(result.jobId);
    assert.deepEqual(captured, { sentenceLength: 18, splitHints: '赤い線で分ける', audioGuidance: false });
});

test('improvement uses safe defaults for unset preferences', async () => {
    const { db, body, post } = setup();
    const learner = db.get('learners', 'a')!;
    db.put('learners', { ...learner, preferences: {} });
    const response = await post(body);
    assert.equal(response.status, 202);
    const result = await response.json() as { jobId: string };
    assert.deepEqual(db.get('generationJobs', result.jobId)!.inputSnapshot.preferences, { sentenceLength: 40, splitHints: '', audioGuidance: false });
});
