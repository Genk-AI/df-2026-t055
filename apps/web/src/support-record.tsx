import React, { useEffect, useRef, useState } from 'react';
import { supportRecordSchema, type SupportRecord } from '../../../packages/shared/src/support.ts';
import { encodeWav, startRecording, type Recording } from './speech-recorder.ts';

type Fields = Pick<
  SupportRecord,
  'observedDifficulty' | 'assistanceGiven' | 'improvementSuggestion'
>;
type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
/** 音声を文字起こし API へ送る。既定の実装は apps/web/src/main.tsx が渡す。 */
export type Transcribe = (path: string, blob: Blob) => Promise<{ transcript: string }>;
const empty: Fields = { observedDifficulty: '', assistanceGiven: '', improvementSuggestion: '' };
const fieldLabels: Record<keyof Fields, string> = {
  observedDifficulty: 'どこでつまずいたか',
  assistanceGiven: '何をしたか',
  improvementSuggestion: '次回の改善提案',
};
const fieldOrder = Object.keys(fieldLabels) as (keyof Fields)[];
type SpeechState =
  | { status: 'idle' }
  | { status: 'starting' | 'recording' | 'transcribing'; field: keyof Fields }
  | { status: 'confirming'; field: keyof Fields; transcript: string }
  | { status: 'failed'; field: keyof Fields; message: string; denied?: boolean };

/** 録音・文字起こしの失敗を、入力済みの文字を残したまま説明する文にする。 */
function failureText(e: unknown): string {
  const code = (e as { code?: string }).code;
  const name = (e as { name?: string }).name;
  if (code === 'AUDIO_TOO_SHORT') return '録音が短すぎます。もう少し長く話してください。';
  if (code === 'AUDIO_TOO_LARGE') return '録音が長すぎます。60秒以内で話してください。';
  if (code === 'DECODE_FAILED')
    return '音声を送れませんでした。このブラウザでは録音を変換できません。';
  if (code === 'RECORDING_UNSUPPORTED') return 'このブラウザでは音声入力を使えません。';
  if (name === 'NotFoundError') return 'マイクが見つかりません。';
  if (name === 'NotReadableError')
    return 'マイクを使用できません。ほかのアプリが使っていないか確認してください。';
  const status = (e as { status?: number }).status;
  if (status === 502) return '文字起こしに失敗しました。時間をおいて試してください。';
  if (status === 422) return '音声を送れませんでした。録音し直してください。';
  if (status === 409 || status === 403) return 'この支援記録には音声入力を送れません。';
  return (e as Error)?.message || '通信を確認してください。';
}
/** マイク許可の拒否は、失敗の共通文ではなく専用の案内で伝える。 */
function isMicrophoneDenied(e: unknown) {
  return (e as { name?: string }).name === 'NotAllowedError';
}

