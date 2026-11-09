import React, { useEffect, useRef, useState } from 'react';
import { correctionsListResponseSchema } from '../../../packages/shared/src/generation.ts';
import type { z } from 'zod';

type Correction = z.infer<typeof correctionsListResponseSchema>['corrections'][number];
const labels: Record<string, string> = { text: '本人に見せる文', imageAltText: '写真の代替テキスト', visibleCaution: '本人に見せる注意', imageAssetId: '写真', sourceStartMs: '開始時刻', sourceEndMs: '終了時刻', frameMs: '写真時刻', verifiedObservation: '確認した動作', verifiedSpeech: '確認した声', coaching: '職員用声かけ', completionCheck: '完成基準', position: '工程順' };
export function StaffCorrectionHistory({ learnerId, taskId, api, close }: { learnerId: string; taskId: string; api: (path: string) => Promise<unknown>; close: () => void }) {
    const [items, setItems] = useState<Correction[]>(), [error, setError] = useState('');
    const active = useRef(true), sequence = useRef(0);
    const load = async () => {
        const current = ++sequence.current;
        try {
            const result = correctionsListResponseSchema.parse(await api(`/learners/${encodeURIComponent(learnerId)}/work-guides/${encodeURIComponent(taskId)}/corrections`));
            if (active.current && current === sequence.current) { setItems(result.corrections); setError(''); }
        } catch { if (active.current && current === sequence.current) setError('履歴を読み込めませんでした。再読み込みしてください。'); }
    };
    useEffect(() => { active.current = true; void load(); return () => { active.current = false; }; }, [learnerId, taskId]);
    return <section aria-label="手直し履歴"><h4>職員の手直し履歴</h4>
        <p>本人向けの文・代替テキスト・注意の修正は、次回のAI下書きの参考にします。送信対象の欄には本人を特定する情報を入れないでください。</p>
        <button type="button" onClick={() => void load()}>履歴を読み直す</button><button type="button" onClick={close}>閉じる</button>
        {error && <p role="alert">{error}</p>}
        {!items ? <p role="status">履歴を読み込み中です</p> : !items.length ? <p>手直し履歴はまだありません。</p> : items.slice().reverse().map(c => <article key={c.correctionId}>
            <h5>職員が保存した手直し（下書き版 {c.draftRevision}）</h5><p>{new Date(c.createdAt).toLocaleString('ja-JP')}</p>
            {c.changes.map((change, index) => <div key={`${change.stepId}:${change.field}:${index}`}><strong>工程 {change.stepId}：{labels[change.field] ?? change.field}</strong><p>変更前：{change.before === null ? 'なし' : String(change.before)}</p><p>変更後：{change.after === null ? 'なし' : String(change.after)}</p></div>)}
            {c.reason && <p>職員が記録した理由：{c.reason}</p>}
            <h5>AIの参考メモ（未承認）</h5>
            {c.contextSummary ? <><p>修正の要約：{c.contextSummary.editSummary}</p><p>次回への参考：{c.contextSummary.nextDraftHint}</p>{c.contextSummary.reviewFlags.map((flag, index) => <p key={index}>確認が必要：{flag}</p>)}</> : <p>{c.contextJobStatus === 'failed' ? '参考メモを作れませんでした。保存済みの手直しは上に表示しています。' : c.contextJobStatus === 'queued' || c.contextJobStatus === 'running' ? '参考メモを作成中です。' : '参考メモはありません。'}</p>}
        </article>)}
    </section>;
}
