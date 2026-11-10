import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../apps/api/src/app.ts';
import { MemoryRepository, seed, doc, type Storage } from '../apps/api/src/adapters.ts';
import { FakeTtsAdapter } from '../apps/api/src/tts.ts';
import {
  FakeSpeechTranscriber,
  fakeTranscript,
  type SpeechTranscriber,
} from '../apps/api/src/speech.ts';
import { supportTranscriptionResponseSchema } from '../packages/shared/src/support.ts';
const exec = promisify(execFile);

const recordText = {
  observedDifficulty: 'はしを持つ手元が定まらない',
  assistanceGiven: '赤い線に合わせる声かけをした',
  improvementSuggestion: '線を太くする',
};

async function wav(seconds: number): Promise<Buffer> {
  const { stdout } = await exec(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=8000:cl=mono',
      '-t',
      String(seconds),
      '-ac',
      '1',
      '-ar',
      '8000',
      '-f',
      'wav',
      '-acodec',
      'pcm_s16le',
      'pipe:1',
    ],
    { maxBuffer: 40 * 1024 * 1024, encoding: 'buffer' },
  );
  return Buffer.from(stdout);
}

async function harness(speech?: SpeechTranscriber) {
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
  db.put('members', doc('demo', { id: 'staff-2', uid: 'staff-2', role: 'staff' }));
  const { app } = createApp({ db, storage, tts: new FakeTtsAdapter(), speech });
  const step = {
    stepId: 's1',
    sourceStartMs: 0,
    sourceEndMs: 1000,
    frameMs: 500,
    imageAssetId: 'image',
    text: 'タオルを折ります',
    visibleCaution: '端を見ます',
    verifiedObservation: '両端が見える',
    verifiedSpeech: '端をそろえて',
    coaching: 'ゆっくり待つ',
    completionCheck: '端がそろう',
  };
  db.put('tasks', doc('demo', { id: 'task', videoAssetId: 'video' }));
  db.put('assets', doc('demo', { id: 'video', kind: 'video', durationMs: 1000 }));
  db.put(
    'assets',
    doc('demo', {
      id: 'image',
      kind: 'image',
      draftId: 'draft',
      sourceVideoId: 'video',
      frameMs: 500,
      objectPath: 'draft/image.jpg',
      mimeType: 'image/jpeg',
    }),
  );
  db.put(
    'drafts',
    doc('demo', {
      id: 'draft',
      taskId: 'task',
      learnerId: 'a',
      status: 'editing',
      revision: 1,
      editedSteps: [step],
      aiProposal: { reviewFlags: [], steps: [] },
      reviewChecks: {
        presentationConfirmed: true,
        flagResolution: '',
        steps: { s1: { videoVerified: true, photoTextVerified: true } },
      },
    }),
  );
  await storage.put('draft/image.jpg', Buffer.from('synthetic original image'));
  async function request(
    path: string,
    method = 'GET',
    body?: unknown,
    token = 'staff',
    status: number | number[] = 200,
  ) {
    const response = await app.fetch(
      new Request(`http://localhost/api/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    assert.ok(
      (Array.isArray(status) ? status : [status]).includes(response.status),
      await response.clone().text(),
    );
    return response.json();
  }
  async function audio(
    path: string,
    bytes: Buffer,
    token = 'staff',
    status: number | number[] = 200,
    contentType = 'audio/wav',
  ) {
    const response = await app.fetch(
      new Request(`http://localhost/api/v1${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
        body: new Uint8Array(bytes),
      }),
    );
    assert.ok(
      (Array.isArray(status) ? status : [status]).includes(response.status),
      await response.clone().text(),
    );
    return response.json();
  }
  const approve = (approvalRequestId = 'first') =>
    request('/drafts/draft/approve', 'POST', { expectedRevision: 1, approvalRequestId });
  await request('/assignments/a/task', 'PUT', { releaseId: (await approve()).releaseId });
  async function support(kind = 'help') {
    const session = await request(
      '/me/sessions',
      'POST',
      { taskId: 'task', clientRequestId: crypto.randomUUID() },
      'learner-a',
    );
    await request(
      `/me/sessions/${session.sessionId}/events`,
      'POST',
      { clientEventId: crypto.randomUUID(), expectedRevision: session.revision, type: kind },
      'learner-a',
    );
    return db.all('supportRequests').find((q) => q.sessionId === session.sessionId)!;
  }
  const path = (requestId: string) => `/support-requests/${requestId}/record/transcriptions`;
  return { db, request, audio, support, path, storage };
}

