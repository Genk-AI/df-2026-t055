// 生成ワーカーがモデルへ表示方法と確認済みの説明方法を渡すことの回帰テスト。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRepository, seed, doc, type Storage } from '../apps/api/src/adapters.ts';
import { createWorker } from '../apps/generator/src/worker.ts';
import type { ModelInput, VideoModel } from '../apps/generator/src/model.ts';

class TestStorage implements Storage {
  data = new Map<string, Buffer>();
  async put(p: string, b: Buffer) {
    this.data.set(p, Buffer.from(b));
  }
  async get(p: string) {
    const b = this.data.get(p);
    if (!b) throw Error('NOT_FOUND');
    return Buffer.from(b);
  }
  async open(p: string) {
    return new Response(new Uint8Array(await this.get(p))).body!;
  }
  async copy(a: string, b: string) {
    await this.put(b, await this.get(a));
  }
}

let video: Buffer;
before(async () => {
  const dir = await mkdtemp(join(tmpdir(), 't055-worker-input-'));
  try {
    const p = join(dir, 'fixture.mp4');
    await exec('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x120:rate=2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=8000',
      '-t',
      '12',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-y',
      p,
    ]);
    video = await readFile(p);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const proposal = {
  schemaVersion: '1',
  steps: [
    {
      stepId: 's1',
      startMs: 0,
      endMs: 1000,
      frameMs: 500,
      observationCandidate: '',
      speechCandidate: '声',
      instructionDraft: 'タオルを折ります',
      coachingDraft: '',
      completionCheckDraft: '',
      reviewFlags: [],
    },
  ],
  reviewFlags: [],
};

async function runOnce(options: { displayMode?: string; confirmedGuidance?: string[] }) {
  const db = new MemoryRepository();
  seed(db);
  const storage = new TestStorage();
  await storage.put('source/video.mp4', video);
  let captured: ModelInput | undefined;
  const model: VideoModel = {
    async generate(input) {
      captured = input;
      return proposal;
    },
  };
  const run = createWorker(db, storage, model, 30);
  const learner = db.get('learners', 'a')!;
  db.put('learners', { ...learner, confirmedGuidance: options.confirmedGuidance });
  db.put('tasks', doc('demo', { id: 'task', videoAssetId: 'video' }));
  db.put(
    'assets',
    doc('demo', { id: 'video', kind: 'video', durationMs: 12000, objectPath: 'source/video.mp4' }),
  );
  const draft: Record<string, unknown> = {
    id: 'draft',
    taskId: 'task',
    learnerId: 'a',
    status: 'generating',
    revision: 0,
  };
  if (options.displayMode !== undefined) draft.displayMode = options.displayMode;
  db.put('drafts', doc('demo', draft));
  db.put(
    'generationJobs',
    doc('demo', {
      id: 'job',
      taskId: 'task',
      draftId: 'draft',
      status: 'queued',
      attempt: 0,
      budgetUsed: 1,
      modelId: 'stub',
      promptVersion: '1',
    }),
  );
  await run('job');
  return { db, captured };
}

test('下書きの表示方法と本人の確認済み説明方法をモデルへ渡す', async () => {
  const { db, captured } = await runOnce({
    displayMode: 'photo_only',
    confirmedGuidance: ['赤い線を目印にする'],
  });
  assert.equal(captured?.displayMode, 'photo_only');
  assert.deepEqual(captured?.confirmedGuidance, ['赤い線を目印にする']);
  assert.equal(db.get('generationJobs', 'job')!.status, 'succeeded');
  assert.equal(db.get('drafts', 'draft')!.status, 'editing');
});

test('未設定の下書きは写真と短文・説明方法なしで生成する', async () => {
  const { captured } = await runOnce({});
  assert.equal(captured?.displayMode, 'photo_text');
  assert.deepEqual(captured?.confirmedGuidance, []);
});
