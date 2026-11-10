import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import React from 'react';

// 既存の tests/web-support-record.test.ts と同じ方式で、フックをモックした状態で
// support-record.tsx を読み込み、React 要素ツリーを検査する。MediaRecorder は Node に
// 無いため、speech-recorder.ts は data URL のスタブへ差し替える。
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

// 録音スタブ。startRecording の呼び出し回数と、cancel/stop の記録を確認する。
// globalThis.recorderModeBridge でマイク拒否などの失敗を再現する。
const recorderLog = { started: 0, cancelled: 0, stopped: 0 };
const sourceRecorder = `export const MAX_RECORDING_MS=60000;
export async function startRecording(){
  globalThis.recorderLogBridge.started++;
  const mode=globalThis.recorderModeBridge;
  if(mode==='denied')throw Object.assign(Error('Permission denied'),{name:'NotAllowedError'});
  if(mode==='unsupported')throw Object.assign(Error('RECORDING_UNSUPPORTED'),{code:'RECORDING_UNSUPPORTED'});
  return {
    stop(){globalThis.recorderLogBridge.stopped++;return Promise.resolve(new Blob(['raw'],{type:'audio/webm'}));},
    cancel(){globalThis.recorderLogBridge.cancelled++;}
  };
}
export async function encodeWav(blob){
  const mode=globalThis.recorderModeBridge;
  if(mode==='decode-failed')throw Object.assign(Error('DECODE_FAILED'),{code:'DECODE_FAILED'});
  if(mode==='too-short')throw Object.assign(Error('AUDIO_TOO_SHORT'),{code:'AUDIO_TOO_SHORT'});
  return new Blob(['wav'],{type:'audio/wav'});
}
export const TARGET_SAMPLE_RATE=16000;
export const MAX_WAV_BYTES=5*1024*1024;`;
const recorderUrl = 'data:text/javascript;base64,' + Buffer.from(sourceRecorder).toString('base64');
(globalThis as any).recorderLogBridge = recorderLog;
(globalThis as any).recorderModeBridge = '';

let source = await readFile(new URL('../apps/web/src/support-record.tsx', import.meta.url), 'utf8');
source = source
  .replace("'react'", JSON.stringify(hookUrl))
  .replace(
    "'../../../packages/shared/src/support.ts'",
    JSON.stringify(new URL('../packages/shared/src/support.ts', import.meta.url).href),
  )
  .replace("'./speech-recorder.ts'", JSON.stringify(recorderUrl));
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    jsx: ts.JsxEmit.React,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
}).outputText;
const { SupportRecordForm } = await import(
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
const record = {
  schemaVersion: '1',
  recordId: 'q',
  supportRequestId: 'q',
  learnerId: 'a',
  taskId: 't',
  releaseId: 'r',
  stepId: 's',
  sessionId: 'session',
  observedDifficulty: '保存済み',
  assistanceGiven: '手本',
  improvementSuggestion: '目印',
  createdBy: 'staff',
  updatedBy: 'staff',
  createdAt: '2026-11-08T00:00:00Z',
  updatedAt: '2026-11-08T00:00:00Z',
  revision: 3,
};
async function settle() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}
function resetLog() {
  recorderLog.started = 0;
  recorderLog.cancelled = 0;
  recorderLog.stopped = 0;
  (globalThis as any).recorderModeBridge = '';
}
const api = async () => record;
const labels = ['どこでつまずいたか', '何をしたか', '次回の改善提案'];
function speechButtons(tree: any) {
  return nodes(tree).filter(
    (n) => n.type === 'button' && String(n.props['aria-label'] ?? '').endsWith('を音声で入力'),
  );
}
function textareas(tree: any) {
  return nodes(tree).filter((n) => n.type === 'textarea' && !n.props.readOnly);
}
function buttonByText(tree: any, label: string) {
  return nodes(tree).find((n) => n.type === 'button' && text(n) === label);
}

