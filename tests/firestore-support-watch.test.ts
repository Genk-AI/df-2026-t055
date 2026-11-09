import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FirestoreRepository, configuredRepository } from '../apps/api/src/firestore-repository.ts';
import { doc } from '../apps/api/src/adapters.ts';
import { WatchFirestore } from './helpers/watch-firestore.ts';

const settle = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};
test('Firestore SDK binding requires an explicit project and organization', () => {
  assert.throws(
    () => configuredRepository({ REPOSITORY_BACKEND: 'firestore', GOOGLE_CLOUD_PROJECT: 'p' }),
    /FIRESTORE_ORG_ID_REQUIRED/,
  );
  assert.ok(
    configuredRepository({
      REPOSITORY_BACKEND: 'firestore',
      GOOGLE_CLOUD_PROJECT: 'p',
      FIRESTORE_ORG_ID: 'demo',
    }) instanceof FirestoreRepository,
  );
});
test('orgとsessionに絞り、コミット後だけ通知し、停止とエラーで購読を解除する', async () => {
  const client = new WatchFirestore(),
    db = new FirestoreRepository(client, 'demo'),
    foreign = new FirestoreRepository(client, 'other');
  await db.put('sessions', doc('demo', { id: 's', learnerId: 'a', revision: 1 }));
  await db.put(
    'supportRequests',
    doc('demo', { id: 'q', sessionId: 's', learnerId: 'a', revision: 1 }),
  );
  let staff = 0,
    learner = 0,
    other = 0,
    errors = 0;
  const offStaff = db.watchSupport(
    { orgId: 'demo', role: 'staff' },
    () => staff++,
    () => errors++,
  );
  const offLearner = db.watchSupport(
    { orgId: 'demo', role: 'learner', sessionId: 's', learnerId: 'a' },
    () => learner++,
    () => errors++,
  );
  const offOther = foreign.watchSupport(
    { orgId: 'other', role: 'staff' },
    () => other++,
    () => errors++,
  );
  await settle();
  assert.ok(client.scopes.includes('supportRequests:orgId=demo,sessionId=s'));
  assert.ok(client.scopes.includes('sessions/s'));
  assert.throws(
    () =>
      db.watchSupport(
        { orgId: 'other', role: 'staff' },
        () => {},
        () => {},
      ),
    /ORG_FORBIDDEN/,
  );
  const before = { staff, learner, other };
  await assert.rejects(
    db.transaction(async () => {
      await db.put('supportRequests', { ...(await db.get('supportRequests', 'q'))!, revision: 2 });
      throw Error('rollback');
    }),
  );
  await settle();
  assert.deepEqual({ staff, learner, other }, before);
  await db.put('supportRequests', { ...(await db.get('supportRequests', 'q'))!, revision: 2 });
  await settle();
  assert.ok(staff > before.staff);
  assert.ok(learner > before.learner);
  assert.equal(other, before.other);
  const previous = learner;
  await db.put(
    'supportRequests',
    doc('demo', { id: 'other-session', sessionId: 'other', learnerId: 'b', revision: 1 }),
  );
  await settle();
  assert.equal(learner, previous);
  offStaff();
  offOther();
  assert.equal(client.listenerCount, 2);
  client.failListeners();
  await settle();
  assert.equal(errors, 1);
  assert.equal(client.listenerCount, 0);
  offLearner();
});

test('本人セッションに別本人の要求が混入した場合は通知せず購読を終了する', async () => {
  const client = new WatchFirestore(),
    db = new FirestoreRepository(client, 'demo');
  await db.put('sessions', doc('demo', { id: 's', learnerId: 'a' }));
  let changes = 0,
    errors = 0;
  db.watchSupport(
    { orgId: 'demo', role: 'learner', sessionId: 's', learnerId: 'a' },
    () => changes++,
    () => errors++,
  );
  await settle();
  const before = changes;
  await db.put('supportRequests', doc('demo', { id: 'wrong', sessionId: 's', learnerId: 'b' }));
  await settle();
  assert.equal(changes, before);
  assert.equal(errors, 1);
  assert.equal(client.listenerCount, 0);
});
