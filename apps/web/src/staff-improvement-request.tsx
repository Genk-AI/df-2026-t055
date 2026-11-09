import React, { useEffect, useRef, useState } from 'react';
import { workGuideRecordsResponseSchema } from '../../../packages/shared/src/work-guides.ts';
import { generationCreateResponseSchema } from '../../../packages/shared/src/generation.ts';
import type { z } from 'zod';

type RecordItem = z.infer<typeof workGuideRecordsResponseSchema>['records'][number];
type Choice = { revision: number; summary: string };
type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
export function StaffImprovementRequest({ learnerId, taskId, title, releaseId, currentReleaseId, api, close, changeRelease, go }: {
    learnerId: string; taskId: string; title: string; releaseId: string; currentReleaseId: string | undefined; api: Api; close: () => void; changeRelease: () => void; go: (path: string) => void;
}) {
    const [records, setRecords] = useState<RecordItem[]>(), [choices, setChoices] = useState<Record<string, Choice>>({});
    const [error, setError] = useState(''), [busy, setBusy] = useState(false), [confirmed, setConfirmed] = useState(false), [result, setResult] = useState<{ jobId: string; draftId: string }>();
    const active = useRef(true), sequence = useRef(0), sending = useRef(false), request = useRef<{ fingerprint: string; key: string } | undefined>(undefined);
    const path = `/learners/${encodeURIComponent(learnerId)}/work-guides/${encodeURIComponent(taskId)}/support-records`;
    const load = async () => {
        const current = ++sequence.current;
        try { const data = workGuideRecordsResponseSchema.parse(await api(path)); if (active.current && current === sequence.current) { setRecords(data.records); setError(''); } }
        catch { if (active.current && current === sequence.current) setError('支援記録を読み込めませんでした。入力内容を保ったまま再読み込みできます。'); }
    };
    useEffect(() => { active.current = true; void load(); return () => { active.current = false; }; }, [learnerId, taskId]);
    const selected = Object.entries(choices);
    const stale = selected.some(([id, choice]) => !records?.some(r => r.recordId === id && r.revision === choice.revision));
    const update = (id: string, value: Choice | undefined) => { setConfirmed(false); setChoices(old => { const next = { ...old }; if (value) next[id] = value; else delete next[id]; return next; }); };
    const submit = async () => {
        if (sending.current || !confirmed || !selected.length || stale || currentReleaseId !== releaseId || selected.some(([, c]) => !c.summary.trim())) return;
        const supportInputs = selected.map(([recordId, c]) => ({ recordId, revision: c.revision, summary: c.summary.trim() }));
        const payload = { learnerId, sourceReleaseId: releaseId, supportInputs };
        const fingerprint = JSON.stringify(payload);
        if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, key: crypto.randomUUID() };
        sending.current = true; setBusy(true); setError('');
        try {
            const response = generationCreateResponseSchema.parse(await api(`/tasks/${encodeURIComponent(taskId)}/generations`, 'POST', { ...payload, clientRequestId: request.current.key }));
            if (active.current) setResult(response);
        } catch (e) {
            if (active.current) setError((e as { status?: number }).status === 409 ? '記録または次回版が変わった可能性があります。再読み込みして内容を確認してください。入力は保持しています。' : '依頼できませんでした。入力を保持しています。同じ内容で再試行できます。');
        } finally { sending.current = false; if (active.current) setBusy(false); }
    };
    return <section aria-label={`${title}の改善依頼`}><h4>支援記録をもとに更新</h4>
        <p>現在の次回版をもとに下書きを作ります。依頼しただけでは次回版は変わりません。</p>
        <p>送信する要約に、氏名や本人を特定できる情報を入れないでください。原文は送信しません。</p>
        {error && <p role="alert">{error}</p>}
        {currentReleaseId !== releaseId && <div role="alert"><p>次回版が変わりました。最新の版を確認してください。</p>{currentReleaseId && <button type="button" disabled={busy} onClick={() => { setConfirmed(false); changeRelease(); }}>最新の次回版を使う</button>}</div>}
        {result ? <><p role="status">改善の下書きを受け付けました。次回版はまだ変わっていません。</p><button onClick={() => go(`/staff/tasks/${encodeURIComponent(taskId)}/drafts/${encodeURIComponent(result.draftId)}`)}>下書きを確認する</button></> : <>
            <button type="button" disabled={busy} onClick={() => void load()}>最新の記録を読み直す</button>
            {!records ? <p role="status">支援記録を読み込み中です</p> : !records.length ? <p>支援記録はまだありません。</p> : records.map(record => {
                const choice = choices[record.recordId], changed = choice && choice.revision !== record.revision;
                return <article key={record.recordId}><label><input type="checkbox" checked={!!choice} disabled={busy} onChange={e => update(record.recordId, e.target.checked ? { revision: record.revision, summary: choice?.summary ?? '' } : undefined)}/>記録（版 {record.revision}）を選ぶ</label>
                    <dl><dt>つまずき</dt><dd>{record.observedDifficulty || '未記入'}</dd><dt>支援</dt><dd>{record.assistanceGiven || '未記入'}</dd><dt>改善提案</dt><dd>{record.improvementSuggestion || '未記入'}</dd></dl>
                    {record.applied && <p>この記録版は次回版に採用済みです。</p>}
                    {choice && <><label>送信用の要約<textarea maxLength={2000} disabled={busy} value={choice.summary} onChange={e => update(record.recordId, { ...choice, summary: e.target.value })}/></label>
                        {changed && <><p role="alert">記録が更新されました。最新の内容を確認してください。</p><button disabled={busy} onClick={() => update(record.recordId, { ...choice, revision: record.revision })}>この版を選び直す</button></>}</>}
                </article>;
            })}
            {records && selected.filter(([id]) => !records.some(r => r.recordId === id)).map(([id, choice]) => <div key={id}><p>表示対象から外れた記録の要約：{choice.summary}</p><button type="button" disabled={busy} onClick={() => update(id, undefined)}>この記録の選択を外す</button></div>)}
            {stale && <p role="alert">選択した記録の版が変わったか、表示対象から外れました。選び直してください。</p>}
            <label><input type="checkbox" disabled={busy} checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>選択した要約を確認しました</label>
            <button type="button" disabled={busy || !confirmed || !selected.length || stale || currentReleaseId !== releaseId || selected.some(([, c]) => !c.summary.trim())} onClick={() => void submit()}>改善を依頼する</button>
        </>}
        <button type="button" disabled={busy} onClick={close}>閉じる</button>
    </section>;
}
