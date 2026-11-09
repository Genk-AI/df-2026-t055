import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import React from 'react';
let source = await readFile(
  new URL('../apps/web/src/improvement-review.tsx', import.meta.url),
  'utf8',
);
source = source.replace("'react'", JSON.stringify(import.meta.resolve('react')));
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    jsx: ts.JsxEmit.React,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
}).outputText;
const { ImprovementReview } = await import(
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
test('元版と改善内容、参照記録と採用を分けて示す', () => {
  let chosen: any;
  const ranges: number[][] = [];
  const tree = ImprovementReview({
    source: {
      videoAssetId: 'video',
      learnerSteps: [{ text: '元の文', imageAltText: '元の写真', visibleCaution: '' }],
      staffGuide: [{ sourceStartMs: 100, sourceEndMs: 200 }],
    },
    steps: [
      {
        text: '新しい文',
        imageAltText: '新しい写真',
        visibleCaution: '',
        sourceStartMs: 150,
        sourceEndMs: 250,
      },
    ],
    references: [{ recordId: 'r', revision: 2, summary: '確認済み要約' }],
    selected: [],
    onChange(refs: any) {
      chosen = refs;
    },
    video(_id: string, start: number, end: number) {
      ranges.push([start, end]);
      return null;
    },
  });
  assert.match(text(tree), /元の文/);
  assert.match(text(tree), /新しい文/);
  assert.match(text(tree), /確認済み要約/);
  assert.match(text(tree), /参照しただけの記録は未反映/);
  assert.deepEqual(ranges, [
    [100, 200],
    [150, 250],
  ]);
  nodes(tree)
    .find((n) => n.type === 'input')
    .props.onChange({ target: { checked: true } });
  assert.deepEqual(chosen, [{ recordId: 'r', revision: 2 }]);
});
