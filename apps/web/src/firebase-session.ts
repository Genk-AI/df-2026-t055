import { initializeApp } from '@firebase/app';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, type User } from '@firebase/auth';

export function createFirebaseSession(config: { apiKey: string; authDomain: string; projectId: string }) {
    if (!config.apiKey || !config.authDomain || !config.projectId) throw Error('FIREBASE_WEB_CONFIG_REQUIRED');
    const auth = getAuth(initializeApp(config));
    return {
        async token() { if (!auth.currentUser) throw Error('AUTH_REQUIRED'); return auth.currentUser.getIdToken(); },
        observe(callback: (user: User | null) => void) { return onAuthStateChanged(auth, callback); },
        async signIn(email: string, password: string) { await signInWithEmailAndPassword(auth, email, password); },
        async signOut() { await signOut(auth); }
    };
}
