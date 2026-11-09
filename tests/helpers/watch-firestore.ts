import { FakeFirestore } from './fake-firestore.ts';
import type { FirestoreTransaction } from '../../apps/api/src/firestore-repository.ts';

// Deterministic test double: listeners fire only after successful commits and are scoped by query.
// It is not a substitute for Firestore Emulator or SDK compatibility tests.
export class WatchFirestore extends FakeFirestore {
  private watchers = new Set<{
    snapshot: () => unknown;
    emit: (value: any) => void;
    fail: (error: Error) => void;
    last: string;
  }>();
  scopes: string[] = [];
  get listenerCount() {
    return this.watchers.size;
  }
  failListeners() {
    // Copy first: a fail() callback may unsubscribe and delete from the set.
    for (const watcher of Array.from(this.watchers)) watcher.fail(Error('listener failed'));
  }
  override collection(name: string): any {
    const base = super.collection(name);
    const watch = (
      description: string,
      snapshot: () => unknown,
      next: (value: any) => void,
      fail: (error: Error) => void,
    ) => {
      this.scopes.push(description);
      const watcher = { snapshot, emit: next, fail, last: '' };
      this.watchers.add(watcher);
      queueMicrotask(() => {
        if (this.watchers.has(watcher)) {
          const value = snapshot();
          watcher.last = JSON.stringify(value);
          next(value);
        }
      });
      return () => {
        this.watchers.delete(watcher);
      };
    };
    const query = (filters: [string, string][]): any => ({
      get: async () => ({ docs: this.entries(name, filters) }),
      where: (field: string, op: string, value: string) => {
        if (op !== '==') throw Error('operator');
        return query([...filters, [field, value]]);
      },
      onSnapshot: (next: (value: any) => void, fail: (error: Error) => void) =>
        watch(
          `${name}:${filters.map(([k, v]) => `${k}=${v}`).join(',')}`,
          () => ({ docs: this.entries(name, filters) }),
          next,
          fail,
        ),
    });
    return {
      doc: (id: string) => {
        const ref: any = base.doc(id);
        ref.onSnapshot = (next: (value: any) => void, fail: (error: Error) => void) =>
          watch(`${name}/${id}`, () => this.document(name, id), next, fail);
        return ref;
      },
      where: (field: string, op: string, value: string) => {
        if (op !== '==') throw Error('operator');
        return query([[field, value]]);
      },
    };
  }
  private document(name: string, id: string) {
    const data = structuredClone(this.data.get(`${name}/${id}`));
    return { id, data: () => data, toJSON: () => ({ id, data }) };
  }
  private entries(name: string, filters: [string, string][]) {
    return [...this.data]
      .filter(
        ([path, value]) =>
          path.startsWith(`${name}/`) &&
          filters.every(([key, expected]) => value[key] === expected),
      )
      .map(([, value]) => this.document(name, value.id));
  }
  override async runTransaction<T>(fn: (tx: FirestoreTransaction) => Promise<T>): Promise<T> {
    const version = this.version;
    const result = (await super.runTransaction(fn)) as T;
    if (this.version !== version)
      queueMicrotask(() => {
        // Copy first: emit() may unsubscribe and delete from the set.
        for (const watcher of Array.from(this.watchers)) {
          const value = watcher.snapshot(),
            serialized = JSON.stringify(value);
          if (serialized !== watcher.last) {
            watcher.last = serialized;
            watcher.emit(value);
          }
        }
      });
    return result;
  }
}
