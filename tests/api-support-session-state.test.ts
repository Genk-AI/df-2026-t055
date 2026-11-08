import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../apps/api/src/app.ts';
import { MemoryRepository, doc, seed } from '../apps/api/src/adapters.ts';

test('担当職員のみが対象helpの再開用revisionを取得できる', async () => {
    const db = new MemoryRepository(); seed(db);
    db.put('members', doc('demo', { id: 'staff2', uid: 'staff2', role: 'staff' }));
    db.put('sessions', doc('demo', { id: 's', learnerId: 'a', status: 'waiting_help', revision: 4, activeSupportRequestId: 'q' }));
    db.put('supportRequests', doc('demo', { id: 'q', learnerId: 'a', sessionId: 's', kind: 'help', status: 'in_progress', assignedTo: 'staff' }));
    const { app } = createApp({ db });
    const get = (path: string, token: string) => app.fetch(new Request(`http://localhost/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } }));
    const identity = await get('/staff/me', 'staff'); assert.equal(identity.status, 200); assert.deepEqual(await identity.json(), { schemaVersion: '1', uid: 'staff' });
    const state = await get('/support-requests/q/session-state', 'staff'); assert.equal(state.status, 200);
    assert.deepEqual(await state.json(), { schemaVersion: '1', sessionId: 's', status: 'waiting_help', revision: 4, currentRequest: true });
    for (const token of ['staff2', 'learner-a', 'newcomer', 'other-staff']) assert.equal((await get('/support-requests/q/session-state', token)).status, 403);
    assert.equal((await get('/staff/me', 'learner-a')).status, 403);
    db.put('sessions', { ...db.get('sessions', 's')!, status: 'stopped', activeSupportRequestId: undefined });
    assert.deepEqual(await (await get('/support-requests/q/session-state', 'staff')).json(), { schemaVersion: '1', sessionId: 's', status: 'stopped', revision: 4, currentRequest: false });
    db.put('supportRequests', { ...db.get('supportRequests', 'q')!, kind: 'stop' });
    assert.equal((await get('/support-requests/q/session-state', 'staff')).status, 403);
    db.put('supportRequests', { ...db.get('supportRequests', 'q')!, kind: 'help', status: 'assigned' });
    assert.equal((await get('/support-requests/q/session-state', 'staff')).status, 409);
});
