import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const script = new URL('../scripts/check-firebase-build-config.mjs', import.meta.url).pathname;
const config = { VITE_AUTH_BACKEND: 'firebase', VITE_FIREBASE_API_KEY: 'public-test-key', VITE_FIREBASE_AUTH_DOMAIN: 'example.firebaseapp.com', VITE_FIREBASE_PROJECT_ID: 'test-project' };
function run(changes: Record<string, string>) {
    return spawnSync(process.execPath, [script], { env: { ...process.env, ...config, ...changes }, encoding: 'utf8' });
}
test('Cloud Build refuses demo mode or missing Firebase web settings', () => {
    assert.equal(run({}).status, 0);
    const changes: Record<string, string>[] = [{ VITE_AUTH_BACKEND: 'demo' }, { VITE_FIREBASE_API_KEY: '' }, { VITE_FIREBASE_AUTH_DOMAIN: ' ' }, { VITE_FIREBASE_PROJECT_ID: '' }];
    for (const change of changes) {
        const result = run(change); assert.equal(result.status, 1); assert.match(result.stderr, /configuration is incomplete/); assert.doesNotMatch(result.stderr, /public-test-key/);
    }
    const build = readFileSync(new URL('../cloudbuild.yaml', import.meta.url), 'utf8');
    assert.match(build, /node scripts\/check-firebase-build-config\.mjs && \.\/scripts\/prepare-containers\.sh/);
    for (const name of ['API_KEY', 'AUTH_DOMAIN', 'PROJECT_ID']) assert.ok(build.includes(`VITE_FIREBASE_${name}=${'${_FIREBASE_' + name + '}'}`));
});
