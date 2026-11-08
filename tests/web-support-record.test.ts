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
let source = await readFile(new URL('../apps/web/src/support-record.tsx', import.meta.url), 'utf8');
source = source.replace("'react'", JSON.stringify(hookUrl)).replace("'../../../packages/shared/src/support.ts'", JSON.stringify(new URL('../packages/shared/src/support.ts', import.meta.url).href));
const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { SupportRecordForm } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
function nodes(tree: any): any[] { if (Array.isArray(tree)) return tree.flatMap(nodes); if (!React.isValidElement(tree)) return []; return [tree, ...nodes((tree.props as any).children)]; }
function text(tree: any): string { if (Array.isArray(tree)) return tree.map(text).join(''); if (React.isValidElement(tree)) return text((tree.props as any).children); return tree == null ? '' : String(tree); }
const record = { schemaVersion: '1', recordId: 'q', supportRequestId: 'q', learnerId: 'a', taskId: 't', releaseId: 'r', stepId: 's', sessionId: 'session', observedDifficulty: '保存済み', assistanceGiven: '手本', improvementSuggestion: '目印', createdBy: 'staff', updatedBy: 'staff', createdAt: '2026-11-08T00:00:00Z', updatedAt: '2026-11-08T00:00:00Z', revision: 3 };
async function settle() { await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); }

test('後回しで閉じても入力は残り、保存失敗と409後も入力を保持する', async () => {
    hooks.reset(); let open = true, saveCount = 0, getCount = 0; const bodies: any[] = [];
    const api = async (_path: string, method = 'GET', body?: any) => {
        if (method === 'GET') { getCount++; if (getCount === 1) throw Object.assign(Error('未作成'), { status: 404 }); return record; }
        bodies.push(body); saveCount++;
        if (saveCount === 1) throw Error('通信失敗');
        if (saveCount === 2) throw Object.assign(Error('競合'), { status: 409 });
        const { expectedRevision, ...fields } = body;
        return { ...record, ...fields, revision: 4 };
    };
    const close = () => { open = false; };
    const render = () => { hooks.begin(); return SupportRecordForm({ requestId: 'q', open, onClose: close, api }); };
    let tree = render(); await hooks.flush(); tree = render();
    const inputs = nodes(tree).filter(n => n.type === 'textarea');
    inputs[0].props.onChange({ target: { value: '入力中の内容' } });
    tree = render(); nodes(tree).find(n => n.type === 'button' && text(n) === '後で記録する').props.onClick();
    assert.equal(open, false); render(); await hooks.flush(); open = true; tree = render(); await hooks.flush(); tree = render();
    assert.equal(nodes(tree).find(n => n.type === 'textarea').props.value, '入力中の内容');
    nodes(tree).find(n => n.type === 'form').props.onSubmit({ preventDefault() {} }); await settle(); tree = render();
    assert.match(text(tree), /通信失敗/); assert.equal(nodes(tree).find(n => n.type === 'textarea').props.value, '入力中の内容');
    nodes(tree).find(n => n.type === 'form').props.onSubmit({ preventDefault() {} }); await settle(); tree = render();
    assert.match(text(tree), /別の更新/); assert.equal(nodes(tree).find(n => n.type === 'textarea').props.value, '入力中の内容');
    nodes(tree).find(n => n.type === 'button' && text(n) === '最新の記録を確認').props.onClick(); await settle(); tree = render();
    assert.match(text(tree), /保存済み/); nodes(tree).find(n => n.type === 'button' && text(n).includes('最新の版を基準')).props.onClick();
    tree = render(); nodes(tree).find(n => n.type === 'form').props.onSubmit({ preventDefault() {} }); await settle();
    assert.equal(bodies[2].expectedRevision, 3); assert.equal(bodies[2].observedDifficulty, '入力中の内容'); assert.equal(open, false);
    hooks.reset();
});
