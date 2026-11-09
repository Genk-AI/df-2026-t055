import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../apps/api/src/app.ts';
import { MemoryRepository, doc, seed, type Storage } from '../apps/api/src/adapters.ts';

function harness() {
  const db = new MemoryRepository();
  seed(db);
  const storage: Storage = {
    async put() {},
    async get() {
      return Buffer.from('');
    },
    async open() {
      return new Response('').body!;
    },
    async copy() {},
  };
  const { app } = createApp({ db, storage });
  db.put('tasks', doc('demo', { id: 'task', title: 'タオル' }));
  db.put('tasks', doc('demo', { id: 'other-task', title: '別の作業' }));
  const record = (id: string, learnerId: string, taskId: string, revision: number) =>
    doc('demo', {
      id,
      supportRequestId: id,
      learnerId,
      taskId,
      releaseId: 'old',
      stepId: 's',
      sessionId: 'session',
      observedDifficulty: '迷った',
      assistanceGiven: '一緒に確認',
      improvementSuggestion: '目印',
      createdBy: 'staff',
      updatedBy: 'staff',
      updatedAt: new Date().toISOString(),
      revision,
    });
  db.put('supportRecords', record('inherited', 'a', 'task', 1));
  db.put('supportRecords', record('updated', 'a', 'task', 2));
  db.put('supportRecords', record('referenced', 'a', 'task', 1));
  db.put('supportRecords', record('other-person', 'b', 'task', 1));
  db.put('supportRecords', record('other-task-record', 'a', 'other-task', 1));
  db.put(
    'releases',
    doc('demo', {
      id: 'old',
      learnerId: 'a',
      taskId: 'task',
      version: 1,
      appliedSupportRecordRefs: [
        { recordId: 'inherited', revision: 1 },
        { recordId: 'updated', revision: 1 },
      ],
    }),
  );
  db.put(
    'releases',
    doc('demo', {
      id: 'current',
      learnerId: 'a',
      taskId: 'task',
      version: 2,
      sourceReleaseId: 'old',
      appliedSupportRecordRefs: [],
    }),
  );
  db.put(
    'assignments',
    doc('demo', { id: 'assignment', learnerId: 'a', taskId: 'task', releaseId: 'current' }),
  );
  db.put(
    'drafts',
    doc('demo', { id: 'draft', learnerId: 'a', taskId: 'task', revision: 3, status: 'editing' }),
  );
  db.put(
    'generationJobs',
    doc('demo', {
      id: 'job',
      draftId: 'draft',
      status: 'succeeded',
      inputSnapshot: { supportInputs: [{ recordId: 'referenced', revision: 1 }] },
    }),
  );
  async function get(path: string, token = 'staff') {
    const response = await app.fetch(
      new Request(`http://localhost/api/v1${path}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    return { status: response.status, body: (await response.json()) as any };
  }
  return { db, get };
}

test('割当版と継承元で採用された版のみを反映済みとし、参照のみと新revisionは未反映', async () => {
  const h = harness();
  const list = await h.get('/learners/a/work-guides');
  assert.equal(list.status, 200);
  const item = list.body.items.find((x: any) => x.taskId === 'task');
  assert.deepEqual(item.assignment, { releaseId: 'current', version: 2 });
  assert.equal(item.unappliedCount, 2);
  assert.equal(item.latestDraft.status, 'editing');
  assert.equal(item.latestGeneration.status, 'succeeded');
  const records = await h.get('/learners/a/work-guides/task/support-records');
  assert.equal(records.status, 200);
  assert.deepEqual(
    Object.fromEntries(records.body.records.map((r: any) => [r.recordId, r.applied])),
    { inherited: true, updated: false, referenced: false },
  );
  assert.equal(list.body.items.find((x: any) => x.taskId === 'other-task').unappliedCount, 1);
});

test('本人・新人・別組織は職員用データを取得できない', async () => {
  const h = harness();
  for (const path of ['/learners/a/work-guides', '/learners/a/work-guides/task/support-records']) {
    for (const token of ['learner-a', 'newcomer', 'other-staff'])
      assert.equal((await h.get(path, token)).status, 403);
  }
  const own = await h.get('/learners/b/work-guides/task/support-records');
  assert.deepEqual(
    own.body.records.map((r: any) => r.recordId),
    ['other-person'],
  );
});

test('不正な継承循環や他本人へのリンクを未反映なしとして扱わない', async () => {
  const h = harness();
  h.db.put('releases', { ...h.db.get('releases', 'old')!, sourceReleaseId: 'current' });
  assert.equal((await h.get('/learners/a/work-guides')).status, 409);
  h.db.put('releases', {
    ...h.db.get('releases', 'old')!,
    sourceReleaseId: undefined,
    learnerId: 'b',
  });
  assert.equal((await h.get('/learners/a/work-guides/task/support-records')).status, 409);
});
