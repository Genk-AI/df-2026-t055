import React, { useEffect, useState } from 'react';
import { workGuideListResponseSchema } from '../../../packages/shared/src/work-guides.ts';
import type { z } from 'zod';
import { StaffImprovementRequest } from './staff-improvement-request.tsx';
import { StaffCorrectionHistory } from './staff-correction-history.tsx';

type WorkGuide = z.infer<typeof workGuideListResponseSchema>['items'][number];
type Result = { learnerId: string; items: WorkGuide[]; error?: string };

export function StaffWorkGuides({ learnerId, api, go }: { learnerId: string; api: (path: string, method?: string, body?: unknown) => Promise<any>; go: (path: string) => void }) {
    const [result, setResult] = useState<Result>();
    const [history, setHistory] = useState<{ learnerId: string; taskId: string }>();
    const [improvement, setImprovement] = useState<{ learnerId: string; taskId: string; releaseId: string }>();
    useEffect(() => {
        let active = true, sequence = 0, running = false;
        const load = async () => {
            if (running) return;
            running = true;
            const current = ++sequence;
            try {
                const response = workGuideListResponseSchema.parse(await api(`/learners/${encodeURIComponent(learnerId)}/work-guides`));
                if (active && current === sequence) setResult({ learnerId, items: response.items });
            } catch (error) {
                if (active && current === sequence) setResult(previous => ({ learnerId, items: previous?.learnerId === learnerId ? previous.items : [], error: (error as Error).message }));
            } finally { running = false; }
        };
        void load();
        const timer = setInterval(() => void load(), 3000);
        return () => { active = false; clearInterval(timer); };
    }, [learnerId, api]);
    const visible = result?.learnerId === learnerId ? result : undefined;
    return <section aria-label="本人の作業"><h2>この本人の作業</h2>
        {!visible ? <p role="status">作業を読み込み中です</p> : <>
            {visible.error && <p role="alert">作業の更新に失敗しました：{visible.error}</p>}
            {!visible.items.length && !visible.error && <p>作業はまだありません。</p>}
            {visible.items.map(item => <article key={item.taskId}><h3>{item.title}</h3>
                <p>次回の版：{item.assignment ? `版 ${item.assignment.version}` : '未割当'}</p>
                <p>未反映の支援記録：{item.unappliedCount}件</p>
                <p>生成：{!item.latestGeneration ? '記録なし' : item.latestGeneration.status === 'queued' || item.latestGeneration.status === 'running' ? '生成中' : item.latestGeneration.status === 'failed' ? '生成失敗' : '生成完了'}</p>
                <p>下書き：{!item.latestDraft ? 'なし' : item.latestDraft.status === 'generating' ? '生成中' : item.latestDraft.status === 'failed' ? '生成失敗' : item.latestDraft.status === 'editing' ? '職員の確認待ち' : '承認済み'}</p>
                <button onClick={() => setHistory({ learnerId, taskId: item.taskId })}>手直し履歴を見る</button>
                {history?.learnerId === learnerId && history.taskId === item.taskId && <StaffCorrectionHistory key={`${learnerId}:${item.taskId}`} learnerId={learnerId} taskId={item.taskId} api={api} close={() => setHistory(undefined)}/>}
                {item.assignment && <><button onClick={() => go(`/staff/handover/releases/${encodeURIComponent(item.assignment!.releaseId)}`)}>次回版を見る</button>
                    <button onClick={() => setImprovement({ learnerId, taskId: item.taskId, releaseId: item.assignment!.releaseId })}>記録をもとに更新</button></>}
                {improvement?.learnerId === learnerId && improvement.taskId === item.taskId && <StaffImprovementRequest key={`${learnerId}:${item.taskId}`} learnerId={learnerId} taskId={item.taskId} title={item.title} releaseId={improvement.releaseId} currentReleaseId={item.assignment?.releaseId} api={api} close={() => setImprovement(undefined)} changeRelease={() => { if (item.assignment) setImprovement({ learnerId, taskId: item.taskId, releaseId: item.assignment.releaseId }); }} go={go}/>}
            </article>)}
        </>}
    </section>;
}
