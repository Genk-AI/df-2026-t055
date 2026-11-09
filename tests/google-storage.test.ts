import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { CloudStorage, configuredStorage } from '../apps/api/src/cloud-storage.ts';
import { GoogleStorageClient, type StorageTransport } from '../apps/api/src/google-storage.ts';

const exact = '9007199254740993';
test('Google Storage sends exact generation strings and atomic conditions', async () => {
  const requests: Array<{ url: string; method: string; data?: unknown }> = [];
  const transport: StorageTransport = {
    async request(options) {
      requests.push(options);
      return {
        data:
          options.method === 'GET' ? Readable.from([Buffer.from('audio')]) : { generation: exact },
      };
    },
  };
  const storage = new CloudStorage(
    new GoogleStorageClient('test-project', transport),
    'private-bucket',
  );
  const from = 'draft/org/item/audio.mp3';
  const to = 'approved/org/item/audio.mp3';
  assert.equal(await storage.put(from, Buffer.from('audio')), exact);
  assert.equal((await storage.get(from, exact)).toString(), 'audio');
  assert.equal(await storage.copy(from, to, exact), exact);
  const upload = new URL(requests[0].url);
  assert.equal(upload.searchParams.get('name'), from);
  assert.equal(upload.searchParams.get('ifGenerationMatch'), '0');
  assert.deepEqual(requests[0].data, Buffer.from('audio'));
  const read = new URL(requests[1].url);
  assert.equal(read.searchParams.get('ifGenerationMatch'), exact);
  assert.equal(read.searchParams.get('alt'), 'media');
  assert.match(read.pathname, /draft%2Forg%2Fitem%2Faudio.mp3$/);
  const copy = new URL(requests[2].url);
  assert.equal(copy.searchParams.get('ifSourceGenerationMatch'), exact);
  assert.equal(copy.searchParams.get('ifGenerationMatch'), '0');
  assert.match(
    copy.pathname,
    /draft%2Forg%2Fitem%2Faudio.mp3\/copyTo\/b\/private-bucket\/o\/approved%2Forg%2Fitem%2Faudio.mp3$/,
  );
});

test('Google Storage fails closed on precondition failure and malformed metadata', async () => {
  const errors: StorageTransport = {
    async request() {
      throw Error('secret object path');
    },
  };
  const client = new GoogleStorageClient('test-project', errors);
  await assert.rejects(
    client.open('private-bucket', 'draft/org/item/audio.mp3', { ifGenerationMatch: exact }),
    /^Error: CLOUD_STORAGE_REQUEST_FAILED$/,
  );
  await assert.rejects(
    client.copy('private-bucket', 'draft/org/item/audio.mp3', 'approved/org/item/audio.mp3', {
      ifSourceGenerationMatch: exact,
      ifGenerationMatch: '0',
    }),
    /^Error: CLOUD_STORAGE_REQUEST_FAILED$/,
  );
  const malformed: StorageTransport = {
    async request() {
      return { data: { generation: 9007199254740992 } };
    },
  };
  await assert.rejects(
    new GoogleStorageClient('test-project', malformed).put(
      'private-bucket',
      'draft/org/item/audio.mp3',
      Buffer.alloc(0),
      { ifGenerationMatch: '0' },
    ),
    /INVALID_STORAGE_GENERATION_RESPONSE/,
  );
});

test('cloud configuration creates an ADC-backed client without making a network request', () => {
  assert.ok(
    configuredStorage({
      STORAGE_BACKEND: 'cloud',
      STORAGE_BUCKET: 'private-bucket',
      GOOGLE_CLOUD_PROJECT: 'test-project',
    }) instanceof CloudStorage,
  );
  assert.throws(
    () => configuredStorage({ STORAGE_BACKEND: 'cloud', GOOGLE_CLOUD_PROJECT: 'test-project' }),
    /STORAGE_BUCKET_REQUIRED/,
  );
});
