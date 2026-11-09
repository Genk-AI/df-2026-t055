import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRepository, LocalStorage, doc } from '../apps/api/src/adapters.ts';
import { createWorker } from '../apps/generator/src/worker.ts';
import { VertexVideoModel, type ModelInput } from '../apps/generator/src/model.ts';

function setup() {
  const db = new MemoryRepository();
  db.put('tasks', doc('demo', { id: 'task', title: '作業', videoAssetId: 'video' }));
  db.put(
    'assets',
    doc('demo', {
      id: 'video',
      objectPath: 'source/demo/task/video.mp4',
      durationMs: 12000,
      generation: '5',
    }),
  );
  db.put(
    'learners',
    doc('demo', {
      id: 'a',
      displayName: 'PRIVATE NAME',
      confirmedGuidance: ['changed later'],
      preferences: { sentenceLength: 10, splitHints: 'private preference' },
    }),
  );
  db.put(
    'releases',
    doc('demo', {
      id: 'release',
      taskId: 'task',
      learnerId: 'a',
      version: 1,
      learnerSteps: [
        {
          order: 1,
          text: '折る',
          imageAltText: '写真',
          visibleCaution: '',
          imageAssetId: 'private-asset-id',
          stepId: 'step',
        },
      ],
      staffGuide: [{ coaching: 'private staff note' }],
    }),
  );
  db.put(
    'drafts',
    doc('demo', {
      id: 'draft',
      jobId: 'job',
      taskId: 'task',
      learnerId: 'a',
      sourceReleaseId: 'release',
      status: 'generating',
    }),
  );
  db.put(
    'generationJobs',
    doc('demo', {
      id: 'job',
      taskId: 'task',
      draftId: 'draft',
      status: 'queued',
      attempt: 0,
      budgetUsed: 1,
      inputSnapshot: {
        taskId: 'task',
        learnerId: 'a',
        sourceReleaseId: 'release',
        sourceReleaseVersion: 1,
        supportInputs: [{ recordId: 'record', revision: 1, summary: '確認された要約' }],
        correctionRefs: [{ correctionId: 'history', draftRevision: 3 }],
        correctionInputs: [
          {
            correctionId: 'history',
            draftRevision: 3,
            changes: [{ stepId: 'step', field: 'text', before: '前', after: '後' }],
            contextSummary: { editSummary: '編集', nextDraftHint: '確認', reviewFlags: [] },
          },
        ],
        preferences: { sentenceLength: 24, splitHints: '赤い線ごと', audioGuidance: false },
        displayMode: 'photo_only',
        confirmedGuidance: ['ゆっくり'],
      },
    }),
  );
  return db;
}

test('improvement sends only allowed fixed inputs and leaves the old release untouched on failure', async () => {
  const db = setup();
  const old = db.get('releases', 'release');
  let seen: ModelInput | undefined;
  const run = createWorker(
    db,
    new LocalStorage(),
    {
      async generate(input) {
        seen = input;
        return {};
      },
    },
    30,
  );
  await run('job');
  assert.ok(seen);
  assert.deepEqual(seen.preferences, {
    sentenceLength: 24,
    splitHints: '赤い線ごと',
    audioGuidance: false,
  });
  assert.equal(seen.displayMode, 'photo_only');
  assert.deepEqual(seen.confirmedGuidance, ['ゆっくり']);
  assert.deepEqual(seen.improvement, {
    sourceSteps: [{ order: 1, text: '折る', imageAltText: '写真', visibleCaution: '' }],
    supportSummaries: ['確認された要約'],
  });
  assert.deepEqual(seen.corrections, [
    {
      changes: [{ field: 'text', before: '前', after: '後' }],
      referenceNote: { editSummary: '編集', nextDraftHint: '確認', reviewFlags: [] },
    },
  ]);
  const raw = JSON.stringify(seen);
  assert.equal(raw.includes('history'), false);
  for (const value of [
    'PRIVATE NAME',
    'changed later',
    'private preference',
    'private staff note',
    'private-asset-id',
    'record',
  ])
    assert.equal(raw.includes(value), false);
  assert.equal(db.get('generationJobs', 'job')?.status, 'failed');
  assert.deepEqual(db.get('releases', 'release'), old);
  assert.equal(db.all('assignments').length, 0);
});

test('Vertex adapter reprojects improvement fields to its allowlist', async () => {
  let sent: any;
  const model = new VertexVideoModel('private-bucket', async (request) => {
    sent = request;
    return {};
  });
  await model.generate({
    videoUri: 'source/demo/task/video.mp4',
    title: '作業',
    completionCriteria: '',
    preferences: { sentenceLength: 40, splitHints: '', audioGuidance: false },
    displayMode: 'photo_text',
    confirmedGuidance: [],
    durationMs: 12000,
    improvement: {
      sourceSteps: [
        {
          order: 1,
          text: '折る',
          imageAltText: '写真',
          visibleCaution: '',
          privateValue: 'secret',
        } as any,
      ],
      supportSummaries: ['要約'],
    },
    privateValue: 'secret',
  } as any);
  assert.equal(JSON.stringify(sent).includes('secret'), false);
  assert.deepEqual(sent.improvement.supportSummaries, ['要約']);
});

test('a legacy improvement snapshot without captured preferences fails before model invocation', async () => {
  const db = setup();
  const job = db.get('generationJobs', 'job')!;
  const { preferences, ...legacySnapshot } = job.inputSnapshot;
  db.put('generationJobs', { ...job, inputSnapshot: legacySnapshot });
  let called = false;
  await createWorker(
    db,
    new LocalStorage(),
    {
      async generate() {
        called = true;
        return {};
      },
    },
    30,
  )('job');
  assert.equal(called, false);
  assert.equal(db.get('generationJobs', 'job')!.status, 'failed');
});