test('3つの欄それぞれに音声入力ボタンが出る', async () => {
  hooks.reset();
  resetLog();
  const render = () => {
    hooks.begin();
    return SupportRecordForm({
      requestId: 'q',
      open: true,
      onClose() {},
      api,
      transcribe: async () => ({ transcript: 'x' }),
    });
  };
  let tree = render();
  await hooks.flush();
  tree = render();
  const buttons = speechButtons(tree);
  assert.equal(buttons.length, 3);
  for (const [i, label] of labels.entries())
    assert.equal(buttons[i].props['aria-label'], `「${label}」を音声で入力`);
  // ボタンはキーボードで操作できる type='button' で、欄の直後に置く。
  for (const button of buttons) assert.equal(button.props.type, 'button');
  hooks.reset();
});

test('認識結果は確認ブロックに出し、欄へ入れるまで欄を変えない', async () => {
  hooks.reset();
  resetLog();
  const render = () => {
    hooks.begin();
    return SupportRecordForm({
      requestId: 'q',
      open: true,
      onClose() {},
      api,
      transcribe: async (_path: string, _blob: Blob) => ({ transcript: '赤い線に合わせた' }),
    });
  };
  let tree = render();
  await hooks.flush();
  tree = render();
  assert.equal(textareas(tree)[0].props.value, '保存済み');
  speechButtons(tree)[0].props.onClick();
  await settle();
  tree = render();
  assert.match(text(tree), /録音しています。話し終えたら停止してください。/);
  const stop = nodes(tree).find((n) => n.type === 'button' && text(n) === '録音を停止');
  assert.ok(stop);
  stop.props.onClick();
  await settle();
  tree = render();
  // 確認待ちのあいだ、欄の値は変わらない。
  assert.equal(textareas(tree)[0].props.value, '保存済み');
  const group = nodes(tree).find(
    (n) => n.props.role === 'group' && n.props['aria-label'] === '音声入力の確認',
  );
  assert.ok(group, '確認ブロックが出る');
  assert.match(text(group), /音声入力の確認/);
  // 認識結果は読み取り専用の欄に出す（value なので text() ではなく props を見る）。
  const preview = nodes(group).find((n) => n.type === 'textarea');
  assert.ok(preview, '認識結果を表示する');
  assert.equal(preview.props.readOnly, true);
  assert.equal(preview.props.value, '赤い線に合わせた');
  assert.ok(buttonByText(group, 'この内容を欄に入れる'));
  assert.ok(buttonByText(group, '取り消す'));
  hooks.reset();
});

test('反映は既存の文字の末尾に改行を挟んで追記し、既存文字を失わない', async () => {
  hooks.reset();
  resetLog();
  const render = () => {
    hooks.begin();
    return SupportRecordForm({
      requestId: 'q',
      open: true,
      onClose() {},
      api,
      transcribe: async () => ({ transcript: '赤い線に合わせた' }),
    });
  };
  let tree = render();
  await hooks.flush();
  tree = render();
  speechButtons(tree)[0].props.onClick();
  await settle();
  tree = render();
  nodes(tree)
    .find((n) => n.type === 'button' && text(n) === '録音を停止')
    .props.onClick();
  await settle();
  tree = render();
  buttonByText(tree, 'この内容を欄に入れる').props.onClick();
  tree = render();
  assert.equal(textareas(tree)[0].props.value, '保存済み\n赤い線に合わせた');
  assert.equal(textareas(tree)[1].props.value, '手本');
  assert.equal(textareas(tree)[2].props.value, '目印');
  // 確認ブロックは消え、追記後も文字入力を続けられる。
  assert.equal(
    nodes(tree).find((n) => n.props['aria-label'] === '音声入力の確認'),
    undefined,
  );
  textareas(tree)[0].props.onChange({ target: { value: '保存済み\n赤い線に合わせた。続き' } });
  tree = render();
  assert.equal(textareas(tree)[0].props.value, '保存済み\n赤い線に合わせた。続き');
  hooks.reset();
});

test('取り消すと欄は一切変わらず、確認ブロックも消える', async () => {
  hooks.reset();
  resetLog();
  const render = () => {
    hooks.begin();
    return SupportRecordForm({
      requestId: 'q',
      open: true,
      onClose() {},
      api,
      transcribe: async () => ({ transcript: '入れない文' }),
    });
  };
  let tree = render();
  await hooks.flush();
  tree = render();
  speechButtons(tree)[1].props.onClick();
  await settle();
  tree = render();
  nodes(tree)
    .find((n) => n.type === 'button' && text(n) === '録音を停止')
    .props.onClick();
  await settle();
  tree = render();
  buttonByText(tree, '取り消す').props.onClick();
  tree = render();
  assert.equal(textareas(tree)[1].props.value, '手本');
  assert.equal(
    nodes(tree).find((n) => n.props['aria-label'] === '音声入力の確認'),
    undefined,
  );
  assert.doesNotMatch(text(tree), /入れない文/);
  hooks.reset();
});

