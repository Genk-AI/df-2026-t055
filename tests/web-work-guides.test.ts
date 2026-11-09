import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import React from 'react';

const hooksSource = `import React from '${import.meta.resolve('react')}';
let state=[],cursor=0,effects=[],cleanups=[];
export default React;
export function reset(){for(const f of cleanups)f?.();state=[];cleanups=[];cursor=0;effects=[];}
export function begin(){cursor=0;effects=[];}
export function useState(initial){const i=cursor++;if(!(i in state))state[i]=initial;return [state[i],v=>{state[i]=typeof v==='function'?v(state[i]):v}];}
export function useEffect(fn,deps){const i=cursor++;if(!state[i]||deps.some((v,j)=>v!==state[i][j])){state[i]=deps;effects.push(()=>{cleanups[i]?.();cleanups[i]=fn();});}}
export async function flush(){for(const f of effects)f();await new Promise(r=>setImmediate(r));}`;
const hookUrl = 'data:text/javascript;base64,' + Buffer.from(hooksSource).toString('base64');
const hooks = await import(hookUrl);
let source = await readFile(new URL('../apps/web/src/staff-work-guides.tsx', import.meta.url), 'utf8');
source = source.replace("'./staff-improvement-request.tsx'", JSON.stringify('data:text/javascript,export const StaffImprovementRequest=()=>null')).replace("'react'", JSON.stringify(hookUrl)).replace("'../../../packages/shared/src/work-guides.ts'", JSON.stringify(new URL('../packages/shared/src/work-guides.ts', import.meta.url).href));
const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { StaffWorkGuides } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
function nodes(tree: any): any[] { if (Array.isArray(tree)) return tree.flatMap(nodes); if (!React.isValidElement(tree)) return []; return [tree, ...nodes((tree.props as any).children)]; }
function text(tree: any): string { if (Array.isArray(tree)) return tree.map(text).join(''); if (React.isValidElement(tree)) return text((tree.props as any).children); return tree == null ? '' : String(tree); }
const item = { taskId: 'task', title: 'タオル', assignment: { releaseId: 'r/1', version: 2 }, unappliedCount: 3, latestDraft: { draftId: 'd', status: 'generating', revision: 1 }, latestGeneration: { jobId: 'j', status: 'running' } };

test('生成中でも次回版・未反映数を示し、承認版へ移動できる', async () => {
    hooks.reset(); let destination = '';
    const api = async () => ({ schemaVersion: '1', items: [item] });
    const render = () => { hooks.begin(); return StaffWorkGuides({ learnerId: 'a', api, go: (path: string) => { destination = path; } }); };
    let tree = render(); await hooks.flush(); tree = render();
    assert.match(text(tree), /タオル/); assert.match(text(tree), /版 2/); assert.match(text(tree), /3件/); assert.match(text(tree), /生成中/);
    nodes(tree).find(node => node.type === 'button').props.onClick();
    assert.equal(destination, '/staff/handover/releases/r%2F1');
    hooks.reset();
});

test('本人切替後は古いカードを表示せず遅延レスポンスも採用しない', async () => {
    hooks.reset(); let resolveA!: (v: unknown) => void;
    const pending = new Promise(resolve => { resolveA = resolve; });
    const api = async (path: string) => path.includes('/a/') ? pending : { schemaVersion: '1', items: [{ ...item, title: '封筒' }] };
    const render = (learnerId: string) => { hooks.begin(); return StaffWorkGuides({ learnerId, api, go: () => {} }); };
    render('a'); await hooks.flush();
    let tree = render('b'); assert.doesNotMatch(text(tree), /タオル/); await hooks.flush();
    resolveA({ schemaVersion: '1', items: [item] }); await new Promise(r => setImmediate(r));
    tree = render('b'); assert.match(text(tree), /封筒/); assert.doesNotMatch(text(tree), /タオル/);
    hooks.reset();
});