test('職員が進行中のhelpに音声を送ると文字起こしだけを返し、記録を保存しない', async () => {
  const h = await harness();
  const q = await h.support();
  h.db.put('supportRequests', { ...h.db.get('supportRequests', q.id)!, status: 'in_progress' });
  const recordsBefore = h.db.all('supportRecords').length;
  const body = supportTranscriptionResponseSchema.parse(await h.audio(h.path(q.id), await wav(6)));
  assert.deepEqual(body, { schemaVersion: '1', transcript: fakeTranscript });
  assert.equal(h.db.all('supportRecords').length, recordsBefore);
  assert.equal(h.db.get('supportRequests', q.id)!.status, 'in_progress');
  // 音声はStorageへ保存しない。
  assert.equal(h.db.all('supportRecords').length, 0);
});

test('acknowledgedのhelpでも文字起こしでき、応答に音声やbase64を含めない', async () => {
  const h = await harness();
  const q = await h.support();
  h.db.put('supportRequests', { ...h.db.get('supportRequests', q.id)!, status: 'acknowledged' });
  const input = await wav(6);
  const body = await h.audio(h.path(q.id), input);
  assert.equal(body.transcript, fakeTranscript);
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes(input.subarray(0, 16).toString('base64')));
  assert.ok(!serialized.includes('RIFF'));
  assert.deepEqual(Object.keys(body).sort(), ['schemaVersion', 'transcript']);
});

test('文字起こしは支援要求の状態・revision・承認時刻を変えない', async () => {
  const h = await harness();
  const q = await h.support();
  // 開始・確認済みの状態を用意し、承認時刻も入れておく。
  h.db.put('supportRequests', {
    ...h.db.get('supportRequests', q.id)!,
    status: 'acknowledged',
    startedBy: 'staff',
    startedAt: '2026-01-01T00:00:00.000Z',
    acknowledgedAt: '2026-01-01T00:05:00.000Z',
    revision: 3,
  });
  const before = { ...h.db.get('supportRequests', q.id)! };
  const sessionsBefore = JSON.stringify(h.db.all('sessions'));
  const eventsBefore = JSON.stringify(h.db.all('sessionEvents'));
  assert.equal((await h.audio(h.path(q.id), await wav(6))).transcript, fakeTranscript);
  const after = h.db.get('supportRequests', q.id)!;
  // 保存・承認・再開を実行しない: 文書全体が呼び出し前と同一である。
  assert.deepEqual(after, before);
  assert.equal(after.status, 'acknowledged');
  assert.equal(after.revision, 3);
  assert.equal(after.acknowledgedAt, '2026-01-01T00:05:00.000Z');
  assert.equal(after.startedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(JSON.stringify(h.db.all('sessions')), sessionsBefore);
  assert.equal(JSON.stringify(h.db.all('sessionEvents')), eventsBefore);
  assert.equal(h.db.all('supportRecords').length, 0);
});

test('本人・新人・別org職員・存在しない要求を拒否する', async () => {
  const h = await harness();
  const q = await h.support();
  h.db.put('supportRequests', { ...h.db.get('supportRequests', q.id)!, status: 'in_progress' });
  const bytes = await wav(6);
  for (const token of ['learner-a', 'learner-b', 'newcomer', 'other-staff'])
    await h.audio(h.path(q.id), bytes, token, 403);
  await h.audio(h.path(q.id), bytes, 'unknown', 401);
  await h.audio(h.path('missing'), bytes, 'staff', 404);
  assert.equal(h.db.all('supportRecords').length, 0);
});

test('open・assigned・stopの要求は409 INVALID_STATEにする', async () => {
  const h = await harness();
  const bytes = await wav(6);
  const open = await h.support();
  await h.audio(h.path(open.id), bytes, 'staff', 409);
  const assigned = await h.support();
  h.db.put('supportRequests', { ...h.db.get('supportRequests', assigned.id)!, status: 'assigned' });
  await h.audio(h.path(assigned.id), bytes, 'staff', 409);
  const stop = await h.support('stop');
  h.db.put('supportRequests', { ...h.db.get('supportRequests', stop.id)!, status: 'in_progress' });
  await h.audio(h.path(stop.id), bytes, 'staff', 409);
  // 状態検査は音声の受信前に行う: 壊れた音声でも409が優先される。
  await h.audio(h.path(open.id), Buffer.from('broken'), 'staff', 409);
});

test('JSON・5MB超・短すぎる・長すぎる・壊れた音声を422で拒否する', async () => {
  const h = await harness();
  const q = await h.support();
  h.db.put('supportRequests', { ...h.db.get('supportRequests', q.id)!, status: 'in_progress' });
  const json = await h.request(h.path(q.id), 'POST', { audio: 'x' }, 'staff', 422);
  assert.equal(json.error.code, 'CONTENT_TYPE');
  const large = await h.audio(h.path(q.id), Buffer.alloc(5 * 1024 * 1024 + 1), 'staff', 422);
  assert.equal(large.error.code, 'AUDIO_TOO_LARGE');
  const short = await h.audio(h.path(q.id), await wav(3), 'staff', 422);
  assert.equal(short.error.code, 'AUDIO_TOO_SHORT');
  const long = await h.audio(h.path(q.id), await wav(70), 'staff', 422);
  assert.equal(long.error.code, 'AUDIO_TOO_LONG');
  const broken = await h.audio(h.path(q.id), Buffer.from('not a wav file'), 'staff', 422);
  assert.equal(broken.error.code, 'INVALID_AUDIO');
  const empty = await h.audio(h.path(q.id), Buffer.alloc(0), 'staff', 422);
  assert.equal(empty.error.code, 'INVALID_AUDIO');
  assert.equal(h.db.all('supportRecords').length, 0);
});

test('文字起こしの失敗は502で、保存済みの記録を変えない', async () => {
  const failing: SpeechTranscriber = {
    async transcribe() {
      throw Error('SPEECH_REQUEST_FAILED');
    },
  };
  const h = await harness(failing);
  const q = await h.support();
  h.db.put('supportRequests', { ...h.db.get('supportRequests', q.id)!, status: 'in_progress' });
  const saved = await h.request(`/support-requests/${q.id}/record`, 'PUT', {
    expectedRevision: 0,
    ...recordText,
  });
  const failed = await h.audio(h.path(q.id), await wav(6), 'staff', 502);
  assert.equal(failed.error.code, 'SPEECH_REQUEST_FAILED');
  assert.equal(failed.error.message, '操作を確認してください');
  assert.deepEqual(await h.request(`/support-requests/${q.id}/record`), saved);
  assert.equal(h.db.get('supportRecords', q.id)!.revision, 1);
  // 既存のrevision競合検査は変わらない。
  await h.request(
    `/support-requests/${q.id}/record`,
    'PUT',
    { expectedRevision: 0, ...recordText },
    'staff',
    409,
  );
});

test('未知の例外は502にまとめ、内部情報を応答へ出さない', async () => {
  const leaking: SpeechTranscriber = {
    async transcribe() {
      throw Error('/tmp/t055-speech-abc/input: ffmpeg stderr secret-audio');
    },
  };
  const h = await harness(leaking);
  const q = await h.support();
  h.db.put('supportRequests', { ...h.db.get('supportRequests', q.id)!, status: 'in_progress' });
  const body = await h.audio(h.path(q.id), await wav(6), 'staff', 502);
  assert.equal(body.error.code, 'SPEECH_REQUEST_FAILED');
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes('secret-audio'));
  assert.ok(!serialized.includes('/tmp/'));
  assert.ok(!serialized.includes('ffmpeg'));
});

