import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from 'node:https';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { DemoAuth, MemoryRepository, seed, doc } from '../apps/api/src/adapters.ts';
import { FirebaseAuth, configuredAuth, type FirebaseTokenClient } from '../apps/api/src/firebase-auth.ts';
import { createApp } from '../apps/api/src/app.ts';
import { manageMember } from '../scripts/member-link.ts';
import { createTokenProvider } from '../apps/web/src/auth.ts';

const expiry = Math.floor(Date.now() / 1000) + 3600;
class FakeTokens implements FirebaseTokenClient {
    async verifyIdToken(token: string, checkRevoked: true) {
        assert.equal(checkRevoked, true);
        if (token === 'invalid') throw Object.assign(Error('Decoding Firebase ID token failed. PRIVATE_TOKEN'), { code: 'auth/argument-error' });
        return { uid: token, exp: token === 'expired' ? 1 : expiry };
    }
}
function setup() {
    const db = new MemoryRepository(); seed(db);
    const auth = new FirebaseAuth(db, new FakeTokens(), 'demo');
    return { db, auth };
}
test('Firebase rejects invalid, expired, unknown, duplicate, malformed and foreign members', async () => {
    const { db, auth } = setup();
    for (const token of ['', 'with space', 'invalid', 'expired', 'unregistered', 'other-staff'])
        assert.equal(await auth.verify(token), undefined);
    for (const fields of [{ uid: 'bad', role: 'admin' }, { uid: 'bad', role: 'learner' }, { uid: 'bad', role: 'learner', learnerId: 'missing' }]) {
        db.put('members', doc('demo', { id: 'bad', ...fields }));
        assert.equal(await auth.verify('bad'), undefined);
    }
    for (const exp of [NaN, Infinity, 1.5, Number.MAX_VALUE])
        assert.equal(await new FirebaseAuth(db, { async verifyIdToken() { return { uid: 'staff', exp }; } }, 'demo').verify('token'), undefined);
    db.put('members', doc('demo', { uid: 'staff', role: 'staff' }));
    assert.equal(await auth.verify('staff'), undefined);
});
test('Firebase returns only member authorization and verified epoch expiry', async () => {
    const { db, auth } = setup();
    db.put('members', { ...db.get('members', 'staff')!, private: 'PRIVATE' });
    assert.deepEqual(await auth.verify('staff'), { uid: 'staff', orgId: 'demo', role: 'staff', learnerId: undefined, expiresAt: expiry * 1000 });
    assert.equal((await auth.verify('learner-a'))?.learnerId, 'a');
    db.put('learners', doc('other', { id: 'a' }));
    assert.equal(await auth.verify('learner-a'), undefined);
});
test('Firebase HTTP authentication preserves role, org and learner authorization', async () => {
    const { db, auth } = setup();
    db.put('tasks', doc('other', { id: 'foreign' }));
    db.put('sessions', doc('demo', { id: 'private-session', learnerId: 'b' }));
    const { app } = createApp({ db, auth });
    const request = (token: string, path = '/tasks', scheme = 'Bearer ') => app.fetch(new Request('http://localhost/api/v1' + path, { headers: { authorization: scheme + token } }));
    for (const token of ['invalid', 'expired', 'unknown', 'other-staff']) {
        const r = await request(token); assert.equal(r.status, 401); assert.doesNotMatch(await r.text(), /PRIVATE_TOKEN/);
    }
    assert.equal((await request('staff', '/tasks', '')).status, 401);
    assert.equal((await request('staff')).status, 200);
    assert.equal((await request('learner-a')).status, 403);
    assert.equal((await request('newcomer')).status, 403);
    assert.equal((await request('staff', '/tasks/foreign')).status, 403);
    assert.equal((await request('learner-a', '/me/sessions/private-session')).status, 403);
});
test('Demo defaults remain local; production rejects default, explicit and injected DemoAuth', async () => {
    const { db } = setup();
    const demo = configuredAuth(db, {});
    assert.ok(demo instanceof DemoAuth); assert.equal((await demo.verify('staff'))?.role, 'staff');
    for (const env of [{ NODE_ENV: 'production' }, { NODE_ENV: 'production', AUTH_BACKEND: 'demo' }])
        assert.throws(() => configuredAuth(db, env), /DEMO_AUTH_DISABLED/);
    assert.throws(() => configuredAuth(db, { NODE_ENV: 'production' }, undefined, demo), /DEMO_AUTH_DISABLED/);
    assert.throws(() => configuredAuth(db, { AUTH_BACKEND: 'firebase' }), /CLIENT_NOT_CONFIGURED/);
    assert.throws(() => configuredAuth(db, { AUTH_BACKEND: 'bad' }), /INVALID_AUTH_BACKEND/);
    assert.throws(() => configuredAuth(db, { AUTH_BACKEND: 'firebase' }, new FakeTokens()), /ORG_ID_REQUIRED/);
    assert.ok(configuredAuth(db, { NODE_ENV: 'production', AUTH_BACKEND: 'firebase', FIRESTORE_ORG_ID: 'demo' }, new FakeTokens()) instanceof FirebaseAuth);
    const previous = process.env.NODE_ENV;
    try {
        process.env.NODE_ENV = 'production';
        assert.throws(() => new DemoAuth(db), /DEMO_AUTH_DISABLED/);
        assert.throws(() => createApp({ db, auth: demo }), /DEMO_AUTH_DISABLED/);
    } finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
});
test('member script links/unlinks fake UID atomically without changing role/org/learnerId', async () => {
    const { db, auth } = setup();
    await manageMember(db, ['unlink', 'learner-a', 'learner-a']);
    assert.equal(await auth.verify('learner-a'), undefined);
    const before = db.get('members', 'learner-a')!;
    await manageMember(db, ['link', 'fake-firebase-uid', 'learner-a']);
    assert.deepEqual(db.get('members', 'learner-a'), { ...before, uid: 'fake-firebase-uid' });
    assert.equal((await auth.verify('fake-firebase-uid'))?.learnerId, 'a');
    await manageMember(db, ['link', 'fake-firebase-uid', 'learner-a']);
    for (const args of [['link', 'staff', 'learner-b'], ['unlink', 'wrong', 'learner-a'], ['link', 'uid', 'missing'], ['link', 'bad/uid', 'staff']])
        await assert.rejects(manageMember(db, args));
    await manageMember(db, ['unlink', 'fake-firebase-uid', 'learner-a']);
    assert.equal(await auth.verify('fake-firebase-uid'), undefined);
    const results = await Promise.allSettled(['learner-a', 'learner-b'].map(async memberId => {
        if (memberId === 'learner-b') await manageMember(db, ['unlink', 'learner-b', memberId]);
        return manageMember(db, ['link', 'race-uid', memberId]);
    }));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
});
test('重複したUIDはunlinkで解消でき、linkは重複を拒否する', async () => {
    const { db, auth } = setup();
    db.put('members', doc('demo', { id: 'a', uid: 'duplicate', role: 'staff' }));
    db.put('members', doc('demo', { id: 'b', uid: 'duplicate', role: 'staff' }));
    assert.equal(await auth.verify('duplicate'), undefined);
    await assert.rejects(manageMember(db, ['link', 'duplicate', 'a']), /MEMBER_LINK_CONFLICT/);
    await manageMember(db, ['unlink', 'duplicate', 'b']);
    assert.equal(db.get('members', 'b')!.uid, undefined);
    assert.equal((await auth.verify('duplicate'))?.uid, 'duplicate');
    await manageMember(db, ['unlink', 'duplicate', 'a']);
    assert.equal(await auth.verify('duplicate'), undefined);
});
test('web token source reads current demo account and calls Firebase provider afresh', async () => {
    let account = 'staff', calls = 0;
    const demo = createTokenProvider(() => account);
    assert.equal(await demo(), 'staff'); account = 'learner-a'; assert.equal(await demo(), account);
    const firebase = createTokenProvider(() => account, async () => 'fresh-' + ++calls);
    assert.equal(await firebase(), 'fresh-1'); assert.equal(await firebase(), 'fresh-2');
    await assert.rejects(createTokenProvider(() => account, async () => { throw Error('expired'); })());
});

