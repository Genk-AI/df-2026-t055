// 表示名だけの本人（希望は未確認のまま）でも生成できることの回帰テスト。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTtsAdapter } from '../apps/api/src/tts.ts';
import { createApp } from '../apps/api/src/app.ts';
import { MemoryRepository, seed, type Storage } from '../apps/api/src/adapters.ts';
import { createWorker } from '../apps/generator/src/worker.ts';
import { FakeModel } from '../apps/generator/src/model.ts';

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
  const dir = await mkdtemp(join(tmpdir(), 't055-repro93-'));
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

test('表示名だけの本人でも生成できる', async () => {
  const db = new MemoryRepository();
  seed(db);
  const storage = new TestStorage();
  const run = createWorker(db, storage, new FakeModel(), 30);
  const { app } = createApp({ db, storage, tts: new FakeTtsAdapter(), globalLimit: 30 });
  const base = 'http://localhost/api/v1';
  async function request(path: string, method = 'GET', body?: unknown, token = 'staff') {
    const r = await app.fetch(
      new Request(base + path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined
          ? {}
          : { body: body instanceof FormData ? body : JSON.stringify(body) }),
      }),
    );
    return { status: r.status, data: (await r.json()) as any };
  }
  async function ok(path: string, method = 'GET', body?: unknown, token = 'staff') {
    const r = await request(path, method, body, token);
    assert.ok(r.status < 300, `${method} ${path}: ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  }
  const created = await ok('/learners', 'POST', { displayName: '架空のCさん' });
  assert.deepEqual(created.preferences, {});
  const { taskId } = await ok('/tasks', 'POST', { title: 'タオル折り' });
  const form = new FormData();
  form.append('video', new Blob([new Uint8Array(video)], { type: 'video/mp4' }), 'fixture.mp4');
  await ok(`/tasks/${taskId}/video`, 'POST', form);
  const g = await ok(`/tasks/${taskId}/generations`, 'POST', { learnerId: created.learnerId });
  await run(g.jobId);
  const job = db.get('generationJobs', g.jobId)!;
  const draft = db.get('drafts', g.draftId)!;
  console.log(`minimal-profile job=${job.status} error=${job.errorCode} draft=${draft.status}`);
  assert.equal(job.status, 'succeeded');
  assert.equal(draft.status, 'editing');
});