test('文字起こしが失敗しても alert を出し、入力済みの文字を残す', async () => {
  hooks.reset();
  resetLog();
  const render = () => {
    hooks.begin();
    return SupportRecordForm({
      requestId: 'q',
      open: true,
      onClose() {},
      api,
      transcribe: async () => {
        throw Object.assign(Error('SPEECH_REQUEST_FAILED：失敗'), {
          status: 502,
          code: 'SPEECH_REQUEST_FAILED',
        });
      },
    });
  };
  let tree = render();
  await hooks.flush();
  tree = render();
  textareas(tree)[0].props.onChange({ target: { value: '入力中の内容' } });
  tree = render();
  speechButtons(tree)[0].props.onClick();
  await settle();
  tree = render();
  nodes(tree)
    .find((n) => n.type === 'button' && text(n) === '録音を停止')
    .props.onClick();
  await settle();
  tree = render();
  const alert = nodes(tree).find((n) => n.props.role === 'alert');
  assert.ok(alert, '失敗は alert で伝える');
  assert.match(text(alert), /音声を文字にできませんでした。文字入力はそのまま使えます。/);
  assert.equal(textareas(tree)[0].props.value, '入力中の内容');
  assert.equal(
    nodes(tree).find((n) => n.props['aria-label'] === '音声入力の確認'),
    undefined,
  );
  hooks.reset();
});

test('マイク許可の拒否は専用の案内を出し、文字入力を残す', async () => {
  hooks.reset();
  resetLog();
  (globalThis as any).recorderModeBridge = 'denied';
  const render = () => {
    hooks.begin();
    return SupportRecordForm({
      requestId: 'q',
      open: true,
      onClose() {},
      api,
      transcribe: async () => ({ transcript: 'x' }),
    });
  };
  let tree = render();
  await hooks.flush();
  tree = render();
  textareas(tree)[2].props.onChange({ target: { value: '提案の下書き' } });
  tree = render();
  speechButtons(tree)[2].props.onClick();
  await settle();
  tree = render();
  const alert = nodes(tree).find((n) => n.props.role === 'alert');
  assert.ok(alert, '拒否は alert で伝える');
  assert.match(text(alert), /マイクの使用が許可されていません。文字入力はそのまま使えます。/);
  assert.equal(textareas(tree)[2].props.value, '提案の下書き');
  assert.equal(recorderLog.started, 1);
  assert.equal(
    nodes(tree).find((n) => n.props['aria-label'] === '音声入力の確認'),
    undefined,
  );
  hooks.reset();
});

test('録音非対応・音声の変換失敗・短すぎる録音は、それぞれ案内を出して文字入力を残す', async () => {
  const cases: { mode: string; expected: RegExp }[] = [
    { mode: 'unsupported', expected: /このブラウザでは音声入力を使えません。/ },
    { mode: 'decode-failed', expected: /音声を送れませんでした。/ },
    { mode: 'too-short', expected: /録音が短すぎます。もう少し長く話してください。/ },
  ];
  for (const { mode, expected } of cases) {
    hooks.reset();
    resetLog();
    (globalThis as any).recorderModeBridge = mode;
    let transcribed = 0;
    const render = () => {
      hooks.begin();
      return SupportRecordForm({
        requestId: 'q',
        open: true,
        onClose() {},
        api,
        transcribe: async () => {
          transcribed++;
          return { transcript: 'x' };
        },
      });
    };
    let tree = render();
    await hooks.flush();
    tree = render();
    speechButtons(tree)[0].props.onClick();
    await settle();
    tree = render();
    // 非対応は録音開始で失敗する。変換失敗・短すぎるは停止後に失敗する。
    if (mode !== 'unsupported') {
      nodes(tree)
        .find((n) => n.type === 'button' && text(n) === '録音を停止')
        .props.onClick();
      await settle();
      tree = render();
    }
    const alert = nodes(tree).find((n) => n.props.role === 'alert');
    assert.ok(alert, `${mode} は alert で伝える`);
    assert.match(text(alert), /音声を文字にできませんでした。文字入力はそのまま使えます。/);
    assert.match(text(alert), expected);
    assert.equal(textareas(tree)[0].props.value, '保存済み');
    // 失敗した音声は文字起こし API へ送らない。
    assert.equal(transcribed, 0);
    assert.equal(
      nodes(tree).find((n) => n.props['aria-label'] === '音声入力の確認'),
      undefined,
    );
  }
  hooks.reset();
});

