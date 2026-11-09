import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../apps/api/src/app.ts';
import { MemoryRepository, seed, doc, type Storage } from '../apps/api/src/adapters.ts';
import { createVertexTtsTransport, VertexTtsAdapter } from '../apps/api/src/tts.ts';

function harness(fail = false, audioGuidance = true) {
  const db = new MemoryRepository();
  seed(db);
  const data = new Map<string, Buffer>();
  const storage: Storage = {
    async put(path, bytes) {
      data.set(path, Buffer.from(bytes));
    },
    async get(path) {
      return Buffer.from(data.get(path)!);
    },
    async open(path) {
      return new Response(new Uint8Array(await this.get(path))).body!;
    },
    async copy(from, to) {
      await this.put(to, await this.get(from));
    },
  };
  const calls: string[] = [];
  const tts = new VertexTtsAdapter(
    'gemini-2.5-flash-tts',
    createVertexTtsTransport(
      { GOOGLE_CLOUD_PROJECT: 'p', TTS_LOCATION: 'us-central1' },
      async () => ({
        models: {
          async generateContent(input) {
            calls.push(String(input.contents));
            if (fail)
              return {
                candidates: [
                  {
                    finishReason: 'STOP',
                    content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: 'AAAA' } }] },
                  },
                ],
              };
            return {
              candidates: [
                {
                  finishReason: 'STOP',
                  content: {
                    parts: [
                      {
                        inlineData: {
                          mimeType: 'audio/L16;rate=24000',
                          data: Buffer.alloc(480, 2).toString('base64'),
                        },
                      },
                    ],
                  },
                },
              ],
            };
          },
        },
      }),
    ),
  );
  const { app } = createApp({ db, storage, tts });
  const step = {
    stepId: 's',
    text: 'タオルを折る',
    imageAssetId: 'image',
    imageAltText: 'タオル',
    visibleCaution: '',
    sourceStartMs: 0,
    sourceEndMs: 1000,
    frameMs: 500,
    verifiedObservation: '',
    verifiedSpeech: '',
    coaching: '',
    completionCheck: '',
  };
  db.put('tasks', doc('demo', { id: 'task', videoAssetId: 'video' }));
  db.put(
    'assets',
    doc('demo', {
      id: 'video',
      kind: 'video',
      durationMs: 1000,
      objectPath: 'video',
      mimeType: 'video/mp4',
    }),
  );
  db.put(
    'assets',
    doc('demo', {
      id: 'image',
      kind: 'image',
      draftId: 'draft',
      sourceVideoId: 'video',
      frameMs: 500,
      objectPath: 'image',
      mimeType: 'image/jpeg',
    }),
  );
  data.set('image', Buffer.from('image'));
  db.put(
    'drafts',
    doc('demo', {
      id: 'draft',
      taskId: 'task',
      learnerId: 'a',
      status: 'editing',
      revision: 1,
      audioGuidance,
      editedSteps: [step],
      aiProposal: { reviewFlags: [], steps: [] },
      reviewChecks: {
        presentationConfirmed: true,
        flagResolution: '',
        steps: { s: { videoVerified: true, photoTextVerified: true } },
      },
    }),
  );
  async function request(path: string, method = 'GET', body?: unknown, token = 'staff') {
    return app.fetch(
      new Request(`http://localhost/api/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }
  return { db, calls, request };
}

test('確認済み短文のみ合成し、並行再送でも1版に確定して固定版の本人だけに配信する', async () => {
  const h = harness();
  const payload = { expectedRevision: 1, approvalRequestId: 'same-request' };
  const before = h.db.get('drafts', 'draft')!;
  h.db.put('drafts', {
    ...before,
    reviewChecks: { ...before.reviewChecks, presentationConfirmed: false },
  });
  assert.equal((await h.request('/drafts/draft/approve', 'POST', payload)).status, 422);
  assert.deepEqual(h.calls, []);
  h.db.put('drafts', before);
  const responses = await Promise.all([
    h.request('/drafts/draft/approve', 'POST', payload),
    h.request('/drafts/draft/approve', 'POST', payload),
  ]);
  const bodies = await Promise.all(responses.map((r) => r.json()));
  assert.ok(responses.every((r) => r.status === 200));
  assert.equal(bodies[0].releaseId, bodies[1].releaseId);
  assert.ok(h.calls.length >= 1 && h.calls.every((text) => text === 'タオルを折る'));
  assert.equal(h.db.all('releases').length, 1);
  assert.equal(h.db.all('assets').filter((a) => a.kind === 'audio').length, 1);
  const release = h.db.get('releases', bodies[0].releaseId)!;
  const audioId = release.learnerSteps[0].audioAssetId;
  assert.equal(h.db.get('assets', audioId)!.releaseId, release.id);
  assert.equal(
    (await h.request('/assignments/a/task', 'PUT', { releaseId: release.id })).status,
    200,
  );
  const session = await h.request(
    '/me/sessions',
    'POST',
    { taskId: 'task', clientRequestId: 'start' },
    'learner-a',
  );
  assert.equal((await session.json()).steps[0].audioAssetId, audioId);
  const own = await h.request(`/assets/${audioId}`, 'GET', undefined, 'learner-a');
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('content-type'), 'audio/wav');
  assert.equal(Buffer.from(await own.arrayBuffer()).toString('ascii', 0, 4), 'RIFF');
  assert.equal((await h.request(`/assets/${audioId}`, 'GET', undefined, 'learner-b')).status, 403);
});

test('不正音声は承認を失敗させ、音声不要の版では呼び出さない', async () => {
  const bad = harness(true);
  assert.equal(
    (
      await bad.request('/drafts/draft/approve', 'POST', {
        expectedRevision: 1,
        approvalRequestId: 'id',
      })
    ).status,
    502,
  );
  assert.equal(bad.db.all('releases').length, 0);
  assert.equal(bad.db.all('assets').filter((a) => a.kind === 'audio').length, 0);
  const silent = harness(true, false);
  assert.equal(
    (
      await silent.request('/drafts/draft/approve', 'POST', {
        expectedRevision: 1,
        approvalRequestId: 'id',
      })
    ).status,
    200,
  );
  assert.deepEqual(silent.calls, []);
  assert.equal(silent.db.all('assets').filter((a) => a.kind === 'audio').length, 0);
});
