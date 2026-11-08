import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import React from 'react';

const sourceHooks = `import React from '${import.meta.resolve('react')}';
let state=[],cursor=0,effects=[],cleanups=[];
export default React;
export function reset(){for(const f of cleanups)f?.();state=[];cleanups=[];cursor=0;effects=[];}
export function begin(){cursor=0;effects=[];}
export function useState(initial){const i=cursor++;if(!(i in state))state[i]=initial;return [state[i],v=>{state[i]=typeof v==='function'?v(state[i]):v}];}
export function useRef(initial){const i=cursor++;return state[i]??={current:initial};}
export function useEffect(fn,deps){const i=cursor++;if(!state[i]||deps.some((v,j)=>v!==state[i][j])){state[i]=deps;effects.push(()=>{cleanups[i]?.();cleanups[i]=fn();});}}
export async function flush(){for(const f of effects)f();await new Promise(r=>setImmediate(r));}`;
const hookUrl = 'data:text/javascript;base64,' + Buffer.from(sourceHooks).toString('base64');
const hooks = await import(hookUrl);
let source = await readFile(new URL('../apps/web/src/staff-support.tsx', import.meta.url), 'utf8');
source = source.replace("'react'", JSON.stringify(hookUrl)).replace("'../../../packages/shared/src/support.ts'", JSON.stringify(new URL('../packages/shared/src/support.ts', import.meta.url).href)).replace("'./support-record.tsx'", JSON.stringify('data:text/javascript,export function SupportRecordForm(){}'));
const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { StaffSupport } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
function nodes(tree: any): any[] { if (Array.isArray(tree)) return tree.flatMap(nodes); if (!React.isValidElement(tree)) return []; return [tree, ...nodes((tree.props as any).children)]; }
function text(tree: any): string { if (Array.isArray(tree)) return tree.map(text).join(''); if (React.isValidElement(tree)) return text((tree.props as any).children); return tree == null ? '' : String(tree); }
const time = '2026-11-08T00:00:00.000Z';
const base = { schemaVersion: '1', requestId: 'q', sessionId: 's', eventId: 'e', learnerId: 'a', stepId: 'one', revision: 1, createdAt: time, kind: 'help' };
async function settle() { await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); }

test('担当外には操作を出さず、担当中は完了と本人確認後の再開を分ける', async () => {
    hooks.reset();
    const own = { ...base, status: 'in_progress', assignedTo: 'staff', assignedAt: time, startedBy: 'staff', startedAt: time };
    const other = { ...own, requestId: 'other', assignedTo: 'other', startedBy: 'other' };
    const stop = { ...base, requestId: 'stop', kind: 'stop', status: 'open' };
    const calls: any[] = [];
    const api = async (path: string, method = 'GET', body?: unknown) => {
        calls.push({ path, method, body });
        if (path === '/staff/me') return { schemaVersion: '1', uid: 'staff' };
        if (path === '/support-requests') return { requests: [own, other, stop] };
        if (path === '/support-requests?status=acknowledged') return { requests: [] };
        if (path.endsWith('/session-state')) return { schemaVersion: '1', sessionId: 's', status: 'waiting_help', revision: 5, currentRequest: true };
        return {};
    };
    const subscribe = () => () => {};
    const render = () => { hooks.begin(); return StaffSupport({ api, go: () => {}, subscribe }); };
    let tree = render(); await hooks.flush(); await settle(); tree = render();
    const sections = nodes(tree).filter(n => n.type === 'section');
    assert.match(text(sections[0]), /対応完了だけを記録/); assert.match(text(sections[0]), /本人に再開の希望/);
    assert.doesNotMatch(text(sections[1]), /対応を始める|対応完了だけを記録|対応を終えてつづける/);
    assert.match(text(sections[2]), /停止を確認した/); assert.doesNotMatch(text(sections[2]), /つづける/);
    const resume = nodes(sections[0]).find(n => n.type === 'button' && text(n).includes('つづける'));
    assert.equal(resume.props.disabled, true);
    nodes(sections[0]).find(n => n.type === 'input').props.onChange({ target: { checked: true } });
    tree = render(); nodes(tree).find(n => n.type === 'button' && text(n).includes('つづける')).props.onClick(); await settle();
    const call = calls.find(c => c.path.endsWith('/resume'));
    assert.equal(call.body.expectedSessionRevision, 5); assert.ok(call.body.clientRequestId);
    hooks.reset();
});

