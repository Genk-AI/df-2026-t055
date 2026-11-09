import { DemoAuth, type Auth, type Repository, type Doc } from './adapters.ts';
import type { Member } from '../../../packages/shared/src/index.ts';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

// The SDK binding must verify signature, issuer, audience and revocation; never decode an unverified JWT.
export interface FirebaseTokenClient {
    verifyIdToken(token: string, checkRevoked: true): Promise<{ uid: string; exp: number }>;
}
export function validMember(m: Doc): m is Doc & Member {
    return typeof m.uid === 'string' && !!m.uid && typeof m.orgId === 'string' && !!m.orgId
        && ['staff', 'learner', 'newcomer'].includes(m.role)
        && (m.role !== 'learner' || (typeof m.learnerId === 'string' && !!m.learnerId));
}
// firebase-admin 14 maps both malformed tokens and key-fetch failures to argument-error.
// Only the SDK's known token-validation messages are classified as invalid credentials.
const invalidTokenCodes = new Set(['auth/id-token-expired', 'auth/id-token-revoked', 'auth/invalid-id-token', 'auth/user-disabled', 'auth/user-not-found']);
const invalidArgumentMessages = [
    /^Decoding Firebase ID token failed\./,
    /^Firebase ID token has invalid signature\./,
    /^Firebase ID token has "kid" claim which does not correspond to a known public key\./,
    /^Firebase ID token has (?:no "kid" claim|incorrect algorithm|incorrect "aud"|incorrect "iss"|no "sub"|an empty "sub"|a "sub" \(subject\) claim longer than 128 characters)/,
    /^verifyIdToken\(\) expects (?:a |an )?(?:Firebase )?(?:ID token|ID token,)/
];
export class AuthServiceUnavailableError extends Error {
    constructor() { super('AUTH_SERVICE_UNAVAILABLE'); }
}
export class FirebaseAuth implements Auth {
    constructor(private db: Repository, private client: FirebaseTokenClient, private orgId: string) {
        if (!orgId) throw Error('FIREBASE_ORG_ID_REQUIRED');
    }
    async verify(token: string) {
        if (!token || /\s/.test(token)) return undefined;
        let claims;
        try { claims = await this.client.verifyIdToken(token, true); }
        catch (error: unknown) {
            const e = error as { code?: unknown; message?: unknown } | null;
            const code = typeof e?.code === 'string' ? e.code : '';
            const message = typeof e?.message === 'string' ? e.message : '';
            if (invalidTokenCodes.has(code) || code === 'auth/argument-error' && invalidArgumentMessages.some(pattern => pattern.test(message))) return undefined;
            // Do not log tokens, claims, provider messages or arbitrary error codes.
            const category = ['auth/invalid-credential', 'auth/insufficient-permission', 'auth/project-not-found', 'auth/internal-error', 'auth/too-many-requests'].includes(code) ? code : 'other';
            console.error(JSON.stringify({ event: 'firebase_auth_verification_failed', category }));
            throw new AuthServiceUnavailableError();
        }
        if (typeof claims.uid !== 'string' || !claims.uid || !Number.isSafeInteger(claims.exp)
            || claims.exp * 1000 <= Date.now()) return undefined;
        const matches = (await this.db.all('members')).filter(m => m.uid === claims.uid);
        if (matches.length !== 1) return undefined;
        const m = matches[0];
        if (!validMember(m) || m.orgId !== this.orgId) return undefined;
        if (m.role === 'learner') {
            const learner = await this.db.get('learners', m.learnerId!);
            if (!learner || learner.orgId !== m.orgId) return undefined;
        }
        return { uid: m.uid, orgId: m.orgId, role: m.role, learnerId: m.learnerId, expiresAt: claims.exp * 1000 };
    }
}
export function configuredAuth(db: Repository, env: NodeJS.ProcessEnv = process.env, client?: FirebaseTokenClient, auth?: Auth): Auth {
    if (auth) {
        if (env.NODE_ENV === 'production' && auth instanceof DemoAuth) throw Error('DEMO_AUTH_DISABLED');
        return auth;
    }
    const backend = env.AUTH_BACKEND ?? 'demo';
    if (backend === 'demo') {
        if (env.NODE_ENV === 'production') throw Error('DEMO_AUTH_DISABLED');
        return new DemoAuth(db);
    }
    if (backend !== 'firebase') throw Error('INVALID_AUTH_BACKEND');
    if (!client) {
        if (env.NODE_ENV === 'production' && process.env.FIREBASE_AUTH_EMULATOR_HOST) throw Error('FIREBASE_EMULATOR_DISABLED');
        const projectId = env.FIREBASE_PROJECT_ID?.trim() || env.GOOGLE_CLOUD_PROJECT?.trim();
        if (!projectId) throw Error('FIREBASE_CLIENT_NOT_CONFIGURED');
        const appName = `t055-${projectId}`;
        const app = getApps().find(a => a.name === appName) ?? initializeApp({ projectId, credential: applicationDefault() }, appName);
        client = getAuth(app);
    }
    return new FirebaseAuth(db, client, env.FIRESTORE_ORG_ID ?? '');
}
