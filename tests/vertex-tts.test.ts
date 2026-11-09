import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createVertexTtsTransport,
  VertexTtsAdapter,
  configuredTts,
  FakeTtsAdapter,
} from '../apps/api/src/tts.ts';

const config = {
  GOOGLE_CLOUD_PROJECT: 'test-project',
  TTS_LOCATION: 'us-central1',
  TTS_VOICE: 'Kore',
};
function response(bytes: Buffer, mimeType = 'audio/L16;codec=pcm;rate=24000') {
  return {
    candidates: [
      {
        finishReason: 'STOP',
        content: { parts: [{ inlineData: { mimeType, data: bytes.toString('base64') } }] },
      },
    ],
  };
}

test('送信は承認短文と指定音声のみ、PCMを24kHz monoのWAVに変換する', async () => {
  const pcm = Buffer.alloc(48000, 2);
  let request: any;
  let settings: any;
  const transport = createVertexTtsTransport(config, async (value) => {
    settings = value;
    return {
      models: {
        async generateContent(input) {
          request = input;
          return response(pcm);
        },
      },
    };
  });
  const audio = await new VertexTtsAdapter('gemini-2.5-flash-tts', transport).synthesize(
    'タオルを折る',
  );
  assert.deepEqual(settings, { project: 'test-project', location: 'us-central1' });
  assert.deepEqual(request, {
    model: 'gemini-2.5-flash-tts',
    contents: 'タオルを折る',
    config: {
      httpOptions: { timeout: 30000 },
      responseModalities: ['AUDIO'],
      speechConfig: {
        languageCode: 'ja-JP',
        voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
      },
    },
  });
  assert.equal(audio.mimeType, 'audio/wav');
  assert.equal(audio.durationMs, 1000);
  assert.equal(audio.bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(audio.bytes.readUInt32LE(24), 24000);
  assert.equal(audio.bytes.readUInt16LE(22), 1);
  assert.equal(audio.bytes.readUInt16LE(34), 16);
  assert.equal(audio.bytes.readUInt32LE(40), pcm.length);
  assert.deepEqual(audio.bytes.subarray(44), pcm);
});

test('空・不正・中断・形式違いの応答とSDK失敗は音声にしない', async () => {
  const invalid = [
    null,
    {},
    { candidates: [] },
    { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] },
    response(Buffer.alloc(0)),
    response(Buffer.alloc(1)),
    response(Buffer.alloc(4), 'audio/wav'),
    response(Buffer.alloc(4), 'audio/L16;rate=16000'),
    response(Buffer.from('RIFFxx')),
    {
      candidates: [
        { content: { parts: [{ inlineData: { mimeType: 'audio/L16', data: '??==' } }] } },
      ],
    },
  ];
  for (const value of invalid) {
    const adapter = new VertexTtsAdapter(
      'gemini-2.5-flash-tts',
      createVertexTtsTransport(config, async () => ({
        models: {
          async generateContent() {
            return value;
          },
        },
      })),
    );
    await assert.rejects(adapter.synthesize('短い文'), /VERTEX_TTS_INVALID/);
  }
  const failed = new VertexTtsAdapter(
    'gemini-2.5-flash-tts',
    createVertexTtsTransport(config, async () => ({
      models: {
        async generateContent() {
          throw Error('SDK_FAILURE');
        },
      },
    })),
  );
  await assert.rejects(failed.synthesize('短い文'), /SDK_FAILURE/);
});

test('明示設定がない場合はFakeへ切り替えず、無効なモデル・文章を送らない', async () => {
  let calls = 0;
  const factory = async () => {
    calls++;
    return {
      models: {
        async generateContent() {
          return response(Buffer.alloc(4));
        },
      },
    };
  };
  assert.ok(configuredTts({}) instanceof FakeTtsAdapter);
  await assert.rejects(
    new VertexTtsAdapter('gemini-2.5-flash-tts', createVertexTtsTransport({}, factory)).synthesize(
      '短い文',
    ),
    /NOT_CONFIGURED/,
  );
  await assert.rejects(
    new VertexTtsAdapter('unknown', createVertexTtsTransport(config, factory)).synthesize('短い文'),
    /INVALID_CONFIG/,
  );
  const valid = new VertexTtsAdapter(
    'gemini-2.5-flash-tts',
    createVertexTtsTransport(config, factory),
  );
  await assert.rejects(valid.synthesize('  '), /INVALID_TTS_TEXT/);
  await assert.rejects(valid.synthesize('あ'.repeat(41)), /INVALID_TTS_TEXT/);
  assert.equal(calls, 0);
});
