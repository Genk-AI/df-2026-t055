import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFirebaseSession } from '../apps/web/src/firebase-session.ts';

test('Firebase web mode requires configuration and never returns a demo token', async () => {
    assert.throws(() => createFirebaseSession({ apiKey: '', authDomain: '', projectId: '' }), /FIREBASE_WEB_CONFIG_REQUIRED/);
    const session = createFirebaseSession({ apiKey: 'test-api-key', authDomain: 'example.firebaseapp.com', projectId: 'test-project' });
    await assert.rejects(session.token(), /AUTH_REQUIRED/);
});