test('SPEECH_NOT_CONFIGURED・SPEECH_NO_TRANSCRIPT・長すぎる結果は502にする', async () => {
  for (const code of [
    'SPEECH_NOT_CONFIGURED',
    'SPEECH_NO_TRANSCRIPT',
    'SPEECH_TRANSCRIPT_TOO_LONG',
  ]) {
    const failing: SpeechTranscriber = {
      async transcribe() {
        throw Error(code);
      },
    };
    const h = await harness(failing);
    const q = await h.support();
    h.db.put('supportRequests', { ...h.db.get('supportRequests', q.id)!, status: 'in_progress' });
    const body = await h.audio(h.path(q.id), await wav(6), 'staff', 502);
    assert.equal(body.error.code, code);
  }
});

test('音声のContent-TypeでもGETなど他メソッドの既存挙動は変わらない', async () => {
  const h = await harness();
  const q = await h.support();
  h.db.put('supportRequests', { ...h.db.get('supportRequests', q.id)!, status: 'in_progress' });
  const response = await h.request(
    `/support-requests/${q.id}/record`,
    'GET',
    undefined,
    'staff',
    404,
  );
  assert.equal(response.error.code, 'NOT_FOUND');
  // JSON以外の未知のContent-Typeは従来どおり拒否する。
  const rejected = await h.audio(h.path(q.id), await wav(6), 'staff', 422, 'audio/mpeg');
  assert.equal(rejected.error.code, 'CONTENT_TYPE');
});

test('既定のtranscriberはfakeで、SPEECH_PROVIDER未設定でも動く', async () => {
  const h = await harness(new FakeSpeechTranscriber());
  const q = await h.support();
  h.db.put('supportRequests', { ...h.db.get('supportRequests', q.id)!, status: 'in_progress' });
  const body = await h.audio(h.path(q.id), await wav(6));
  assert.equal(body.transcript, fakeTranscript);
});
