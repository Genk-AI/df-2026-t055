import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import React from 'react';
import { readSafety, safetyKey } from '../apps/web/src/safety.ts';

// Run the actual Learner handlers with fake hooks, without a browser or added dependency.
const hookSource = `import React from '${import.meta.resolve('react')}';
let state=[], cursor=0, effects=[], cleanups=[];
export default React;
export function begin(){cursor=0;effects=[];}
export function reset(){for(const f of cleanups)f?.();state=[];cleanups=[];begin();}
export function useState(initial){const i=cursor++;if(!(i in state))state[i]=initial;return [state[i],v=>{state[i]=typeof v==='function'?v(state[i]):v}];}
export function useRef(initial){const i=cursor++;return state[i]??=( {current:initial} );}
export function useEffect(fn,deps){const i=cursor++;if(!state[i]||deps.some((v,j)=>v!==state[i][j])){state[i]=deps;effects.push(()=>{cleanups[i]?.();cleanups[i]=fn();});}}
export async function flush(){for(const fn of effects)fn();await new Promise(r=>setImmediate(r));}`;
const hookUrl = 'data:text/javascript;base64,' + Buffer.from(hookSource).toString('base64');
const hooks = await import(hookUrl);
let source = await readFile(new URL('../apps/web/src/main.tsx', import.meta.url), 'utf8');
source = source.slice(source.indexOf('function Learner(')).replace(/\ncreateRoot.*$/s, '');
source = `import React, {useState,useEffect,useRef} from ${JSON.stringify(hookUrl)};
import {hold, readSafety, flushSafety, safetyKey, clearWaiting, readStart, saveStart, startKey} from ${JSON.stringify(new URL('../apps/web/src/safety.ts', import.meta.url).href)};
import {learnerSupportNotificationSchema} from ${JSON.stringify(new URL('../packages/shared/src/support.ts', import.meta.url).href)};
import {learnerStepPresentation} from ${JSON.stringify(new URL('../apps/web/src/learner-display.ts', import.meta.url).href)};
import {learnerControlPath} from ${JSON.stringify(new URL('../apps/web/src/learner-controls.ts', import.meta.url).href)};
let account = 'learner-a';
const api=(...args)=>globalThis.learnerApi(...args); const go=()=>{}; const Asset=()=>null;
const subscribeSupport=(_token,_session,receive)=>globalThis.learnerSubscribe?.(receive)??(()=>{});
const getToken = async () => account;
export ${source}`;
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    jsx: ts.JsxEmit.React,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
}).outputText;
const { Learner } = await import(
  'data:text/javascript;base64,' + Buffer.from(compiled).toString('base64')
);
function nodes(tree: any): any[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!React.isValidElement(tree)) return [];
  return [tree, ...nodes((tree.props as any).children)];
}
function text(tree: any): string {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (React.isValidElement(tree)) return text((tree.props as any).children);
  return tree == null ? '' : String(tree);
}
async function settle() {
  await new Promise((r) => setImmediate(r));
}

function harness() {
  hooks.reset();
  const store = new Map<string, string>();
  const local = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    get length() {
      return store.size;
    },
    key: (i: number) => [...store.keys()][i] ?? null,
  };
  (globalThis as any).localStorage = local;
  (globalThis as any).learnerSubscribe = () => () => {};
  const timers = new Map<number, () => void>();
  let timerId = 0;
  (globalThis as any).setInterval = (fn: () => void) => {
    const id = ++timerId;
    timers.set(id, fn);
    return id;
  };
  (globalThis as any).clearInterval = (id: number) => {
    timers.delete(id);
  };
  const session = {
    sessionId: 's1',
    releaseId: 'r',
    status: 'active',
    stepIndex: 0,
    revision: 5,
    steps: [{ stepId: 's1', imageAssetId: 'img', text: '折る', visibleCaution: '端に注意' }],
  };
  let failPost = false;
  (globalThis as any).learnerApi = async (path: string, method = 'GET', _body?: unknown) => {
    if (method === 'POST') {
      if (failPost) throw Error('通信失敗');
      return { status: 'active', stepIndex: 0, revision: 5 };
    }
    if (path === '/me/assignments') return { assignments: [] };
    return structuredClone(session);
  };
  const render = () => {
    hooks.begin();
    return Learner({ uid: 'learner-a', path: '/me/sessions/s1', action: async (fn: any) => fn() });
  };
  const key = safetyKey('learner-a', 's1');
  return {
    render,
    store,
    key,
    setWaiting: (pending: any[] = []) =>
      local.setItem(key, JSON.stringify({ stopped: false, waiting: true, pending })),
    setFailPost: (value: boolean) => {
      failPost = value;
    },
    tick: async () => {
      for (const fn of timers.values()) void fn();
      await settle();
    },
  };
}

