import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import React from 'react';
import {
  learnerControlPath,
  imageFailureText,
  type LearnerControlLabel,
  type LearnerPictogramLabel,
} from '../apps/web/src/learner-controls.ts';

test('original pictograms and audio controls are distinct and failures retain approved alt text', () => {
  const labels: LearnerControlLabel[] = [
    'はじめる',
    'もどる',
    'つぎへ',
    'おわる',
    'おわります',
    '手伝って',
    'やめる',
    'つづける',
    '読み上げる',
    '音声をとめる',
  ];
  assert.equal(new Set(labels.map(learnerControlPath)).size, labels.length);
  assert.notEqual(learnerControlPath('手伝って'), learnerControlPath('やめる'));
  assert.equal(
    imageFailureText('タオルの端を合わせる', true),
    '写真を表示できません：タオルの端を合わせる',
  );
  assert.equal(imageFailureText('手元', false), undefined);
});

function nodes(tree: any): any[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!React.isValidElement(tree)) return [];
  return [tree, ...nodes((tree.props as any).children)];
}
function text(tree: any): string {
  if (Array.isArray(tree)) return tree.map(text).join('');
  // ルビの読み（rt）は aria-hidden なので、表示名・アクセシブル名には数えない。
  if (React.isValidElement(tree))
    return tree.type === 'rt' ? '' : text((tree.props as any).children);
  return tree == null ? '' : String(tree);
}
const main = await readFile(new URL('../apps/web/src/main.tsx', import.meta.url), 'utf8');
const source =
  main.slice(main.indexOf('function Asset('), main.indexOf('\nfunction App(')) +
  main.slice(main.indexOf('function learnerControlContent('), main.indexOf('\ncreateRoot('));
const hookSource = `import React from '${import.meta.resolve('react')}';export default React;
let state=[],cursor=0,effects=[],cleanups=[];
export function begin(){cursor=0;effects=[]}
export function reset(){cleanups.forEach(f=>f?.());state=[];cleanups=[];begin()}
export function useState(v){const i=cursor++;if(!(i in state))state[i]=v;return[state[i],v=>state[i]=v]}
export function useRef(v){const i=cursor++;return state[i]??={current:v}}
export function useEffect(fn,deps){const i=cursor++;if(!state[i]||deps.some((v,j)=>v!==state[i][j])){state[i]=deps;effects.push(()=>{cleanups[i]?.();cleanups[i]=fn()})}}
export async function flush(){effects.forEach(fn=>fn());await new Promise(r=>setImmediate(r))}
`;
const url = 'data:text/javascript;base64,' + Buffer.from(hookSource).toString('base64'),
  hooks = await import(url);
const imports = `import React,{useState,useEffect,useRef} from ${JSON.stringify(url)};
import {imageFailureText,learnerControlPath} from ${JSON.stringify(new URL('../apps/web/src/learner-controls.ts', import.meta.url).href)};
const getToken=async()=>'test';export `;
const compiled = ts.transpileModule(imports + source, {
  compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.ESNext },
}).outputText;
const { Asset } = await import(
  'data:text/javascript;base64,' + Buffer.from(compiled).toString('base64')
);
const renderAsset = (id: string, extra = {}) => {
  hooks.begin();
  return Asset({ id, alt: '手元の写真', ...extra });
};