test('HTTP rejects expired credentials even from an injected Auth port', async () => {
    const { db } = setup();
    const { app } = createApp({ db, auth: { async verify() { return { uid: 'staff', orgId: 'demo', role: 'staff', expiresAt: Date.now() - 1 }; } } });
    assert.equal((await app.fetch(new Request('http://localhost/api/v1/tasks', { headers: { authorization: 'Bearer expired' } }))).status, 401);
});

test('member CLI uses an explicit repository module and never prints account arguments', async () => {
    const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const directory = await mkdtemp(join(tmpdir(), 'member-link-'));
    try {
        const modulePath = join(directory, 'repository.mjs');
        const state = join(directory, 'state.json');
        await writeFile(modulePath, `
            import { MemoryRepository, doc } from ${JSON.stringify(new URL('../apps/api/src/adapters.ts', import.meta.url).href)};
            import { readFileSync, writeFileSync, existsSync } from 'node:fs';
            export const repository = new MemoryRepository();
            const state = ${JSON.stringify(state)};
            for (const member of existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')) : [doc('demo', { id: 'fake-member', role: 'staff' })]) repository.put('members', member);
            process.on('beforeExit', () => writeFileSync(state, JSON.stringify(repository.all('members'))));
        `);
        const run = promisify(execFile);
        const cli = new URL('../scripts/member-link.ts', import.meta.url).pathname;
        for (const operation of ['link', 'unlink']) {
            const output = await run(process.execPath, ['--experimental-transform-types', cli, modulePath, operation, 'fake-cli-uid', 'fake-member']);
            assert.doesNotMatch(output.stdout + output.stderr, /fake-cli-uid|fake-member/);
            assert.equal(JSON.parse(await readFile(state, 'utf8'))[0].uid, operation === 'link' ? 'fake-cli-uid' : undefined);
        }
        await assert.rejects(run(process.execPath, ['--experimental-transform-types', cli, modulePath, 'link', 'fake-cli-uid', 'missing']), (error: any) => {
            assert.doesNotMatch(error.stdout + error.stderr, /fake-cli-uid|missing/); return true;
        });
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Firebase ADC binding is selected only with an explicit project and org', () => {
    const { db } = setup();
    assert.ok(configuredAuth(db, { AUTH_BACKEND: 'firebase', FIREBASE_PROJECT_ID: 't055-test-project', FIRESTORE_ORG_ID: 'demo' }) instanceof FirebaseAuth);
    assert.throws(() => configuredAuth(db, { AUTH_BACKEND: 'firebase', FIREBASE_PROJECT_ID: 't055-test-project' }), /FIREBASE_ORG_ID_REQUIRED/);
});

test('identity endpoint returns only the verified UID and role', async () => {
    const { db, auth } = setup();
    const app = createApp({ db, auth }).app;
    const get = (token: string) => app.fetch(new Request('http://localhost/api/v1/identity', { headers: { authorization: `Bearer ${token}` } }));
    const staff = await get('staff'); assert.equal(staff.status, 200);
    assert.deepEqual(await staff.json(), { schemaVersion: '1', uid: 'staff', role: 'staff' });
    assert.equal((await get('invalid')).status, 401);
    const learner = await get('learner-a');
    assert.deepEqual(await learner.json(), { schemaVersion: '1', uid: 'learner-a', role: 'learner' });
});


test('Firebase SDK distinguishes invalid tokens from unavailable verification without exposing secrets', async () => {
    class OfflineAgent extends Agent { createConnection(): never { throw Error('PRIVATE_NETWORK_DETAIL'); } }
    const firebaseApp = initializeApp({ projectId: 't055-offline-test', httpAgent: new OfflineAgent() }, 't055-offline-test');
    const { db } = setup();
    const logs: string[] = [];
    const previous = console.error;
    console.error = (...args: unknown[]) => { logs.push(args.join(' ')); };
    try {
        const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
        const time = Math.floor(Date.now() / 1000);
        const token = `${part({ alg: 'RS256', kid: 'test' })}.${part({ iss: 'https://securetoken.google.com/t055-offline-test', aud: 't055-offline-test', sub: 'private-uid', iat: time, exp: time + 3600, auth_time: time })}.AA`;
        const auth = new FirebaseAuth(db, getAuth(firebaseApp), 'demo');
        const app = createApp({ db, auth }).app;
        const request = (value: string) => app.fetch(new Request('http://localhost/api/v1/tasks', { headers: { authorization: `Bearer ${value}` } }));
        assert.equal((await request('not-a-jwt')).status, 401);
        const response = await request(token);
        assert.equal(response.status, 503);
        const body = await response.text();
        assert.equal(JSON.parse(body).error.code, 'AUTH_SERVICE_UNAVAILABLE');
        assert.doesNotMatch(body + logs.join(' '), /PRIVATE_NETWORK_DETAIL|private-uid|Bearer/);
        assert.equal(logs.length, 1);
    } finally { console.error = previous; await deleteApp(firebaseApp); }
});