test('担当競合の409は一覧を再取得し成功扱いにしない', async () => {
    hooks.reset(); let loads = 0;
    const api = async (path: string, method = 'GET') => {
        if (path === '/staff/me') return { schemaVersion: '1', uid: 'staff' };
        if (path === '/support-requests') { loads++; return { requests: [{ ...base, status: 'open' }] }; }
        if (path.includes('?status=')) return { requests: [] };
        if (method === 'POST') throw Object.assign(Error('担当済み'), { status: 409 });
    };
    const subscribe = () => () => {};
    const render = () => { hooks.begin(); return StaffSupport({ api, go: () => {}, subscribe }); };
    let tree = render(); await hooks.flush(); await settle(); tree = render();
    nodes(tree).find(n => n.type === 'button' && text(n) === '担当する').props.onClick(); await settle(); tree = render();
    assert.ok(loads >= 2); assert.match(text(tree), /担当済み/); assert.match(text(tree), /対応待ち/);
    hooks.reset();
});

test('停止済みや別の要求を待つセッションには再開操作を表示しない', async () => {
    for (const state of [{ status: 'stopped', currentRequest: false }, { status: 'waiting_help', currentRequest: false }]) {
        hooks.reset();
        const api = async (path: string) => {
            if (path === '/staff/me') return { schemaVersion: '1', uid: 'staff' };
            if (path === '/support-requests') return { requests: [{ ...base, status: 'in_progress', assignedTo: 'staff', assignedAt: time, startedBy: 'staff', startedAt: time }] };
            if (path.includes('?status=')) return { requests: [] };
            return { schemaVersion: '1', sessionId: 's', revision: 6, ...state };
        };
        const subscribe = () => () => {};
        const render = () => { hooks.begin(); return StaffSupport({ api, go: () => {}, subscribe }); };
        render(); await hooks.flush(); await settle();
        assert.doesNotMatch(text(render()), /対応を終えてつづける/);
    }
    hooks.reset();
});

test('応答を失った再開要求は同じIDとrevisionで再試行する', async () => {
    hooks.reset(); const sent: any[] = [];
    const request = { ...base, status: 'in_progress', assignedTo: 'staff', assignedAt: time, startedBy: 'staff', startedAt: time };
    const api = async (path: string, method = 'GET', body?: any) => {
        if (path === '/staff/me') return { schemaVersion: '1', uid: 'staff' };
        if (path === '/support-requests') return { requests: [request] };
        if (path.includes('?status=')) return { requests: [] };
        if (path.endsWith('/session-state')) return { schemaVersion: '1', sessionId: 's', status: 'waiting_help', revision: 5, currentRequest: true };
        if (method === 'POST') { sent.push(body); if (sent.length === 1) throw Error('通信失敗'); return {}; }
    };
    const subscribe = () => () => {};
    const render = () => { hooks.begin(); return StaffSupport({ api, go: () => {}, subscribe }); };
    render(); await hooks.flush(); await settle(); let tree = render();
    nodes(tree).find(n => n.type === 'input').props.onChange({ target: { checked: true } });
    tree = render(); nodes(tree).find(n => n.type === 'button' && text(n).includes('つづける')).props.onClick(); await settle();
    tree = render(); assert.match(text(tree), /通信失敗/);
    nodes(tree).find(n => n.type === 'button' && text(n).includes('つづける')).props.onClick(); await settle();
    assert.equal(sent.length, 2); assert.deepEqual(sent[0], sent[1]);
    hooks.reset();
});

test('対応開始時に記録を開き、完了後も後入力の導線を残す', async () => {
    hooks.reset(); let status = 'assigned';
    const api = async (path: string, method = 'GET') => {
        if (path === '/staff/me') return { schemaVersion: '1', uid: 'staff' };
        const q = { ...base, status, assignedTo: 'staff', assignedAt: time, ...(status !== 'assigned' ? { startedBy: 'staff', startedAt: time } : {}), ...(status === 'acknowledged' ? { acknowledgedBy: 'staff', acknowledgedAt: time } : {}) };
        if (path === '/support-requests') return { requests: status === 'acknowledged' ? [] : [q] };
        if (path.includes('?status=')) return { requests: status === 'acknowledged' ? [q] : [] };
        if (path.endsWith('/session-state')) return { schemaVersion: '1', sessionId: 's', status: 'waiting_help', revision: 5, currentRequest: true };
        if (method === 'POST' && path.endsWith('/start')) status = 'in_progress';
        if (method === 'POST' && path.endsWith('/acknowledge')) status = 'acknowledged';
        return {};
    };
    const subscribe = () => () => {};
    const render = () => { hooks.begin(); return StaffSupport({ api, go: () => {}, subscribe }); };
    render(); await hooks.flush(); await settle(); let tree = render();
    nodes(tree).find(n => n.type === 'button' && text(n) === '対応を始める').props.onClick(); await settle(); tree = render();
    assert.ok(nodes(tree).some(n => n.props?.requestId === 'q' && n.props?.open === true));
    nodes(tree).find(n => n.type === 'button' && text(n) === '対応完了だけを記録').props.onClick(); await settle(); tree = render();
    assert.match(text(tree), /対応完了/); assert.match(text(tree), /支援記録を開く/);
    assert.ok(nodes(tree).some(n => n.props?.requestId === 'q'));
    hooks.reset();
});