test('actual Asset replaces decode and HTTP failures and recovers on asset change', async () => {
  hooks.reset();
  const fetchBefore = globalThis.fetch;
  let ok = true;
  globalThis.fetch = (async () => ({ ok, blob: async () => new Blob(['image']) })) as any;
  try {
    renderAsset('one');
    await hooks.flush();
    let tree = renderAsset('one');
    assert.equal(tree.type, 'img');
    assert.equal(tree.props.alt, '手元の写真');
    tree.props.onError();
    tree = renderAsset('one');
    assert.equal(tree.type, 'div');
    assert.equal(tree.props.role, 'status');
    assert.equal(tree.props.children, '写真を表示できません：手元の写真');
    renderAsset('two');
    await hooks.flush();
    assert.equal(renderAsset('two').type, 'img');
    ok = false;
    renderAsset('three');
    await hooks.flush();
    assert.equal(renderAsset('three').props.children, '写真を表示できません：手元の写真');
    renderAsset('audio', { audio: true });
    await hooks.flush();
    tree = renderAsset('audio', { audio: true });
    assert.match(text(tree), /音声を再生できません。近くの職員をよんでください/);
    assert.equal(nodes(tree).find((n) => n.type === 'button').props.disabled, true);
    renderAsset('video', { video: true });
    await hooks.flush();
    assert.equal(renderAsset('video', { video: true }).props.children, '写真・動画を読み込み中');
  } finally {
    globalThis.fetch = fetchBefore;
    hooks.reset();
  }
});

test('読み上げは名前と絵のある標準ボタンで再生・停止・再聴取でき、失敗と終了を表示に反映する', async () => {
  hooks.reset();
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, blob: async () => new Blob(['audio']) })) as any;
  let playCount = 0,
    pauseCount = 0,
    rejectPlay = false;
  const element = {
    paused: true,
    currentTime: 0,
    play: async () => {
      playCount++;
      if (rejectPlay) throw Error('再生失敗');
      element.paused = false;
    },
    pause: () => {
      pauseCount++;
      element.paused = true;
    },
  };
  const checkButton = (tree: any, label: LearnerControlLabel) => {
    const button = nodes(tree).find((n) => n.type === 'button');
    assert.equal(text(button), label);
    assert.equal(button.props.type, 'button');
    assert.equal(button.props.disabled, false);
    // Native Enter/Space activation and focus are preserved: no custom key handler or tabindex.
    assert.equal(button.props.tabIndex, undefined);
    assert.equal(button.props.onKeyDown, undefined);
    const svg = nodes(button).find((n) => n.type === 'svg');
    assert.equal(svg.props['aria-hidden'], 'true');
    assert.equal(svg.props.focusable, 'false');
    assert.equal(nodes(svg).find((n) => n.type === 'path').props.d, learnerControlPath(label));
    return button;
  };
  try {
    let tree = renderAsset('voice', { audio: true });
    assert.match(text(tree), /音声を読み込み中/);
    await hooks.flush();
    tree = renderAsset('voice', { audio: true });
    const audio = nodes(tree).find((n) => n.type === 'audio');
    assert.equal(audio.props.controls, undefined);
    assert.equal(audio.props.autoPlay, undefined);
    assert.equal(audio.props.preload, 'metadata');
    audio.props.ref.current = element;
    await hooks.flush();
    await checkButton(tree, '読み上げる').props.onClick();
    audio.props.onPlay();
    tree = renderAsset('voice', { audio: true });
    element.currentTime = 3;
    await checkButton(tree, '音声をとめる').props.onClick();
    audio.props.onPause();
    assert.equal(element.currentTime, 0);
    assert.equal(pauseCount, 1);
    tree = renderAsset('voice', { audio: true });
    await checkButton(tree, '読み上げる').props.onClick();
    assert.equal(playCount, 2);
    audio.props.onPlay();
    audio.props.onEnded();
    element.paused = true;
    tree = renderAsset('voice', { audio: true });
    rejectPlay = true;
    await checkButton(tree, '読み上げる').props.onClick();
    tree = renderAsset('voice', { audio: true });
    assert.match(text(tree), /音声を再生できません/);
    rejectPlay = false;
    await checkButton(tree, '読み上げる').props.onClick();
    assert.doesNotMatch(text(renderAsset('voice', { audio: true })), /音声を再生できません/);
    audio.props.onError();
    assert.match(text(renderAsset('voice', { audio: true })), /音声を再生できません/);
    hooks.reset();
    assert.equal(pauseCount, 2, '画面を閉じると音声も停止する');
  } finally {
    globalThis.fetch = fetchBefore;
    hooks.reset();
  }
});