test('再開後に再読み込みしても支援待ちが残らない', async () => {
  const h = harness();
  // help は送信済み・職員が再開済みだが、端末の待ち表示だけ残っている状態で読み込む。
  h.setWaiting();
  let tree = h.render();
  await hooks.flush();
  tree = h.render();
  await hooks.flush();
  tree = h.render();
  assert.match(text(tree), /職員をよんでいます/);
  await h.tick();
  tree = h.render();
  assert.doesNotMatch(text(tree), /職員をよんでいます/);
  assert.match(text(tree), /折る/);
  assert.equal(readSafety((globalThis as any).localStorage, h.key).waiting, false);
});

test('支援状態を区別し、異なる版・古い通知を無視して同じ版と工程で再開する', async () => {
  const h = harness();
  h.setWaiting();
  let receive!: (value: unknown) => void,
    closed = false;
  (globalThis as any).learnerSubscribe = (fn: (value: unknown) => void) => {
    receive = fn;
    return () => {
      closed = true;
    };
  };
  let tree = h.render();
  await hooks.flush();
  tree = h.render();
  await hooks.flush();
  tree = h.render();
  const update = (revision: number, supportRevision: number, status: string, releaseId = 'r') =>
    receive({
      schemaVersion: '1',
      type: 'session.support.updated',
      payload: {
        schemaVersion: '1',
        sessionId: 's1',
        releaseId,
        status: 'waiting_help',
        stepIndex: 0,
        revision,
        support: { requestId: 'q', revision: supportRevision, status },
      },
    });
  update(6, 2, 'assigned');
  tree = h.render();
  assert.match(text(tree), /担当の職員が決まりました/);
  update(100, 100, 'in_progress', 'wrong-release');
  tree = h.render();
  assert.doesNotMatch(text(tree), /職員が対応しています/);
  update(7, 3, 'in_progress');
  tree = h.render();
  assert.match(text(tree), /職員が対応しています/);
  receive({
    schemaVersion: '1',
    type: 'session.support.updated',
    payload: {
      schemaVersion: '1',
      sessionId: 's1',
      releaseId: 'r',
      status: 'active',
      stepIndex: 0,
      revision: 7,
    },
  });
  tree = h.render();
  assert.match(text(tree), /職員をよんでいます/);
  update(6, 2, 'assigned');
  tree = h.render();
  assert.match(text(tree), /職員が対応しています/);
  update(8, 4, 'acknowledged');
  tree = h.render();
  assert.match(text(tree), /対応が終わりました/);
  receive({
    schemaVersion: '1',
    type: 'session.support.updated',
    payload: {
      schemaVersion: '1',
      sessionId: 's1',
      releaseId: 'r',
      status: 'active',
      stepIndex: 0,
      revision: 9,
    },
  });
  tree = h.render();
  assert.match(text(tree), /折る/);
  assert.doesNotMatch(text(tree), /職員をよんでいます/);
  assert.equal(readSafety((globalThis as any).localStorage, h.key).waiting, false);
  await hooks.flush();
  assert.equal(closed, true);
});

test('送信待ちの手伝ってが残っている間は待ち表示を解除しない', async () => {
  const h = harness();
  h.setWaiting([{ clientEventId: 'help-1', expectedRevision: 5, type: 'help' }]);
  h.setFailPost(true);
  let tree = h.render();
  await hooks.flush();
  tree = h.render();
  await hooks.flush();
  tree = h.render();
  assert.match(text(tree), /職員をよんでいます/);
  await h.tick();
  tree = h.render();
  assert.match(text(tree), /職員をよんでいます/);
  assert.equal(readSafety((globalThis as any).localStorage, h.key).waiting, true);
});

test('未送信停止より後に再開通知が届いても停止表示を維持する', async () => {
  const h = harness();
  h.setWaiting();
  let receive!: (value: unknown) => void;
  (globalThis as any).learnerSubscribe = (fn: (value: unknown) => void) => {
    receive = fn;
    return () => {};
  };
  let tree = h.render();
  await hooks.flush();
  tree = h.render();
  await hooks.flush();
  tree = h.render();
  nodes(tree)
    .find((node) => node.type === 'button' && text(node).includes('やめる'))
    .props.onClick();
  receive({
    schemaVersion: '1',
    type: 'session.support.updated',
    payload: {
      schemaVersion: '1',
      sessionId: 's1',
      releaseId: 'r',
      status: 'active',
      stepIndex: 0,
      revision: 20,
    },
  });
  tree = h.render();
  assert.match(text(tree), /作業をやめました/);
  assert.doesNotMatch(text(tree), /折る/);
  assert.equal(readSafety((globalThis as any).localStorage, h.key).stopped, true);
});