export function SupportRecordForm({
  requestId,
  requestLabel,
  open,
  onClose,
  api,
  transcribe,
}: {
  requestId: string;
  requestLabel?: string;
  open: boolean;
  onClose: () => void;
  api: Api;
  transcribe?: Transcribe;
}) {
  const [fields, setFields] = useState<Fields>(empty),
    [revision, setRevision] = useState(0),
    [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [conflict, setConflict] = useState(false),
    [latest, setLatest] = useState<SupportRecord>(),
    [speech, setSpeech] = useState<SpeechState>({ status: 'idle' });
  const sending = useRef(false),
    alive = useRef(true),
    heading = useRef<HTMLHeadingElement>(null),
    recording = useRef<Recording | undefined>(undefined),
    speechSequence = useRef(0);
  const path = `/support-requests/${encodeURIComponent(requestId)}/record`;
  // 録音を止め、マイクを解放する。進行中の文字起こし結果は無効にする。
  const stopSpeech = () => {
    speechSequence.current++;
    const current = recording.current;
    recording.current = undefined;
    current?.cancel();
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      stopSpeech();
    };
  }, []);
  // フォームを閉じたら録音を止め、確認待ちの内容も破棄する。
  useEffect(() => {
    if (open) return;
    stopSpeech();
    setSpeech({ status: 'idle' });
  }, [open]);
  useEffect(() => {
    if (open) heading.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!open || loaded) return;
    let active = true;
    void (async () => {
      try {
        const record = supportRecordSchema.parse(await api(path));
        if (active) {
          setFields({
            observedDifficulty: record.observedDifficulty,
            assistanceGiven: record.assistanceGiven,
            improvementSuggestion: record.improvementSuggestion,
          });
          setRevision(record.revision);
          setLoaded(true);
          setError('');
        }
      } catch (e) {
        if (active && (e as { status?: number }).status === 404) {
          setLoaded(true);
          setError('');
        } else if (active) setError((e as Error).message);
      }
    })();
    return () => {
      active = false;
    };
  }, [open, loaded, path, api]);
  const save = async () => {
    if (!loaded || conflict || sending.current) return;
    sending.current = true;
    setBusy(true);
    setError('');
    try {
      const result = supportRecordSchema.parse(
        await api(path, 'PUT', { expectedRevision: revision, ...fields }),
      );
      if (alive.current) {
        setRevision(result.revision);
        setError('');
        onClose();
      }
    } catch (e) {
      if (alive.current) {
        setError((e as Error).message);
        if ((e as { status?: number }).status === 409) setConflict(true);
      }
    } finally {
      sending.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const fetchLatest = async () => {
    setBusy(true);
    setError('');
    try {
      const record = supportRecordSchema.parse(await api(path));
      if (alive.current) setLatest(record);
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const field = (key: keyof Fields) => ({
    value: fields[key],
    maxLength: 2000,
    disabled: busy,
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) =>
      setFields((old) => ({ ...old, [key]: e.target.value })),
  });
  const speechBusy = speech.status === 'starting' || speech.status === 'transcribing';
  const recordingField = speech.status === 'recording' ? speech.field : undefined;
  // 録音を始める。同時に録音・確認できるのは1欄だけにする。
  const beginSpeech = async (key: keyof Fields) => {
    if (!transcribe) {
      setSpeech({ status: 'failed', field: key, message: 'この画面では音声入力を使えません。' });
      return;
    }
    if (speechBusy) return;
    stopSpeech();
    const sequence = ++speechSequence.current;
    setSpeech({ status: 'starting', field: key });
    try {
      const active = await startRecording();
      if (sequence !== speechSequence.current || !alive.current) {
        active.cancel();
        return;
      }
      recording.current = active;
      setSpeech({ status: 'recording', field: key });
    } catch (e) {
      if (alive.current && sequence === speechSequence.current)
        setSpeech({
          status: 'failed',
          field: key,
          message: failureText(e),
          denied: isMicrophoneDenied(e),
        });
    }
  };
  const finishSpeech = async (key: keyof Fields) => {
    const active = recording.current;
    if (!active || !transcribe) return;
    recording.current = undefined;
    const sequence = ++speechSequence.current;
    setSpeech({ status: 'transcribing', field: key });
    try {
      const raw = await active.stop();
      const wav = await encodeWav(raw);
      const result = await transcribe(`${path}/transcriptions`, wav);
      if (!alive.current || sequence !== speechSequence.current) return;
      const transcript = typeof result?.transcript === 'string' ? result.transcript : '';
      if (!transcript) {
        setSpeech({ status: 'failed', field: key, message: '話した内容を聞き取れませんでした。' });
        return;
      }
      // 認識結果はすぐには欄へ入れず、職員の確認を待つ。
      setSpeech({ status: 'confirming', field: key, transcript });
    } catch (e) {
      if (alive.current && sequence === speechSequence.current)
        setSpeech({ status: 'failed', field: key, message: failureText(e) });
    }
  };
  // 既存の文字を上書きせず、末尾に改行を挟んで追記する。
  const applyTranscript = (key: keyof Fields, transcript: string) => {
    setFields((old) => {
      const existing = old[key];
      const next = !existing
        ? transcript
        : existing.endsWith('\n')
          ? existing + transcript
          : `${existing}\n${transcript}`;
      return { ...old, [key]: next.slice(0, 2000) };
    });
    setSpeech({ status: 'idle' });
  };
  const speechStatus = (key: keyof Fields) => {
    if (speech.status === 'idle' || speech.field !== key) return '';
    if (speech.status === 'starting') return 'マイクを準備しています。';
    if (speech.status === 'recording') return '録音しています。話し終えたら停止してください。';
    if (speech.status === 'transcribing') return '文字起こししています。';
    if (speech.status === 'confirming')
      return '音声の認識結果を確認してください。まだ欄には入っていません。';
    return '';
  };
  const speechButton = (key: keyof Fields) => {
    const label = fieldLabels[key];
    const isRecording = recordingField === key;
    const isTranscribing = speech.status === 'transcribing' && speech.field === key;
    const isStarting = speech.status === 'starting' && speech.field === key;
    const text = isRecording ? '録音を停止' : isTranscribing ? '文字にしています' : '音声で入力';
    const unavailable = !transcribe;
    return (
      <>
        <button
          type='button'
          aria-label={isRecording ? `「${label}」の録音を停止` : `「${label}」を音声で入力`}
          disabled={
            busy ||
            isStarting ||
            isTranscribing ||
            unavailable ||
            (!!recordingField && !isRecording)
          }
          onClick={() => void (isRecording ? finishSpeech(key) : beginSpeech(key))}
        >
          {text}
        </button>
        {unavailable && <p>音声入力は使えません。文字で入力してください。</p>}
        {speechStatus(key) && <p role='status'>{speechStatus(key)}</p>}
        {speech.status === 'confirming' && speech.field === key && (
          <div role='group' aria-label='音声入力の確認'>
            <p>音声入力の確認</p>
            <textarea readOnly value={speech.transcript} aria-label={`「${label}」の認識結果`} />
            <button
              type='button'
              disabled={busy}
              onClick={() => applyTranscript(key, speech.transcript)}
            >
              この内容を欄に入れる
            </button>
            <button type='button' disabled={busy} onClick={() => setSpeech({ status: 'idle' })}>
              取り消す
            </button>
          </div>
        )}
        {speech.status === 'failed' && speech.field === key && (
          <p role='alert'>
            {speech.denied
              ? 'マイクの使用が許可されていません。文字入力はそのまま使えます。'
              : `音声を文字にできませんでした。文字入力はそのまま使えます。${speech.message}`}
          </p>
        )}
      </>
    );
  };
  return (
    <section hidden={!open} aria-label={`支援記録 ${requestLabel || requestId}`}>
      <h3 ref={heading} tabIndex={-1}>
        支援記録
      </h3>
      <p>
        {requestLabel ? `対象：${requestLabel}` : `要求：${requestId}`}。
        入力を後回しにしても、支援や再開は続けられます。
      </p>
      {error && <p role='alert'>記録を取得または保存できませんでした：{error}</p>}
      {!loaded ? (
        <>
          <p role='status'>記録を読み込んでいます。</p>
          {error && (
            <button
              onClick={() => {
                setError('');
                setLoaded(false);
                onClose();
              }}
            >
              閉じて後で開く
            </button>
          )}
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {fieldOrder.map((key) => (
            <div key={key}>
              <label>
                {fieldLabels[key]}
                <textarea {...field(key)} />
              </label>
              {speechButton(key)}
            </div>
          ))}
          <button type='submit' disabled={busy || conflict || !!recordingField || speechBusy}>
            記録を保存
          </button>
        </form>
      )}
      {conflict && (
        <aside>
          <p>別の更新があります。入力は保持しています。最新内容を比較してから保存してください。</p>
          <button disabled={busy} onClick={() => void fetchLatest()}>
            最新の記録を確認
          </button>
          {latest && (
            <>
              <dl>
                <dt>つまずき</dt>
                <dd>{latest.observedDifficulty || 'なし'}</dd>
                <dt>したこと</dt>
                <dd>{latest.assistanceGiven || 'なし'}</dd>
                <dt>改善提案</dt>
                <dd>{latest.improvementSuggestion || 'なし'}</dd>
              </dl>
              <button
                disabled={busy}
                onClick={() => {
                  setRevision(latest.revision);
                  setLatest(undefined);
                  setConflict(false);
                }}
              >
                最新の版を基準に入力内容を再確認
              </button>
            </>
          )}
        </aside>
      )}
      <button
        disabled={busy}
        onClick={() => {
          stopSpeech();
          setSpeech({ status: 'idle' });
          onClose();
        }}
      >
        後で記録する
      </button>
    </section>
  );
}
