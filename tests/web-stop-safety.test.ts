import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearWaiting, flushSafety, hold, readSafety, type Store } from '../apps/web/src/safety.ts';

test('offline stop keeps its event ID through reload, repeated taps and retry', async () => {
  const data = new Map<string, string>();
  const store: Store = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
  hold(store, 's', { type: 'help', clientEventId: 'help', expectedRevision: 1 });
  hold(store, 's', { type: 'stop', clientEventId: 'stop', expectedRevision: 1 });
  hold(store, 's', { type: 'stop', clientEventId: 'second', expectedRevision: 2 });
  clearWaiting(store, 's');
  assert.equal(
    await flushSafety(store, 's', {
      send: async () => {
        throw Error('offline');
      },
      load: async () => ({ status: 'active', revision: 2 }),
    }),
    false,
  );
  assert.equal(readSafety(store, 's').stopped, true);
  const sent: string[] = [];
  assert.equal(
    await flushSafety(store, 's', {
      send: async (event) => {
        sent.push(event.clientEventId);
      },
      load: async () => ({ status: 'active', revision: 2 }),
    }),
    true,
  );
  assert.deepEqual(sent, ['stop']);
  hold(store, 's', { type: 'help', clientEventId: 'late-help', expectedRevision: 2 });
  assert.deepEqual(readSafety(store, 's').pending, []);
  assert.equal(readSafety(store, 's').stopped, true);
});
