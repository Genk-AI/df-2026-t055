import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { once } from 'node:events';
import { createApp } from '../apps/api/src/app.ts';
import { FirestoreRepository } from '../apps/api/src/firestore-repository.ts';
import { doc } from '../apps/api/src/adapters.ts';
import { WatchFirestore } from './helpers/watch-firestore.ts';

async function websocket(port: number, token: string, sessionId?: string) {
  const socket = connect(port, '127.0.0.1');
  let buffer = Buffer.alloc(0),
    upgraded = false;
  const queue: any[] = [],
    waiters: ((value: any) => void)[] = [];
  const deliver = (value: any) => {
    const waiter = waiters.shift();
    if (waiter) waiter(value);
    else queue.push(value);
  };
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!upgraded) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = buffer.subarray(0, end).toString();
      assert.match(head, /101 Switching/);
      buffer = buffer.subarray(end + 4);
      upgraded = true;
      deliver('upgraded');
    }
    while (buffer.length >= 2) {
      let length = buffer[1] & 127,
        offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      }
      if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (buffer.length < offset + length) return;
      const opcode = buffer[0] & 15,
        payload = buffer.subarray(offset, offset + length);
      buffer = buffer.subarray(offset + length);
      deliver(opcode === 8 ? { close: true } : JSON.parse(payload.toString()));
    }
  });
  const next = () =>
    queue.length
      ? Promise.resolve(queue.shift())
      : new Promise<any>((resolve, reject) => {
          const timer = setTimeout(() => reject(Error('WS_TIMEOUT')), 3000);
          waiters.push((value) => {
            clearTimeout(timer);
            resolve(value);
          });
        });
  const until = async (predicate: (value: any) => boolean) => {
    for (let i = 0; i < 12; i++) {
      const value = await next();
      if (predicate(value)) return value;
    }
    throw Error('WS_NO_MATCH');
  };
  socket.write(
    `GET /api/v1/ws${sessionId ? `?sessionId=${sessionId}` : ''} HTTP/1.1\r\nHost: localhost:${port}\r\nOrigin: http://localhost:5173\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
  );
  await next();
  const payload = Buffer.from(JSON.stringify({ type: 'auth', idToken: token })),
    mask = Buffer.from([1, 2, 3, 4]);
  socket.write(
    Buffer.concat([
      Buffer.from([0x81, 0x80 | payload.length]),
      mask,
      Buffer.from(payload.map((v, i) => v ^ mask[i % 4])),
    ]),
  );
  return { socket, queue, next, until };
}
async function settle() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(predicate());
}

test(
  '別インスタンスのコミットを認可範囲で配信し、未コミット・別orgを除外して再接続と解除を行う',
  { timeout: 12000 },
  async (t) => {
    const store = new WatchFirestore(),
      a = new FirestoreRepository(store, 'demo'),
      b = new FirestoreRepository(store, 'demo'),
      otherDb = new FirestoreRepository(store, 'other');
    const q = doc('demo', {
      id: 'q',
      sessionId: 's',
      eventId: 'e',
      learnerId: 'a',
      stepId: 'one',
      kind: 'help',
      status: 'open',
      revision: 1,
    });
    await a.put(
      'sessions',
      doc('demo', {
        id: 's',
        learnerId: 'a',
        releaseId: 'r',
        status: 'waiting_help',
        stepIndex: 0,
        revision: 1,
        activeSupportRequestId: 'q',
      }),
    );
    await a.put('supportRequests', q);
    const auth = {
      async verify(token: string) {
        return token === 'staff'
          ? { uid: 'staff', role: 'staff' as const, orgId: 'demo', expiresAt: Date.now() + 60000 }
          : token === 'learner' || token === 'learner-b'
            ? {
                uid: token,
                role: 'learner' as const,
                orgId: 'demo',
                learnerId: token === 'learner' ? 'a' : 'b',
                expiresAt: Date.now() + 60000,
              }
            : {
                uid: 'other',
                role: 'staff' as const,
                orgId: 'other',
                expiresAt: Date.now() + 60000,
              };
      },
    };
    const servers = [a, b, otherDb].map((db) => createApp({ db, auth }).app.listen(0, '127.0.0.1'));
    await Promise.all(servers.map((server) => once(server, 'listening')));
    const sockets: ReturnType<typeof connect>[] = [];
    t.after(() => {
      for (const socket of sockets) socket.destroy();
      for (const server of servers) server.close();
    });
    const open = async (index: number, token: string, sessionId?: string) => {
      const client = await websocket((servers[index].address() as any).port, token, sessionId);
      sockets.push(client.socket);
      return client;
    };
    const staff = await open(1, 'staff'),
      learner = await open(1, 'learner', 's'),
      other = await open(2, 'other');
    await staff.until((x) => x.type === 'support.snapshot');
    await learner.until((x) => x.type === 'session.support.snapshot');
    await other.until((x) => x.type === 'support.snapshot');
    await waitFor(() => store.listenerCount === 4);
    await settle();
    staff.queue.length = 0;
    learner.queue.length = 0;
    other.queue.length = 0;
    const unauthorized = await open(1, 'learner-b', 's');
    assert.deepEqual(await unauthorized.until((x) => x.close), { close: true });
    assert.equal(store.listenerCount, 4);
    let commit!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
        commit = resolve;
      }),
      inTransaction = new Promise<void>((resolve) => {
        entered = resolve;
      });
    const transaction = a.transaction(async () => {
      await a.put('supportRequests', {
        ...q,
        status: 'assigned',
        assignedTo: 'staff',
        assignedAt: new Date().toISOString(),
        revision: 2,
      });
      entered();
      await gate;
    });
    await inTransaction;
    await settle();
    assert.equal(staff.queue.length, 0);
    assert.equal(learner.queue.length, 0);
    assert.equal(other.queue.length, 0);
    commit();
    await transaction;
    assert.equal(
      (await staff.until((x) => x.requests?.some((r: any) => r.revision === 2))).requests[0].status,
      'assigned',
    );
    assert.equal(
      (await learner.until((x) => x.payload?.support?.revision === 2)).payload.support.status,
      'assigned',
    );
    await settle();
    assert.equal(other.queue.length, 0);
    await a.transaction(async () => {
      const request = (await a.get('supportRequests', 'q'))!,
        session = (await a.get('sessions', 's'))!;
      const now = new Date().toISOString();
      await a.put('supportRequests', {
        ...request,
        status: 'acknowledged',
        startedBy: 'staff',
        startedAt: now,
        acknowledgedBy: 'staff',
        acknowledgedAt: now,
        revision: 3,
      });
      const { activeSupportRequestId, ...rest } = session;
      await a.put('sessions', { ...rest, status: 'active', revision: 2 });
    });
    assert.equal((await learner.until((x) => x.payload?.status === 'active')).payload.revision, 2);
    assert.deepEqual(
      (await staff.until((x) => x.type === 'support.snapshot' && x.requests.length === 0)).requests,
      [],
    );
    await settle();
    assert.equal(other.queue.length, 0);
    staff.socket.destroy();
    await waitFor(() => store.listenerCount === 3);
    const reconnected = await open(0, 'staff');
    assert.deepEqual((await reconnected.until((x) => x.type === 'support.snapshot')).requests, []);
    await waitFor(() => store.listenerCount === 4);
    store.failListeners();
    await waitFor(() => store.listenerCount === 0);
    assert.deepEqual(await learner.until((x) => x.close), { close: true });
  },
);