test('録音中・文字起こし中は保存ボタンを押せない', async () => {
  hooks.reset();
  resetLog();
  let release: (value: { transcript: string }) => void = () => {};
  const render = () => {
    hooks.begin();
    return SupportRecordForm({
      requestId: 'q',
      open: true,
      onClose() {},
      api,
      transcribe: () => new Promise((resolve) => (release = resolve)),
    });
  };
  let tree = render();
  await hooks.flush();
  tree = render();
  const saveButton = () => nodes(tree).find((n) => n.type === 'button' && text(n) === '記録を保存');
  assert.equal(saveButton().props.disabled, false);
  speechButtons(tree)[0].props.onClick();
  await settle();
  tree = render();
  assert.equal(saveButton().props.disabled, true, '録音中は保存できない');
  nodes(tree)
    .find((n) => n.type === 'button' && text(n) === '録音を停止')
    .props.onClick();
  await settle();
  tree = render();
  assert.equal(saveButton().props.disabled, true, '文字起こし中は保存できない');
  // 送信中であることをテキストでも示す（色だけに頼らない）。
  assert.match(text(tree), /文字起こししています。/);
  release({ transcript: '結果' });
  await settle();
  tree = render();
  assert.equal(saveButton().props.disabled, false);
  hooks.reset();
});

test('文字起こし API が 422・502 を返しても入力済みの文字を変えない', async () => {
  for (const status of [422, 502]) {
    hooks.reset();
    resetLog();
    const render = () => {
      hooks.begin();
      return SupportRecordForm({
        requestId: 'q',
        open: true,
        onClose() {},
        api,
        transcribe: async () => {
          throw Object.assign(Error(`${status}：失敗`), {
            status,
            code: status === 422 ? 'AUDIO_TOO_SHORT' : 'SPEECH_REQUEST_FAILED',
          });
        },
      });
    };
    let tree = render();
    await hooks.flush();
    tree = render();
    textareas(tree)[1].props.onChange({ target: { value: '入力済みの対応内容' } });
    tree = render();
    speechButtons(tree)[1].props.onClick();
    await settle();
    tree = render();
    nodes(tree)
      .find((n) => n.type === 'button' && text(n) === '録音を停止')
      .props.onClick();
    await settle();
    tree = render();
    const alert = nodes(tree).find((n) => n.props.role === 'alert');
    assert.ok(alert, `${status} は alert で伝える`);
    assert.match(text(alert), /音声を文字にできませんでした。文字入力はそのまま使えます。/);
    assert.equal(textareas(tree)[1].props.value, '入力済みの対応内容');
    assert.equal(textareas(tree)[0].props.value, '保存済み');
    assert.equal(
      nodes(tree).find((n) => n.props['aria-label'] === '音声入力の確認'),
      undefined,
    );
  }
  hooks.reset();
});

test('録音中に「後で記録する」で閉じると録音を止めてマイクを解放する', async () => {
  hooks.reset();
  resetLog();
  let open = true;
  const render = () => {
    hooks.begin();
    return SupportRecordForm({
      requestId: 'q',
      open,
      onClose: () => {
        open = false;
      },
      api,
      transcribe: async () => ({ transcript: 'x' }),
    });
  };
  let tree = render();
  await hooks.flush();
  tree = render();
  speechButtons(tree)[0].props.onClick();
  await settle();
  tree = render();
  assert.equal(recorderLog.started, 1);
  buttonByText(tree, '後で記録する').props.onClick();
  assert.equal(recorderLog.cancelled, 1, 'マイクを解放する');
  assert.equal(open, false);
  tree = render();
  assert.equal(
    nodes(tree).find((n) => n.props['aria-label'] === '音声入力の確認'),
    undefined,
  );
  hooks.reset();
});