test('再開前の取得を待つ間に停止すると再開要求を送らず手順を閉じる', async () => {
  const h = harness();
  h.setWaiting();
  let tree = h.render();
  await hooks.flush();
  tree = h.render();
  await hooks.flush();
  tree = h.render();
  let resolveLoad!: (value: unknown) => void;
  const pendingLoad = new Promise((resolve) => {
    resolveLoad = resolve;
  });
  let posts = 0;
  (globalThis as any).learnerApi = async (_path: string, method = 'GET') => {
    if (method === 'POST') {
      posts++;
      return {};
    }
    return pendingLoad;
  };
  const resume = nodes(tree).find(
    (node) => node.type === 'button' && text(node).includes('つづける'),
  );
  const work = resume.props.onClick();
  const stop = nodes(tree).find((node) => node.type === 'button' && text(node).includes('やめる'));
  stop.props.onClick();
  resolveLoad({
    sessionId: 's1',
    releaseId: 'r',
    status: 'waiting_help',
    stepIndex: 0,
    revision: 5,
    steps: [],
  });
  await work;
  await settle();
  tree = h.render();
  assert.equal(posts, 0);
  assert.match(text(tree), /作業をやめました/);
  assert.doesNotMatch(text(tree), /折る/);
  assert.equal(readSafety((globalThis as any).localStorage, h.key).stopped, true);
});

test('開始要求中の停止はセッション取得後に保存され、送信失敗しても残る', async () => {
  const h = harness();
  let resolveStart!: (value: unknown) => void;
  const pendingStart = new Promise((resolve) => {
    resolveStart = resolve;
  });
  (globalThis as any).learnerApi = async (path: string, method = 'GET') => {
    if (path === '/me/assignments') return { assignments: [{ taskId: 't', title: '作業' }] };
    if (path === '/me/sessions' && method === 'POST') return pendingStart;
    throw Error('offline');
  };
  const render = () => {
    hooks.begin();
    return Learner({ uid: 'learner-a', path: '/me', action: async (fn: any) => fn() });
  };
  let tree = render();
  await hooks.flush();
  tree = render();
  const start = nodes(tree).find(
    (node) => node.type === 'button' && text(node).includes('はじめる'),
  );
  start.props.onClick();
  const stop = nodes(tree).find((node) => node.type === 'button' && text(node).includes('やめる'));
  stop.props.onClick();
  const help = nodes(tree).find(
    (node) => node.type === 'button' && text(node).includes('手伝って'),
  );
  help.props.onClick();
  resolveStart({ sessionId: 's1', revision: 3 });
  await settle();
  tree = render();
  await hooks.flush();
  const safety = readSafety((globalThis as any).localStorage, h.key);
  assert.equal(safety.stopped, true);
  assert.equal(safety.pending.length, 1);
  assert.equal(safety.pending[0].type, 'stop');
  assert.match(text(tree), /作業をやめました/);
});

test('開始応答前に再読込しても同じ開始IDと停止IDで復旧し停止を送る', async () => {
  const h = harness();
  h.store.set(
    'pending-start:learner-a',
    JSON.stringify({
      taskId: 't',
      clientRequestId: 'start-original',
      safety: { type: 'stop', clientEventId: 'stop-original' },
    }),
  );
  const calls: any[] = [];
  (globalThis as any).learnerApi = async (path: string, method = 'GET', body?: any) => {
    if (path === '/me/assignments') return { assignments: [{ taskId: 't', title: '作業' }] };
    calls.push({ path, method, body });
    if (path === '/me/sessions') return { sessionId: 's1', revision: 5 };
    throw Error('offline');
  };
  const render = () => {
    hooks.begin();
    return Learner({ uid: 'learner-a', path: '/me', action: async (fn: any) => fn() });
  };
  let tree = render();
  assert.match(text(tree), /作業をやめました/);
  assert.doesNotMatch(text(tree), /はじめる/);
  await hooks.flush();
  await settle();
  tree = render();
  await hooks.flush();
  await settle();
  assert.deepEqual(calls[0].body, { taskId: 't', clientRequestId: 'start-original' });
  const stop = readSafety((globalThis as any).localStorage, h.key);
  assert.equal(stop.stopped, true);
  assert.equal(stop.pending[0].clientEventId, 'stop-original');
  assert.match(text(render()), /作業をやめました/);
});
