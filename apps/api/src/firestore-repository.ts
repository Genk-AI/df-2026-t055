import { AsyncLocalStorage } from 'node:async_hooks';
import { Firestore } from '@google-cloud/firestore';
import { MemoryRepository, type Doc, type Repository, type SupportWatchScope } from './adapters.ts';

// SDK binding is deliberately separate: Native mode, no credentials or SDK required here.
export interface FirestoreSnapshot {
  id: string;
  data(): Record<string, unknown> | undefined;
}
export interface FirestoreQuerySnapshot {
  docs: FirestoreSnapshot[];
}
export interface FirestoreReference {
  get(): Promise<FirestoreSnapshot>;
}
export interface FirestoreQuery {
  get(): Promise<FirestoreQuerySnapshot>;
}
export interface FirestoreCollection {
  doc(id: string): FirestoreReference;
  where(field: 'orgId', operator: '==', value: string): FirestoreQuery;
}
export interface FirestoreTransaction {
  get(ref: FirestoreReference): Promise<FirestoreSnapshot>;
  get(query: FirestoreQuery): Promise<FirestoreQuerySnapshot>;
  set(ref: FirestoreReference, value: Doc): unknown;
}
export interface FirestoreClient {
  collection(name: string): FirestoreCollection;
  runTransaction<T>(fn: (transaction: FirestoreTransaction) => Promise<T>): Promise<T>;
}
type WatchReference = {
  onSnapshot(
    next: (snapshot: FirestoreSnapshot) => void,
    error: (error: Error) => void,
  ): () => void;
};
type WatchQuery = {
  where(field: string, op: '==', value: string): WatchQuery;
  onSnapshot(
    next: (snapshot: FirestoreQuerySnapshot) => void,
    error: (error: Error) => void,
  ): () => void;
};
type WatchClient = {
  collection(name: string): {
    doc(id: string): WatchReference;
    where(field: string, op: '==', value: string): WatchQuery;
  };
};
type Context = { transaction: FirestoreTransaction; writes: Map<string, Map<string, Doc>> };
// 他組織の文書へのアクセスは403にする。HTTP層は status・code を付けた Error をそのまま返す。
function forbidden(): Error {
  return Object.assign(Error('ORG_FORBIDDEN'), { status: 403, code: 'ORG_FORBIDDEN' });
}
function segment(value: string) {
  if (!value || value.includes('/') || value === '.' || value === '..')
    throw Error('INVALID_DOCUMENT_PATH');
  return value;
}
// Only JSON metadata is stored; omit optional undefined fields as in JSON responses.
function metadata(value: unknown): any {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(metadata);
  if (value && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, metadata(v)]),
    );
  throw Error('INVALID_FIRESTORE_METADATA');
}
export class FirestoreRepository implements Repository {
  private context = new AsyncLocalStorage<Context>();
  // One trusted tenant per repository; API still checks the authenticated member's orgId.
  constructor(
    private client: FirestoreClient,
    readonly orgId: string,
  ) {
    segment(orgId);
  }
  private collection(name: string) {
    return this.client.collection(segment(name));
  }
  private decode(snapshot: FirestoreSnapshot): Doc | undefined {
    const data = snapshot.data();
    if (!data) return undefined;
    if (data.orgId !== this.orgId) throw forbidden();
    if (data.id !== snapshot.id || typeof data.createdAt !== 'string' || !data.createdAt)
      throw Error('INVALID_FIRESTORE_DOCUMENT');
    return structuredClone(data) as Doc;
  }
  async get(collection: string, id: string): Promise<Doc | undefined> {
    const ref = this.collection(collection).doc(segment(id));
    const context = this.context.getStore();
    const pending = context?.writes.get(collection)?.get(id);
    if (pending) return structuredClone(pending);
    return this.decode(await (context ? context.transaction.get(ref) : ref.get()));
  }
  async all(collection: string): Promise<Doc[]> {
    const query = this.collection(collection).where('orgId', '==', this.orgId);
    const context = this.context.getStore();
    const snapshot = await (context ? context.transaction.get(query) : query.get());
    const values = new Map(snapshot.docs.map((s) => [s.id, this.decode(s)!]));
    for (const [id, value] of context?.writes.get(collection) ?? []) values.set(id, value);
    return [...values.values()].map((value) => structuredClone(value));
  }
  async put(collection: string, value: Doc): Promise<void> {
    this.collection(collection).doc(segment(value.id));
    if (value.orgId !== this.orgId) throw forbidden();
    if (typeof value.createdAt !== 'string' || !value.createdAt)
      throw Error('INVALID_FIRESTORE_DOCUMENT');
    const clean = metadata(value) as Doc;
    if (!this.context.getStore()) return this.transaction(() => this.put(collection, clean));
    // Read even for blind writes: another tenant's existing ID must never be overwritten.
    await this.get(collection, value.id);
    const writes = this.context.getStore()!.writes;
    if (!writes.has(collection)) writes.set(collection, new Map());
    writes.get(collection)!.set(value.id, clean);
  }
  async transaction<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.context.getStore()) return fn();
    // All SDK reads precede SDK writes. Only the callback is retried by the client.
    // Callers must prepare Storage/TTS/model I/O outside this callback.
    // https://cloud.google.com/firestore/native/docs/manage-data/transactions
    return this.client.runTransaction(async (transaction) => {
      const context: Context = { transaction, writes: new Map() };
      const result = await this.context.run(context, fn);
      for (const [collection, values] of context.writes)
        for (const value of values.values())
          transaction.set(this.collection(collection).doc(value.id), value);
      return result;
    });
  }
  watchSupport(scope: SupportWatchScope, onChange: () => void, onError: () => void): () => void {
    if (scope.orgId !== this.orgId) throw forbidden();
    const client = this.client as unknown as WatchClient;
    const unsubscribers: (() => void)[] = [];
    let active = true;
    const stop = () => {
      if (!active) return;
      active = false;
      for (const unsubscribe of unsubscribers) {
        try {
          unsubscribe();
        } catch {
          /* Continue releasing the other listeners. */
        }
      }
    };
    const failed = () => {
      if (active) {
        stop();
        onError();
      }
    };
    const changed = (documents: FirestoreSnapshot[], kind: 'session' | 'request') => {
      if (!active) return;
      try {
        for (const snapshot of documents) {
          const data = snapshot.data();
          if (!data || data.orgId !== scope.orgId || data.id !== snapshot.id)
            throw Error('INVALID_WATCH_SCOPE');
          if (
            scope.role === 'learner' &&
            (kind === 'session'
              ? snapshot.id !== scope.sessionId || data.learnerId !== scope.learnerId
              : data.sessionId !== scope.sessionId || data.learnerId !== scope.learnerId)
          )
            throw Error('INVALID_WATCH_SCOPE');
        }
        onChange();
      } catch {
        failed();
      }
    };
    try {
      let query = client.collection('supportRequests').where('orgId', '==', scope.orgId);
      if (scope.role === 'learner')
        query = query.where('sessionId', '==', segment(scope.sessionId));
      unsubscribers.push(
        query.onSnapshot(
          (snapshot) => queueMicrotask(() => changed(snapshot.docs, 'request')),
          () => queueMicrotask(failed),
        ),
      );
      if (scope.role === 'learner')
        unsubscribers.push(
          client
            .collection('sessions')
            .doc(segment(scope.sessionId))
            .onSnapshot(
              (snapshot) => queueMicrotask(() => changed([snapshot], 'session')),
              () => queueMicrotask(failed),
            ),
        );
    } catch (error) {
      stop();
      throw error;
    }
    return stop;
  }
}
export function configuredRepository(
  env: NodeJS.ProcessEnv = process.env,
  client?: FirestoreClient,
): Repository {
  const backend = env.REPOSITORY_BACKEND ?? 'memory';
  if (backend === 'memory') return new MemoryRepository();
  if (backend !== 'firestore') throw Error('INVALID_REPOSITORY_BACKEND');
  if (!client && !env.GOOGLE_CLOUD_PROJECT?.trim())
    throw Error('FIRESTORE_CLIENT_NOT_CONFIGURED: GOOGLE_CLOUD_PROJECT is required');
  if (!env.FIRESTORE_ORG_ID) throw Error('FIRESTORE_ORG_ID_REQUIRED');
  if (!client) {
    const projectId = env.GOOGLE_CLOUD_PROJECT?.trim();
    if (!projectId)
      throw Error('FIRESTORE_CLIENT_NOT_CONFIGURED: GOOGLE_CLOUD_PROJECT is required');
    client = new Firestore({
      projectId,
      ...(env.FIRESTORE_DATABASE_ID ? { databaseId: env.FIRESTORE_DATABASE_ID } : {}),
    }) as unknown as FirestoreClient;
  }
  return new FirestoreRepository(client, env.FIRESTORE_ORG_ID);
}
