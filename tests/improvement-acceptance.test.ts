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
    const getDraft = (draftId: string, token = 'staff') => app.fetch(new Request(`http://localhost/api/v1/drafts/${draftId}`, { headers: { authorization: `Bearer ${token}` } }));
    const post = (input: object) => app.fetch(new Request('http://localhost/api/v1/tasks/task/generations', { method: 'POST', headers: { authorization: 'Bearer staff', 'content-type': 'application/json' }, body: JSON.stringify(input) }));
    return { db, body, post, getDraft };
}

test('improvement is idempotent, fixed at acceptance, and preserves the accepted snapshot', async () => {
    const { db, body, post, getDraft } = setup();
    db.put('draftCorrections', doc('demo', { id: 'history', taskId: 'task', learnerId: 'a', draftRevision: 4, changes: [{ stepId: 'step', field: 'text', before: '前', after: '修正' }] }));
    const [first, second] = await Promise.all([post(body), post(body)]);
    assert.equal(first.status, 202); assert.equal(second.status, 202);
    const result = await first.json() as { jobId: string; draftId: string };
    assert.deepEqual(await second.json(), result);
    assert.equal(db.all('generationJobs').length, 1);
    const job = db.get('generationJobs', result.jobId)!;
    assert.deepEqual(job.inputSnapshot.supportInputs, body.supportInputs);
    const detail = await getDraft(result.draftId);
    assert.equal(detail.status, 200);
    assert.deepEqual((await detail.json()).draft.referencedSupportInputs, body.supportInputs);
    assert.equal((await getDraft(result.draftId, 'learner-a')).status, 403);
    assert.deepEqual(job.inputSnapshot.correctionRefs, [{ correctionId: 'history', draftRevision: 4 }]);
    assert.equal(job.inputSnapshot.correctionInputs[0].changes[0].after, '修正');
    db.put('draftCorrections', { ...db.get('draftCorrections', 'history')!, contextSummary: { editSummary: '後からの要約', nextDraftHint: '後から', reviewFlags: [] } });
    assert.equal(db.get('generationJobs', result.jobId)!.inputSnapshot.correctionInputs[0].contextSummary, undefined);
    assert.equal(JSON.stringify(job.inputSnapshot).includes('private raw note'), false);
    const record = db.get('supportRecords', 'record')!;
    db.put('supportRecords', { ...record, revision: 2, observedDifficulty: 'changed' });
    assert.equal((await post(body)).status, 202);
    assert.equal(db.get('generationJobs', result.jobId)!.inputSnapshot.supportInputs[0].revision, 1);
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

test('failed improvement exposes only its scoped retry input and accepts a new idempotent job', async () => {
    const { db, body, post } = setup();
    const firstResponse = await post(body);
    const first = await firstResponse.json() as { jobId: string; draftId: string };
    const job = db.get('generationJobs', first.jobId)!;
    db.put('generationJobs', { ...job, status: 'failed' });
    db.put('drafts', { ...db.get('drafts', first.draftId)!, status: 'failed' });
    const app = createApp({ db }).app;
    const getJob = (token: string) => app.fetch(new Request(`http://localhost/api/v1/jobs/${first.jobId}`, { headers: { authorization: `Bearer ${token}` } }));
    assert.equal((await getJob('learner-a')).status, 403);
    assert.equal((await getJob('newcomer')).status, 403);
    assert.equal((await getJob('other-staff')).status, 403);
    const data = await (await getJob('staff')).json() as { retryInput: { learnerId: string; sourceReleaseId: string; supportInputs: typeof body.supportInputs } };
    assert.deepEqual(data.retryInput, { learnerId: body.learnerId, sourceReleaseId: body.sourceReleaseId, supportInputs: body.supportInputs });
    assert.equal(JSON.stringify(data).includes('private raw note'), false);
    const retry = { ...data.retryInput, clientRequestId: 'retry-key' };
    const response = await post(retry); assert.equal(response.status, 202);
    const next = await response.json() as { jobId: string; draftId: string };
    assert.notEqual(next.jobId, first.jobId);
    assert.deepEqual(await (await post(retry)).json(), next);
    assert.equal(db.get('generationJobs', next.jobId)!.inputSnapshot.sourceReleaseId, body.sourceReleaseId);
    assert.deepEqual(db.get('generationJobs', next.jobId)!.inputSnapshot.supportInputs, body.supportInputs);
    const record = db.get('supportRecords', 'record')!;
    db.put('supportRecords', { ...record, revision: 2 });
    assert.equal((await post({ ...retry, clientRequestId: 'different-key' })).status, 409);
});

test('retry input is never returned for a mismatched job and draft', async () => {
    const { db, body, post } = setup();
    const result = await (await post(body)).json() as { jobId: string; draftId: string };
    const job = db.get('generationJobs', result.jobId)!;
    db.put('generationJobs', { ...job, status: 'failed', taskId: 'other-task' });
    const response = await createApp({ db }).app.fetch(new Request(`http://localhost/api/v1/jobs/${result.jobId}`, { headers: { authorization: 'Bearer staff' } }));
    assert.equal(response.status, 409);
    assert.equal(JSON.stringify(await response.json()).includes('確認済み要約'), false);
});