test('open が false になると録音を止め、確認ブロックも破棄する', async () => {
  hooks.reset();
  resetLog();
  let open = true;
  const render = () => {
    hooks.begin();
    return SupportRecordForm({
      requestId: 'q',
      open,
      onClose() {},
      api,
      transcribe: async () => ({ transcript: '確認待ちの文' }),
    });
  };
  let tree = render();
  await hooks.flush();
  tree = render();
  speechButtons(tree)[0].props.onClick();
  await settle();
  tree = render();
  nodes(tree)
    .find((n) => n.type === 'button' && text(n) === '録音を停止')
    .props.onClick();
  await settle();
  tree = render();
  assert.ok(nodes(tree).find((n) => n.props['aria-label'] === '音声入力の確認'));
  open = false;
  tree = render();
  await hooks.flush();
  tree = render();
  assert.equal(
    nodes(tree).find((n) => n.props['aria-label'] === '音声入力の確認'),
    undefined,
  );
  assert.doesNotMatch(text(tree), /確認待ちの文/);
  // 開き直しても欄は変わっていない。
  open = true;
  tree = render();
  await hooks.flush();
  tree = render();
  assert.equal(textareas(tree)[0].props.value, '保存済み');
  hooks.reset();
});

test('別の欄で音声入力を始めると、前の確認ブロックは破棄する', async () => {
  hooks.reset();
  resetLog();
  const render = () => {
    hooks.begin();
    return SupportRecordForm({
      requestId: 'q',
      open: true,
      onClose() {},
      api,
      transcribe: async () => ({ transcript: '一つ目の欄の結果' }),
    });
  };
  let tree = render();
  await hooks.flush();
  tree = render();
  speechButtons(tree)[0].props.onClick();
  await settle();
  tree = render();
  nodes(tree)
    .find((n) => n.type === 'button' && text(n) === '録音を停止')
    .props.onClick();
  await settle();
  tree = render();
  assert.ok(nodes(tree).find((n) => n.props['aria-label'] === '音声入力の確認'));
  // 別の欄で録音を始めると、前の確認ブロックは消える。
  speechButtons(tree)[1].props.onClick();
  await settle();
  tree = render();
  assert.equal(
    nodes(tree).find((n) => n.props['aria-label'] === '音声入力の確認'),
    undefined,
  );
  assert.doesNotMatch(text(tree), /一つ目の欄の結果/);
  assert.equal(textareas(tree)[0].props.value, '保存済み');
  hooks.reset();
});

test('transcribe 未指定では音声入力を提供せず、既存の保存と後回しは動く', async () => {
  hooks.reset();
  resetLog();
  let open = true,
    saved = 0;
  const calls: { path: string; method: string; body: any }[] = [];
  const apiSpy = async (path: string, method = 'GET', body?: any) => {
    calls.push({ path, method, body });
    if (method === 'PUT') {
      saved++;
      // 応答は記録そのものなので、要求専用の expectedRevision は含めない。
      const { expectedRevision: _ignored, ...fields } = body;
      return { ...record, ...fields, revision: 4 };
    }
    return record;
  };
  const render = () => {
    hooks.begin();
    return SupportRecordForm({
      requestId: 'q',
      open,
      onClose: () => {
        open = false;
      },
      api: apiSpy,
    });
  };
  let tree = render();
  await hooks.flush();
  tree = render();
  assert.match(text(tree), /音声入力は使えません/);
  // 音声入力のボタンは押せない。
  for (const button of speechButtons(tree)) assert.equal(button.props.disabled, true);
  // 既存の保存はそのまま動く。
  textareas(tree)[0].props.onChange({ target: { value: '文字だけで記録' } });
  tree = render();
  nodes(tree)
    .find((n) => n.type === 'form')
    .props.onSubmit({ preventDefault() {} });
  await settle();
  assert.equal(saved, 1);
  const put = calls.find((c) => c.method === 'PUT');
  assert.equal(put?.path, '/support-requests/q/record');
  assert.equal(put?.body.observedDifficulty, '文字だけで記録');
  // 文字起こし API へは一切送らない。
  assert.equal(
    calls.some((c) => c.path.includes('transcriptions')),
    false,
  );
  assert.equal(recorderLog.started, 0);
  assert.equal(open, false);
  hooks.reset();
});