test('送信・待機・担当決定・対応・停止・失敗は色に依存しない異なる形を持つ', () => {
  const labels: LearnerPictogramLabel[] = [
    '作業中',
    '送信中',
    '職員をよんでいます',
    '担当が決まりました',
    '対応中',
    '対応が終わりました',
    '作業をやめました',
    '送れませんでした',
  ];
  assert.equal(new Set(labels.map(learnerControlPath)).size, labels.length);
});

test('読み上げボタンの漢字にルビを付け、読みは支援技術から隠してアクセシブル名を変えない', async () => {
  hooks.reset();
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, blob: async () => new Blob(['audio']) })) as any;
  try {
    renderAsset('voice', { audio: true });
    await hooks.flush();
    const button = nodes(renderAsset('voice', { audio: true })).find((n) => n.type === 'button');
    assert.equal(text(button), '読み上げる');
    assert.equal(button.props['aria-label'], undefined);
    const rts = nodes(button).filter((n) => n.type === 'rt');
    assert.deepEqual(
      rts.map((n) => n.props.children),
      ['よ', 'あ'],
    );
    assert.ok(rts.every((n) => n.props['aria-hidden'] === 'true'));
    assert.deepEqual(
      nodes(button)
        .filter((n) => n.type === 'ruby')
        .map((n) => (n.props.children as any[])[0]),
      ['読', '上'],
    );
  } finally {
    globalThis.fetch = fetchBefore;
    hooks.reset();
  }
});

test('CSS contract: native focus, non-color disabled cue, narrow and 200% text wrapping', async () => {
  const css = await readFile(new URL('../apps/web/src/style.css', import.meta.url), 'utf8');
  assert.match(css, /button:focus-visible[^}]*outline:4px solid #9a4a00;outline-offset:3px/);
  assert.match(css, /\.learner button:disabled\{[^}]*border:3px dashed currentColor/);
  assert.match(
    css,
    /\.learner button\{[^}]*max-width:100%;min-width:0;width:100%[^}]*white-space:normal;overflow-wrap:anywhere/,
  );
  assert.match(css, /\.learner \.control-icon\{width:1.5em;height:1.5em;flex:none/);
  assert.match(
    css,
    /@media\(max-width:760px\)\{\.learner \.controls,\.learner \.safety\{grid-template-columns:minmax\(0,1fr\)/,
  );
  assert.match(css, /\.learner\{padding-bottom:16em\}\.learner \.safety\{position:fixed;bottom:0/);
  // Structural checks only: em icons scale with 200% text; no fixed height,
  // one flexible column and normal wrapping. Real layout/keyboard/AT remain unverified.
});

test('CSS contract: UI colors meet 4.5:1 contrast and old low-contrast values are gone', async () => {
  const css = await readFile(new URL('../apps/web/src/style.css', import.meta.url), 'utf8');
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (fg: string, bg: string) => {
    const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  };
  const pairs: Array<[string, string[]]> = [
    ['#3f6c67', ['#ffffff', '#f2f7f5', '#e4eeea']],
    ['#4f6965', ['#ffffff', '#e8efec']],
    ['#9a4a00', ['#ffffff', '#f2f7f5', '#e4eeea']],
    ['#ffd27a', ['#174e4b']],
    ['#7a5c0c', ['#e4eeea', '#ffe9a3']],
  ];
  for (const [fg, bgs] of pairs) {
    assert.ok(css.includes(fg), `style.css must contain ${fg}`);
    for (const bg of bgs) {
      const r = ratio(fg, bg);
      assert.ok(r >= 4.5, `${fg} on ${bg} is ${r.toFixed(2)}:1, below 4.5:1`);
    }
  }
  assert.ok(!css.includes('#e3a830'));
  assert.ok(!/(input|textarea|select)[^{]*\{[^}]*#8ea6a3/.test(css));
  assert.ok(!css.includes('#8ea6a3'));
  assert.ok(!css.includes('#568580'));
  assert.ok(!css.includes('#b0882b'));
  assert.ok(!css.includes('opacity:.45'));
});
