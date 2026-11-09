import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../apps/api/src/app.ts';
import { MemoryRepository, doc, seed, type Doc, type Storage } from '../apps/api/src/adapters.ts';

class TestRepository extends MemoryRepository {
  failHistory = false;
  override put(collection: string, value: Doc) {
    if (collection === 'draftCorrections' && this.failHistory) throw Error('simulated failure');
    return super.put(collection, value);
  }
}
function harness() {
  const db = new TestRepository();
  seed(db);
  const storage: Storage = {
    async put() {},
    async get() {
      return Buffer.from('image');
    },
    async open() {
      return new Response('image').body!;
    },
    async copy() {},
  };
  const { app } = createApp({ db, storage });
  db.put('assets', doc('demo', { id: 'video', kind: 'video', durationMs: 1000 }));
  db.put('tasks', doc('demo', { id: 'task', videoAssetId: 'video' }));
  const steps = ['one', 'two'].map((stepId) => ({
    stepId,
    text: '折る',
    imageAssetId: '',
    imageAltText: '',
    visibleCaution: '',
    sourceStartMs: 0,
    sourceEndMs: 1000,
    frameMs: 500,
    verifiedObservation: '',
    verifiedSpeech: '',
    coaching: '',
    completionCheck: '',
  }));
  const checks = { presentationConfirmed: false, flagResolution: '', steps: {} };
  db.put(
    'drafts',
    doc('demo', {
      id: 'draft',
      taskId: 'task',
      learnerId: 'a',
      status: 'editing',
      revision: 1,
      editedSteps: steps,
      reviewChecks: checks,
    }),
  );
  async function request(path: string, method = 'GET', body?: unknown, token = 'staff') {
    const response = await app.fetch(
      new Request(`http://localhost/api/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, body: (await response.json()) as any };
  }
  return { db, steps, checks, request };
}

test('保存と同時に差分を記録し確認のみ・古いrevisionでは履歴を追加しない', async () => {
  const h = harness();
  const changed = [
    { ...h.steps[1], text: '赤い線にあわせる' },
    { ...h.steps[0], imageAltText: 'タオル' },
  ];
  const response = await h.request('/drafts/draft', 'PATCH', {
    expectedRevision: 1,
    editedSteps: changed,
    reviewChecks: h.checks,
    correctionReason: '位置を合わせるため',
  });
  assert.equal(response.status, 200);
  const records = h.db.all('draftCorrections');
  assert.equal(records.length, 1);
  assert.equal(records[0].draftRevision, 2);
  assert.equal(records[0].createdBy, 'staff');
  assert.equal(records[0].reason, '位置を合わせるため');
  assert.deepEqual(
    records[0].changes.find((c: any) => c.field === 'text'),
    { stepId: 'two', field: 'text', before: '折る', after: '赤い線にあわせる' },
  );
  assert.equal(records[0].changes.filter((c: any) => c.field === 'position').length, 2);
  assert.equal(
    (
      await h.request('/drafts/draft', 'PATCH', {
        expectedRevision: 1,
        editedSteps: changed,
        reviewChecks: h.checks,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await h.request('/drafts/draft', 'PATCH', {
        expectedRevision: 2,
        editedSteps: changed,
        reviewChecks: h.checks,
      })
    ).status,
    200,
  );
  assert.equal(h.db.all('draftCorrections').length, 1);
});

test('追加と削除を区別し、履歴は職員と所属・本人・作業で分離する', async () => {
  const h = harness();
  const changed = [h.steps[1], { ...h.steps[0], stepId: 'new' }];
  assert.equal(
    (
      await h.request('/drafts/draft', 'PATCH', {
        expectedRevision: 1,
        editedSteps: changed,
        reviewChecks: h.checks,
      })
    ).status,
    200,
  );
  const changes = h.db.all('draftCorrections')[0].changes;
  assert.deepEqual(
    changes.find((c: any) => c.stepId === 'one' && c.field === 'text'),
    { stepId: 'one', field: 'text', before: '折る', after: null },
  );
  assert.deepEqual(
    changes.find((c: any) => c.stepId === 'new' && c.field === 'position'),
    { stepId: 'new', field: 'position', before: null, after: 1 },
  );
  const url = '/learners/a/work-guides/task/corrections';
  assert.equal((await h.request(url)).body.corrections.length, 1);
  assert.equal(
    (await h.request('/learners/b/work-guides/task/corrections')).body.corrections.length,
    0,
  );
  assert.equal((await h.request(url, 'GET', undefined, 'learner-a')).status, 403);
  assert.equal((await h.request(url, 'GET', undefined, 'newcomer')).status, 403);
  assert.equal((await h.request(url, 'GET', undefined, 'other-staff')).status, 403);
});

test('履歴保存失敗時は下書き更新もロールバックする', async () => {
  const h = harness();
  h.db.failHistory = true;
  const changed = [{ ...h.steps[0], text: '変更' }, h.steps[1]];
  assert.equal(
    (
      await h.request('/drafts/draft', 'PATCH', {
        expectedRevision: 1,
        editedSteps: changed,
        reviewChecks: h.checks,
      })
    ).status,
    500,
  );
  assert.equal(h.db.get('drafts', 'draft')!.revision, 1);
  assert.deepEqual(h.db.get('drafts', 'draft')!.editedSteps, h.steps);
  assert.equal(h.db.all('draftCorrections').length, 0);
  assert.equal(h.db.all('correctionCounters').length, 0);
});

test('20工程すべてを入れ替えても追加と削除の最大480項目を記録できる', async () => {
  const h = harness();
  const oldSteps = Array.from({ length: 20 }, (_, i) => ({ ...h.steps[0], stepId: `old-${i}` }));
  const newSteps = Array.from({ length: 20 }, (_, i) => ({ ...h.steps[0], stepId: `new-${i}` }));
  h.db.put('drafts', { ...h.db.get('drafts', 'draft')!, editedSteps: oldSteps });
  assert.equal(
    (
      await h.request('/drafts/draft', 'PATCH', {
        expectedRevision: 1,
        editedSteps: newSteps,
        reviewChecks: h.checks,
      })
    ).status,
    200,
  );
  assert.equal(h.db.all('draftCorrections')[0].changes.length, 480);
});

test('reference notes are isolated by correction revision and exclude private fields', async () => {
  const { createWorker } = await import('../apps/generator/src/worker.ts');
  const { FakeModel } = await import('../apps/generator/src/model.ts');
  const { LocalStorage } = await import('../apps/api/src/adapters.ts');
  const h = harness();
  h.db.put('tasks', { ...h.db.get('tasks', 'task')!, title: '作業' });
  const first = [{ ...h.steps[0], text: '赤い線' }, h.steps[1]];
  assert.equal(
    (
      await h.request('/drafts/draft', 'PATCH', {
        expectedRevision: 1,
        editedSteps: first,
        reviewChecks: h.checks,
        correctionReason: 'private reason',
      })
    ).status,
    200,
  );
  const second = [{ ...first[0], text: '青い線' }, first[1]];
  assert.equal(
    (
      await h.request('/drafts/draft', 'PATCH', {
        expectedRevision: 2,
        editedSteps: second,
        reviewChecks: h.checks,
      })
    ).status,
    200,
  );
  const corrections = h.db.all('draftCorrections');
  assert.equal(corrections.length, 2);
  assert.deepEqual((await h.request('/tasks')).body.tasks[0].generationJobs, []);
  let captured: any;
  const run = createWorker(h.db, new LocalStorage(), new FakeModel(), 30, {
    async generate(input) {
      captured = input;
      return { editSummary: input.changes[0].after, nextDraftHint: '確認', reviewFlags: [] };
    },
  });
  await run(corrections[1].contextJobId);
  await run(corrections[0].contextJobId);
  assert.deepEqual(captured, {
    title: '作業',
    changes: [{ field: 'text', before: '折る', after: '赤い線' }],
  });
  assert.equal(JSON.stringify(captured).includes('private reason'), false);
  assert.equal(
    h.db.get('draftCorrections', corrections[0].id)!.contextSummary.editSummary,
    '赤い線',
  );
  assert.equal(
    h.db.get('draftCorrections', corrections[1].id)!.contextSummary.editSummary,
    '青い線',
  );
  assert.equal(h.db.get('drafts', 'draft')!.editedSteps[0].text, '青い線');
});

test('pause and invalid model output do not block or undo editing', async () => {
  const { createWorker } = await import('../apps/generator/src/worker.ts');
  const { FakeModel } = await import('../apps/generator/src/model.ts');
  const { LocalStorage } = await import('../apps/api/src/adapters.ts');
  const h = harness();
  h.db.put('tasks', { ...h.db.get('tasks', 'task')!, title: '作業' });
  h.db.put('operations', doc('demo', { id: 'generation-control', enabled: false }));
  const first = [{ ...h.steps[0], text: '一回目' }, h.steps[1]];
  assert.equal(
    (
      await h.request('/drafts/draft', 'PATCH', {
        expectedRevision: 1,
        editedSteps: first,
        reviewChecks: h.checks,
      })
    ).status,
    200,
  );
  assert.equal(h.db.all('generationJobs').length, 0);
  h.db.put('operations', { ...h.db.get('operations', 'generation-control')!, enabled: true });
  const second = [{ ...first[0], text: '二回目' }, first[1]];
  assert.equal(
    (
      await h.request('/drafts/draft', 'PATCH', {
        expectedRevision: 2,
        editedSteps: second,
        reviewChecks: h.checks,
      })
    ).status,
    200,
  );
  const job = h.db.all('generationJobs')[0];
  await createWorker(h.db, new LocalStorage(), new FakeModel(), 30, {
    async generate() {
      return { editSummary: 'invalid' };
    },
  })(job.id);
  assert.equal(h.db.get('generationJobs', job.id)!.status, 'failed');
  assert.equal(h.db.get('drafts', 'draft')!.status, 'editing');
  assert.equal(h.db.get('drafts', 'draft')!.editedSteps[0].text, '二回目');
});

test('different drafts of the same person and task serialize correction sequence', async () => {
  const h = harness();
  h.db.put('drafts', { ...h.db.get('drafts', 'draft')!, id: 'other-draft' });
  const first = [{ ...h.steps[0], text: '一つ目' }, h.steps[1]];
  const second = [{ ...h.steps[0], text: '二つ目' }, h.steps[1]];
  const [a, b] = await Promise.all([
    h.request('/drafts/draft', 'PATCH', {
      expectedRevision: 1,
      editedSteps: first,
      reviewChecks: h.checks,
    }),
    h.request('/drafts/other-draft', 'PATCH', {
      expectedRevision: 1,
      editedSteps: second,
      reviewChecks: h.checks,
    }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual(
    h.db
      .all('draftCorrections')
      .map((c) => c.correctionSequence)
      .sort(),
    [1, 2],
  );
  assert.equal(h.db.all('correctionCounters')[0].sequence, 2);
  const visible = await h.request('/learners/a/work-guides/task/corrections');
  assert.equal(visible.status, 200);
  assert.ok(visible.body.corrections.every((c: any) => !('correctionSequence' in c)));
});
