import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createSpeechTranscriber,
  configuredSpeech,
  FakeSpeechTranscriber,
  fakeTranscript,
  GoogleSpeechTranscriber,
  normalizeSpeechAudio,
  type SpeechTransport,
} from '../apps/api/src/speech.ts';
const exec = promisify(execFile);

const config = {
  SPEECH_PROVIDER: 'google',
  GOOGLE_CLOUD_PROJECT: 'test-project',
  SPEECH_LOCATION: 'us',
};

// Build a real WAV with ffmpeg so normalizeSpeechAudio is exercised end to end.
// 8 kHz mono keeps long inputs well under the 5 MB request limit.
async function wav(seconds: number, input = 'anullsrc=r=8000:cl=mono'): Promise<Buffer> {
  const { stdout } = await exec(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      input,
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

function transportReturning(data: unknown, seen: { value?: any } = {}): SpeechTransport {
  return {
    async request(options) {
      seen.value = options;
      return { data };
    },
  };
}

test('未知のproviderを拒否し、既定はfakeにする', async () => {
  assert.ok(createSpeechTranscriber({}) instanceof FakeSpeechTranscriber);
  assert.ok(createSpeechTranscriber({ SPEECH_PROVIDER: 'fake' }) instanceof FakeSpeechTranscriber);
  assert.ok(configuredSpeech({}) instanceof FakeSpeechTranscriber);
  for (const provider of ['', 'azure', 'GOOGLE', 'vertex-ai', ' Fake']) {
    assert.throws(() => createSpeechTranscriber({ SPEECH_PROVIDER: provider }), {
      message: 'INVALID_SPEECH_PROVIDER',
    });
  }
  for (const provider of ['google', 'vertex'])
    assert.ok(
      createSpeechTranscriber({ ...config, SPEECH_PROVIDER: provider }) instanceof
        GoogleSpeechTranscriber,
    );
});

test('fakeはffmpeg無しでも固定の日本語を返し、空音声を拒否する', async () => {
  const transcriber = new FakeSpeechTranscriber();
  assert.equal(await transcriber.transcribe(Buffer.from('RIFFxxxxWAVE')), fakeTranscript);
  assert.ok(fakeTranscript.length > 0);
  await assert.rejects(transcriber.transcribe(Buffer.alloc(0)), { message: 'INVALID_AUDIO' });
});

test('Recognizeへ仕様どおりのURL・body・タイムアウトを送る', async () => {
  const seen: { value?: any } = {};
  const wavBytes = Buffer.from('fake-wav-bytes');
  const transcriber = new GoogleSpeechTranscriber(
    config,
    transportReturning({ results: [{ alternatives: [{ transcript: 'はしをそろえた' }] }] }, seen),
  );
  assert.equal(await transcriber.transcribe(wavBytes), 'はしをそろえた');
  assert.equal(
    seen.value.url,
    'https://us-speech.googleapis.com/v2/projects/test-project/locations/us/recognizers/_:recognize',
  );
  assert.equal(seen.value.method, 'POST');
  assert.equal(seen.value.timeout, 30000);
  assert.deepEqual(seen.value.headers, { 'content-type': 'application/json' });
  assert.deepEqual(JSON.parse(seen.value.data), {
    config: { autoDecodingConfig: {}, languageCodes: ['ja-JP'], model: 'chirp_3' },
    content: wavBytes.toString('base64'),
  });
});

test('モデル・言語・リージョン・recognizerを環境変数で切り替える', async () => {
  const seen: { value?: any } = {};
  const transcriber = new GoogleSpeechTranscriber(
    {
      ...config,
      SPEECH_LOCATION: 'eu',
      SPEECH_MODEL: 'latest_long',
      SPEECH_LANGUAGE: 'en-US',
      SPEECH_RECOGNIZER: 'my-recognizer',
    },
    transportReturning({ results: [] }, seen),
  );
  await assert.rejects(transcriber.transcribe(Buffer.from('wav')), {
    message: 'SPEECH_NO_TRANSCRIPT',
  });
  assert.equal(
    seen.value.url,
    'https://eu-speech.googleapis.com/v2/projects/test-project/locations/eu/recognizers/my-recognizer:recognize',
  );
  assert.deepEqual(JSON.parse(seen.value.data).config, {
    autoDecodingConfig: {},
    languageCodes: ['en-US'],
    model: 'latest_long',
  });
});

test('chirp_3のGAリージョンはus/euのみ許可する', async () => {
  for (const location of ['us-central1', 'asia-northeast1', 'us/../x', 'US', '']) {
    await assert.rejects(
      new GoogleSpeechTranscriber(
        { ...config, SPEECH_LOCATION: location },
        transportReturning({}),
      ).transcribe(Buffer.from('wav')),
      { message: location ? 'SPEECH_INVALID_CONFIG' : 'SPEECH_NOT_CONFIGURED' },
    );
  }
  for (const location of ['us', 'eu']) {
    const transcriber = new GoogleSpeechTranscriber(
      { ...config, SPEECH_LOCATION: location },
      transportReturning({ results: [{ alternatives: [{ transcript: 'はい' }] }] }),
    );
    assert.equal(await transcriber.transcribe(Buffer.from('wav')), 'はい');
  }
});

test('data loggingを有効化するパラメータを送らない', async () => {
  const seen: { value?: any } = {};
  const transcriber = new GoogleSpeechTranscriber(
    config,
    transportReturning({ results: [{ alternatives: [{ transcript: 'はい' }] }] }, seen),
  );
  await transcriber.transcribe(Buffer.from('wav'));
  const body = JSON.parse(seen.value.data);
  assert.deepEqual(Object.keys(body).sort(), ['config', 'content']);
  assert.deepEqual(Object.keys(body.config).sort(), [
    'autoDecodingConfig',
    'languageCodes',
    'model',
  ]);
  assert.ok(!JSON.stringify(body).includes('logging'));
});

test('設定不足は送信せずSPEECH_NOT_CONFIGUREDにする', async () => {
  let calls = 0;
  const transport: SpeechTransport = {
    async request() {
      calls++;
      return { data: {} };
    },
  };
  for (const env of [
    { SPEECH_PROVIDER: 'google', SPEECH_LOCATION: 'us' },
    { SPEECH_PROVIDER: 'google', GOOGLE_CLOUD_PROJECT: 'p' },
  ])
    await assert.rejects(new GoogleSpeechTranscriber(env, transport).transcribe(Buffer.from('w')), {
      message: 'SPEECH_NOT_CONFIGURED',
    });
  for (const env of [
    {
      SPEECH_PROVIDER: 'google',
      GOOGLE_CLOUD_PROJECT: 'p',
      SPEECH_LOCATION: 'us',
      SPEECH_MODEL: 'a b',
    },
    {
      SPEECH_PROVIDER: 'google',
      GOOGLE_CLOUD_PROJECT: 'p',
      SPEECH_LOCATION: 'us',
      SPEECH_LANGUAGE: 'ja_JP!',
    },
  ])
    await assert.rejects(new GoogleSpeechTranscriber(env, transport).transcribe(Buffer.from('w')), {
      message: 'SPEECH_INVALID_CONFIG',
    });
  assert.equal(calls, 0);
});

test('resultsを連結し、空・不正応答・HTTPエラー・タイムアウトはエラーにする', async () => {
  const wavBytes = Buffer.from('wav');
  const joined = new GoogleSpeechTranscriber(
    config,
    transportReturning({
      results: [
        { alternatives: [{ transcript: 'はしが' }, { transcript: '無視する' }] },
        { alternatives: [{ transcript: 'そろわない' }] },
        { alternatives: [{}] },
      ],
    }),
  );
  assert.equal(await joined.transcribe(wavBytes), 'はしがそろわない');

  for (const data of [
    {},
    { results: [] },
    { results: [{ alternatives: [] }] },
    { results: [{ alternatives: [{ transcript: '' }] }] },
    { results: [{ alternatives: [{ transcript: '   ' }] }] },
    { results: [{ alternatives: [{ transcript: 'あ'.repeat(2001) }] }] },
  ]) {
    const transcriber = new GoogleSpeechTranscriber(config, transportReturning(data));
    await assert.rejects(
      transcriber.transcribe(wavBytes),
      /SPEECH_(NO_TRANSCRIPT|TRANSCRIPT_TOO_LONG)/,
    );
  }
  // 2000文字ちょうどは許可する。
  const boundary = new GoogleSpeechTranscriber(
    config,
    transportReturning({ results: [{ alternatives: [{ transcript: 'あ'.repeat(2000) }] }] }),
  );
  assert.equal((await boundary.transcribe(wavBytes)).length, 2000);

  for (const data of [
    { results: 'bad' },
    { results: [{}] },
    { results: [{ alternatives: [{ transcript: 1 }] }] },
  ])
    await assert.rejects(
      new GoogleSpeechTranscriber(config, transportReturning(data)).transcribe(wavBytes),
      { message: 'SPEECH_REQUEST_FAILED' },
    );

  const failing: SpeechTransport = {
    async request() {
      throw Object.assign(Error('HTTP 400 body=secret-audio'), { response: { status: 400 } });
    },
  };
  const failure = await new GoogleSpeechTranscriber(config, failing)
    .transcribe(wavBytes)
    .catch((e) => e);
  assert.equal(failure.message, 'SPEECH_REQUEST_FAILED');
  assert.ok(!failure.message.includes('secret-audio'));

  const timeout: SpeechTransport = {
    async request() {
      throw Object.assign(Error('timeout'), { code: 'ETIMEDOUT' });
    },
  };
  await assert.rejects(new GoogleSpeechTranscriber(config, timeout).transcribe(wavBytes), {
    message: 'SPEECH_REQUEST_FAILED',
  });
});

function chunkOffset(wavBytes: Buffer, id: string): number {
  let offset = 12;
  while (offset + 8 <= wavBytes.length) {
    const size = wavBytes.readUInt32LE(offset + 4);
    if (wavBytes.toString('ascii', offset, offset + 4) === id) return offset;
    if (size === 0xffffffff) break;
    offset += 8 + size + (size % 2);
  }
  throw Error(`missing chunk ${id}`);
}

test('normalizeSpeechAudioは16kHz mono 16bitのWAVへ変換する', async () => {
  const input = await wav(6);
  const normalized = await normalizeSpeechAudio(input);
  assert.equal(normalized.toString('ascii', 0, 4), 'RIFF');
  assert.equal(normalized.toString('ascii', 8, 12), 'WAVE');
  const formatOffset = chunkOffset(normalized, 'fmt ');
  assert.equal(normalized.readUInt16LE(formatOffset + 8), 1); // PCM
  assert.equal(normalized.readUInt16LE(formatOffset + 10), 1); // mono
  assert.equal(normalized.readUInt32LE(formatOffset + 12), 16000);
  assert.equal(normalized.readUInt16LE(formatOffset + 22), 16);
  const dataOffset = chunkOffset(normalized, 'data');
  // ffmpeg on a pipe writes 0xFFFFFFFF placeholders; the payload is the rest of the buffer.
  const declared = normalized.readUInt32LE(dataOffset + 4);
  const dataSize = declared === 0xffffffff ? normalized.length - dataOffset - 8 : declared;
  const durationMs = (dataSize / 2 / 16000) * 1000;
  assert.ok(durationMs >= 5000 && durationMs <= 6100, String(durationMs));
  assert.ok(normalized.length < 5 * 1024 * 1024);
});

test('normalizeSpeechAudioは短すぎる・壊れた・大きすぎる音声を拒否する', async () => {
  await assert.rejects(normalizeSpeechAudio(await wav(3)), { message: 'AUDIO_TOO_SHORT' });
  await assert.rejects(normalizeSpeechAudio(Buffer.alloc(0)), { message: 'INVALID_AUDIO' });
  await assert.rejects(normalizeSpeechAudio(Buffer.from('not audio at all')), {
    message: 'INVALID_AUDIO',
  });
  await assert.rejects(normalizeSpeechAudio(Buffer.alloc(5 * 1024 * 1024 + 1)), {
    message: 'AUDIO_TOO_LARGE',
  });
});

test('normalizeSpeechAudioは60秒を超える音声を拒否する', async () => {
  const long = await wav(70);
  await assert.rejects(normalizeSpeechAudio(long), { message: 'AUDIO_TOO_LONG' });
});

test('60秒ちょうどは許可し、60.5秒はAUDIO_TOO_LONGで拒否する', async () => {
  const exact = await normalizeSpeechAudio(await wav(60));
  const dataOffset = chunkOffset(exact, 'data');
  const declared = exact.readUInt32LE(dataOffset + 4);
  const dataSize = declared === 0xffffffff ? exact.length - dataOffset - 8 : declared;
  const durationMs = (dataSize / 2 / 16000) * 1000;
  assert.ok(durationMs >= 60000 && durationMs <= 60100, String(durationMs));
  await assert.rejects(normalizeSpeechAudio(await wav(60.5)), { message: 'AUDIO_TOO_LONG' });
});
