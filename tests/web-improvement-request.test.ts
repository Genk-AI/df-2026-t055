import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import React from 'react';
const hookSource = `import React from '${import.meta.resolve('react')}';
let state=[],cursor=0,effects=[],cleanups=[];
export default React;
export function reset(){for(const f of cleanups)f?.();state=[];cursor=0;effects=[];cleanups=[];}
export function begin(){cursor=0;effects=[];}
export function useState(initial){const i=cursor++;if(!(i in state))state[i]=initial;return [state[i],v=>state[i]=typeof v==='function'?v(state[i]):v];}
export function useRef(initial){const i=cursor++;return state[i]??={current:initial};}
export function useEffect(fn,deps){const i=cursor++;if(!state[i]||deps.some((v,j)=>v!==state[i][j])){state[i]=deps;effects.push(()=>{cleanups[i]?.();cleanups[i]=fn();});}}
export async function flush(){for(const f of effects)f();await new Promise(r=>setImmediate(r));}`;
const hookUrl = 'data:text/javascript;base64,' + Buffer.from(hookSource).toString('base64');
const hooks = await import(hookUrl);
let source = await readFile(new URL('../apps/web/src/staff-improvement-request.tsx', import.meta.url), 'utf8');
source = source.replace("'react'", JSON.stringify(hookUrl)).replace("'../../../packages/shared/src/work-guides.ts'", JSON.stringify(new URL('../packages/shared/src/work-guides.ts', import.meta.url).href)).replace("'../../../packages/shared/src/generation.ts'", JSON.stringify(new URL('../packages/shared/src/generation.ts', import.meta.url).href));
const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { StaffImprovementRequest } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
function nodes(tree: any): any[] { if (Array.isArray(tree)) return tree.flatMap(nodes); if (!React.isValidElement(tree)) return []; return [tree, ...nodes((tree.props as any).children)]; }
function text(tree: any): string { if (Array.isArray(tree)) return tree.map(text).join(''); if (React.isValidElement(tree)) return text((tree.props as any).children); return tree == null ? '' : String(tree); }
const record = { schemaVersion: '1', recordId: 'record', supportRequestId: 'req', learnerId: 'a', taskId: 'task', releaseId: 'release', stepId: 's', sessionId: 'session', observedDifficulty: '原文', assistanceGiven: '', improvementSuggestion: '', createdBy: 'staff', updatedBy: 'staff', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', revision: 1, applied: false };
test('送信確認と失敗後の再試行で要約と冪等キーを保持する', async () => {
    hooks.reset(); const payloads: any[] = [];
    const api = async (_path: string, method?: string, body?: any) => { if (!method) return { schemaVersion: '1', records: [record] }; payloads.push(body); if (payloads.length === 1) throw Error('offline'); return { schemaVersion: '1', jobId: 'job', draftId: 'draft' }; };
    let destination = '';
    const render = () => { hooks.begin(); return StaffImprovementRequest({ learnerId: 'a', taskId: 'task', title: '作業', releaseId: 'release', currentReleaseId: 'release', api, close() {}, changeRelease() {}, go(p: string) { destination = p; } }); };
    render(); await hooks.flush(); let tree = render();
    nodes(tree).find(n => n.type === 'input' && n.props.type === 'checkbox').props.onChange({ target: { checked: true } });
    tree = render(); nodes(tree).find(n => n.type === 'textarea').props.onChange({ target: { value: '確認済み要約' } });
    tree = render(); const boxes = nodes(tree).filter(n => n.type === 'input' && n.props.type === 'checkbox'); boxes[1].props.onChange({ target: { checked: true } });
    tree = render(); const submit = () => nodes(tree).find(n => n.type === 'button' && text(n) === '改善を依頼する');
    assert.equal(submit().props.disabled, false); await submit().props.onClick(); await new Promise(r => setImmediate(r));
    tree = render(); assert.match(text(tree), /入力を保持/); assert.equal(nodes(tree).find(n => n.type === 'textarea').props.value, '確認済み要約');
    await submit().props.onClick(); await new Promise(r => setImmediate(r)); tree = render();
    assert.equal(payloads[0].clientRequestId, payloads[1].clientRequestId);
    assert.equal(JSON.stringify(payloads[0]).includes('原文'), false);
    assert.match(text(tree), /次回版はまだ変わっていません/);
    nodes(tree).find(n => n.type === 'button' && text(n) === '下書きを確認する').props.onClick();
    assert.equal(destination, '/staff/tasks/task/drafts/draft'); hooks.reset();
});
test('409後に最新記録を読み直しても入力を維持し、版を選び直せる', async () => {
    hooks.reset(); let revision = 1; let posts = 0;
    const api = async (_path: string, method?: string) => { if (!method) return { schemaVersion: '1', records: [{ ...record, revision }] }; posts++; throw Object.assign(Error('conflict'), { status: 409 }); };
    const render = () => { hooks.begin(); return StaffImprovementRequest({ learnerId: 'a', taskId: 'task', title: '作業', releaseId: 'release', currentReleaseId: 'release', api, close() {}, changeRelease() {}, go() {} }); };
    render(); await hooks.flush(); let tree = render();
    nodes(tree).find(n => n.type === 'input' && n.props.type === 'checkbox').props.onChange({ target: { checked: true } });
    tree = render(); nodes(tree).find(n => n.type === 'textarea').props.onChange({ target: { value: '残したい要約' } });
    tree = render(); nodes(tree).filter(n => n.type === 'input' && n.props.type === 'checkbox')[1].props.onChange({ target: { checked: true } });
    tree = render(); nodes(tree).find(n => n.type === 'button' && text(n) === '改善を依頼する').props.onClick(); await new Promise(r => setImmediate(r));
    tree = render(); assert.match(text(tree), /入力は保持/); assert.equal(posts, 1);
    revision = 2; nodes(tree).find(n => n.type === 'button' && text(n) === '最新の記録を読み直す').props.onClick(); await new Promise(r => setImmediate(r));
    tree = render(); assert.equal(nodes(tree).find(n => n.type === 'textarea').props.value, '残したい要約');
    assert.equal(nodes(tree).find(n => n.type === 'button' && text(n) === '改善を依頼する').props.disabled, true);
    nodes(tree).find(n => n.type === 'button' && text(n) === 'この版を選び直す').props.onClick();
    tree = render(); assert.equal(nodes(tree).find(n => n.type === 'textarea').props.value, '残したい要約'); hooks.reset();
});
