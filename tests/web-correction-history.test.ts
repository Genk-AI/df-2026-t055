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
const hookUrl = 'data:text/javascript;base64,' + Buffer.from(hookSource).toString('base64'); const hooks = await import(hookUrl);
let source = await readFile(new URL('../apps/web/src/staff-correction-history.tsx', import.meta.url), 'utf8');
source = source.replace("'react'", JSON.stringify(hookUrl)).replace("'../../../packages/shared/src/generation.ts'", JSON.stringify(new URL('../packages/shared/src/generation.ts', import.meta.url).href));
const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { StaffCorrectionHistory } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
function text(tree: any): string { if (Array.isArray(tree)) return tree.map(text).join(''); if (React.isValidElement(tree)) return text((tree.props as any).children); return tree == null ? '' : String(tree); }
const item = { schemaVersion: '1', correctionId: 'c', taskId: 't', learnerId: 'a', draftId: 'd', draftRevision: 2, changes: [{ stepId: 's', field: 'text', before: '前', after: '後' }], reason: '職員の理由', createdBy: 'staff', createdAt: '2026-01-01T00:00:00.000Z' };
test('職員の保存内容と未承認のAI参考メモを分け、失敗時も履歴を表示する', async () => {
    hooks.reset();
    const api = async () => ({ corrections: [{ ...item, contextJobStatus: 'failed' }, { ...item, correctionId: 'c2', contextSummary: { editSummary: '参考要約', nextDraftHint: '参考提案', reviewFlags: [] } }] });
    const render = () => { hooks.begin(); return StaffCorrectionHistory({ learnerId: 'a', taskId: 't', api, close() {} }); };
    render(); await hooks.flush(); const tree = render();
    assert.match(text(tree), /職員が保存した手直し/); assert.match(text(tree), /変更前：前/); assert.match(text(tree), /変更後：後/);
    assert.match(text(tree), /AIの参考メモ（未承認）/); assert.match(text(tree), /参考要約/); assert.match(text(tree), /参考メモを作れませんでした/); hooks.reset();
});