// speech-recorder.ts の純粋な処理は、UI テストではスタブに差し替えているため、
// 実物を直接読み込んで検査する（MediaRecorder を使わない範囲だけ）。
const recorderSource = await readFile(
  new URL('../apps/web/src/speech-recorder.ts', import.meta.url),
  'utf8',
);
const recorderCompiled = ts.transpileModule(recorderSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const real = await import(
  'data:text/javascript;base64,' + Buffer.from(recorderCompiled).toString('base64')
);

test('wavFromSamples は 16kHz・16bit・モノラルの WAV ヘッダを書く', async () => {
  const samples = new Float32Array(16_000); // 1秒
  for (let i = 0; i < samples.length; i++) samples[i] = i % 2 ? 0.5 : -0.5;
  const blob: Blob = real.wavFromSamples(samples);
  assert.equal(blob.type, 'audio/wav');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...bytes.slice(offset, offset + length));
  assert.equal(ascii(0, 4), 'RIFF');
  assert.equal(ascii(8, 4), 'WAVE');
  assert.equal(ascii(12, 4), 'fmt ');
  assert.equal(ascii(36, 4), 'data');
  assert.equal(view.getUint16(20, true), 1, 'PCM');
  assert.equal(view.getUint16(22, true), 1, 'モノラル');
  assert.equal(view.getUint32(24, true), 16_000, '16kHz');
  assert.equal(view.getUint16(34, true), 16, '16bit');
  assert.equal(view.getUint32(40, true), samples.length * 2, 'data サイズ');
  assert.equal(bytes.length, 44 + samples.length * 2);
  // 振幅は 16bit に収まる符号付き整数として書く。
  assert.equal(view.getInt16(44, true), -16_384);
  assert.equal(view.getInt16(46, true), 16_383);
});

test('toMono16k はチャンネル平均でモノラル化し 16kHz へ線形リサンプルする', async () => {
  const audio = {
    duration: 1,
    numberOfChannels: 2,
    length: 48_000,
    sampleRate: 48_000,
    getChannelData: (channel: number) => {
      const data = new Float32Array(48_000);
      data.fill(channel === 0 ? 1 : -1);
      return data;
    },
  };
  const mono: Float32Array = real.toMono16k(audio);
  // 48kHz→16kHz で 1/3 の長さになる。
  assert.equal(mono.length, 16_000);
  // (1 + -1) / 2 = 0 なので、モノラル化で打ち消し合う。
  for (const value of mono) assert.ok(Math.abs(value) < 1e-6);

  const single = {
    duration: 1,
    numberOfChannels: 1,
    length: 16_000,
    sampleRate: 16_000,
    getChannelData: () => new Float32Array(16_000).fill(0.25),
  };
  const same: Float32Array = real.toMono16k(single);
  assert.equal(same.length, 16_000);
  assert.ok(Math.abs(same[0] - 0.25) < 1e-6);
});

test('encodeWav は非対応環境・デコード失敗を例外で落とさず code で伝える', async () => {
  // Node には AudioContext が無いので DECODE_FAILED になる。
  await assert.rejects(
    () => real.encodeWav(new Blob(['x'], { type: 'audio/webm' })),
    (e: any) => e.code === 'DECODE_FAILED',
  );
});

test('startRecording は MediaRecorder の無い環境で RECORDING_UNSUPPORTED を投げる', async () => {
  const originalRecorder = (globalThis as any).MediaRecorder;
  const originalMediaDevices = (globalThis as any).navigator?.mediaDevices;
  try {
    (globalThis as any).MediaRecorder = undefined;
    await assert.rejects(
      () => real.startRecording(),
      (e: any) => e.code === 'RECORDING_UNSUPPORTED',
    );
  } finally {
    (globalThis as any).MediaRecorder = originalRecorder;
    if (originalMediaDevices !== undefined)
      (globalThis as any).navigator.mediaDevices = originalMediaDevices;
  }
});
