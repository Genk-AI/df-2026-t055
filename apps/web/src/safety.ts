export interface Store {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}
export type SafetyEvent = {
    clientEventId: string;
    expectedRevision: number;
    type: 'stop' | 'help';
};
export type SafetyState = {
    stopped: boolean;
    waiting: boolean;
    pending: SafetyEvent[];
};
export function safetyKey(uid: string, sessionId: string) {
    return `safety:${uid}:${sessionId}`;
}
export type PendingStart = { taskId: string; clientRequestId: string; safety?: { type: 'stop' | 'help'; clientEventId: string } };
export function startKey(uid: string) { return `pending-start:${uid}`; }
export function readStart(store: Store, uid: string): PendingStart | null {
    const value = store.getItem(startKey(uid));
    return value ? JSON.parse(value) : null;
}
export function saveStart(store: Store, uid: string, start: PendingStart) {
    store.setItem(startKey(uid), JSON.stringify(start));
}
export function readSafety(store: Store, key: string): SafetyState {
    const value = store.getItem(key);
    return value ? JSON.parse(value) : { stopped: false, waiting: false, pending: [] };
}
// Persist before issuing a network request; stopped is retained after acknowledgement.
export function hold(store: Store, key: string, event: SafetyEvent) {
    const s = readSafety(store, key);
    // Repeated taps must not create new stop IDs, including after acknowledgement.
    if (s.stopped)
        return s;
    if (event.type === 'stop')
        s.stopped = true;
    else
        s.waiting = true;
    s.pending.push(event);
    store.setItem(key, JSON.stringify(s));
    return s;
}
export function delivered(store: Store, key: string, eventId: string) {
    const s = readSafety(store, key);
    s.pending = s.pending.filter(e => e.clientEventId !== eventId);
    store.setItem(key, JSON.stringify(s));
    return s;
}
export function clearWaiting(store: Store, key: string) {
    const s = readSafety(store, key);
    if (s.stopped)
        return;
    s.waiting = false;
    store.setItem(key, JSON.stringify(s));
}
export type SafetyTransport = {
    send: (event: SafetyEvent) => Promise<void>;
    load: () => Promise<{
        status: string;
        revision: number;
    }>;
};
export async function flushSafety(store: Store, key: string, transport: SafetyTransport): Promise<boolean> {
    const pending = [...readSafety(store, key).pending].sort((a, b) => Number(b.type === 'stop') - Number(a.type === 'stop'));
    for (const event of pending) {
        if (event.type === 'help' && readSafety(store, key).stopped) {
            delivered(store, key, event.clientEventId);
            continue;
        }
        try {
            await transport.send(event);
            delivered(store, key, event.clientEventId);
        }
        catch (error) {
            if (event.type === 'help' && (error as {
                status?: number;
            }).status === 409) {
                try {
                    const fresh = await transport.load();
                    if (fresh.status === 'waiting_help') {
                        delivered(store, key, event.clientEventId);
                        continue;
                    }
                    if (fresh.status === 'stopped') {
                        const s = readSafety(store, key);
                        s.stopped = true;
                        store.setItem(key, JSON.stringify(s));
                        delivered(store, key, event.clientEventId);
                        continue;
                    }
                    // An in-flight next may have committed first. Preserve the event ID and wait state.
                    if (fresh.status === 'active') {
                        const updated = { ...event, expectedRevision: fresh.revision };
                        const s = readSafety(store, key);
                        s.pending = s.pending.map(e => e.clientEventId === event.clientEventId ? updated : e);
                        store.setItem(key, JSON.stringify(s));
                        await transport.send(updated);
                        delivered(store, key, event.clientEventId);
                        continue;
                    }
                }
                catch {
                }
            }
            return false;
        }
    }
    return true;
}
