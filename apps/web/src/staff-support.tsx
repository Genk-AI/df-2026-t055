import React, { useEffect, useRef, useState } from 'react';
import { staffIdentitySchema, staffSupportSessionSchema, supportRequestListResponseSchema, staffSupportNotificationSchema, type SupportRequest } from '../../../packages/shared/src/support.ts';
import { SupportRecordForm } from './support-record.tsx';

type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
export function StaffSupport({ api, go, subscribe }: { api: Api; go: (path: string) => void; subscribe: (receive: (value: unknown) => void, status: (connected: boolean) => void) => () => void }) {
    const [uid, setUid] = useState(''), [items, setItems] = useState<SupportRequest[]>([]), [waiting, setWaiting] = useState<string[]>([]), [error, setError] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState<Record<string, boolean>>({}), [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
    const sequence = useRef(0), loadingList = useRef(false), refreshPending = useRef(false), inFlight = useRef(new Set<string>()), retry = useRef<Record<string, { clientRequestId: string; expectedSessionRevision: number }>>({});
    const alive = useRef(true);
    const connected = useRef(false), fallback = useRef(true);
    const [realtime, setRealtime] = useState(false);
    const recordButtons = useRef<Record<string, HTMLButtonElement | null>>({}), heading = useRef<HTMLHeadingElement>(null);
    const [recordIds, setRecordIds] = useState<string[]>([]), [recordOpen, setRecordOpen] = useState<Record<string, boolean>>({});
    const openRecord = (requestId: string) => { setRecordIds(old => old.includes(requestId) ? old : [...old, requestId]); setRecordOpen(old => ({ ...old, [requestId]: true })); };
    const load = async (staffUid: string) => {
        if (loadingList.current) { refreshPending.current = true; return; }
        loadingList.current = true;
        const current = ++sequence.current;
        try {
            const [open, done] = await Promise.all([api('/support-requests'), api('/support-requests?status=acknowledged')]);
            const active = supportRequestListResponseSchema.parse(open).requests;
            const completed = supportRequestListResponseSchema.parse(done).requests.filter(q => q.kind === 'help' && q.status === 'acknowledged' && q.assignedTo === staffUid);
            const eligible = [...active, ...completed].filter(q => q.kind === 'help' && (q.status === 'in_progress' || q.status === 'acknowledged') && q.assignedTo === staffUid);
            const states = await Promise.all(eligible.map(async q => {
                try { const s = staffSupportSessionSchema.parse(await api(`/support-requests/${encodeURIComponent(q.requestId)}/session-state`)); return s.status === 'waiting_help' && s.currentRequest ? q.requestId : ''; }
                catch { return ''; }
            }));
            if (alive.current && current === sequence.current) { fallback.current = !connected.current; setItems([...active, ...completed]); setWaiting(states.filter(Boolean)); setError(''); setLoading(false); }
        } catch (e) { if (alive.current && current === sequence.current) { fallback.current = true; setError((e as Error).message); setLoading(false); } }
        finally {
            loadingList.current = false;
            if (refreshPending.current && alive.current) { refreshPending.current = false; void load(staffUid); }
        }
    };
    useEffect(() => {
        alive.current = true;
        let currentUid = '';
        void (async () => { try { currentUid = staffIdentitySchema.parse(await api('/staff/me')).uid; if (alive.current) { setUid(currentUid); await load(currentUid); } } catch (e) { if (alive.current) { setError((e as Error).message); setLoading(false); } } })();
        const timer = setInterval(() => { if (currentUid && (!connected.current || fallback.current)) void load(currentUid); }, 3000);
        const unsubscribe = subscribe(value => { staffSupportNotificationSchema.parse(value); if (currentUid) void load(currentUid); }, status => { if (alive.current) { connected.current = status; setRealtime(status); if (!status) fallback.current = true; } });
        return () => { alive.current = false; sequence.current++; clearInterval(timer); unsubscribe(); };
    }, [api, subscribe]);
    const act = async (q: SupportRequest, operation: 'claim' | 'start' | 'acknowledge' | 'resume') => {
        if (inFlight.current.has(q.requestId)) return;
        if (operation === 'resume' && !confirmed[q.requestId]) return;
        inFlight.current.add(q.requestId); setBusy(old => ({ ...old, [q.requestId]: true })); setError('');
        try {
            let body: object = {};
            if (operation === 'resume') {
                let saved = retry.current[q.requestId];
                if (!saved) {
                    const state = staffSupportSessionSchema.parse(await api(`/support-requests/${encodeURIComponent(q.requestId)}/session-state`));
                    if (state.status !== 'waiting_help' || !state.currentRequest) throw Error('再開待ちの状態ではありません。');
                    saved = retry.current[q.requestId] = { clientRequestId: crypto.randomUUID(), expectedSessionRevision: state.revision };
                }
                body = saved;
            }
            await api(`/support-requests/${encodeURIComponent(q.requestId)}/${operation}`, 'POST', body);
            delete retry.current[q.requestId];
            if (alive.current) { if (operation === 'start') openRecord(q.requestId); setConfirmed(old => ({ ...old, [q.requestId]: false })); await load(uid); }
        } catch (e) {
            if ((e as { status?: number }).status === 409) { delete retry.current[q.requestId]; await load(uid); }
            if (alive.current) setError((e as Error).message);
        } finally { inFlight.current.delete(q.requestId); if (alive.current) setBusy(old => ({ ...old, [q.requestId]: false })); }
    };
    return <><button onClick={() => go('/staff')}>作業一覧</button><h1 ref={heading} tabIndex={-1}>支援要求</h1><p role="status">{realtime ? '通知を受信中' : '通知が切断中です。3秒ごとに確認します。'}</p>
        {error && <p role="alert">更新または操作に失敗しました：{error}</p>}{loading && <p role="status">読み込み中です</p>}
        {!loading && !error && !items.length && <p>未対応の要求はありません。</p>}
        {items.map(q => <section key={q.requestId}><h2>{q.kind === 'stop' ? 'やめる' : '手伝って'}：{q.status === 'open' ? '対応待ち' : q.status === 'assigned' ? '担当決定済み' : q.status === 'in_progress' ? '対応中' : '対応完了'}</h2>
            <p>本人：{q.learnerId}／工程：{q.stepId}</p>{q.kind === 'help' && q.status !== 'open' && <p>担当：{q.assignedTo}</p>}
            {q.kind === 'stop' && q.status === 'open' && <button disabled={!!busy[q.requestId]} onClick={() => void act(q, 'acknowledge')}>停止を確認した</button>}
            {q.kind === 'help' && q.status === 'open' && <button disabled={!!busy[q.requestId]} onClick={() => void act(q, 'claim')}>担当する</button>}
            {q.kind === 'help' && q.status === 'assigned' && q.assignedTo === uid && <button disabled={!!busy[q.requestId]} onClick={() => void act(q, 'start')}>対応を始める</button>}
            {q.kind === 'help' && q.status === 'in_progress' && q.assignedTo === uid && <button disabled={!!busy[q.requestId]} onClick={() => void act(q, 'acknowledge')}>対応完了だけを記録</button>}
            {q.kind === 'help' && (q.status === 'in_progress' || q.status === 'acknowledged') && q.assignedTo === uid && <button ref={node => { recordButtons.current[q.requestId] = node; }} onClick={() => openRecord(q.requestId)}>支援記録を開く</button>}
            {q.kind === 'help' && q.status !== 'open' && q.assignedTo === uid && (q.status === 'in_progress' || q.status === 'acknowledged') && waiting.includes(q.requestId) && <div>
                <label><input type="checkbox" checked={!!confirmed[q.requestId]} onChange={e => setConfirmed(old => ({ ...old, [q.requestId]: e.target.checked }))}/>本人に再開の希望を確認しました</label>
                <button disabled={!!busy[q.requestId] || !confirmed[q.requestId]} onClick={() => void act(q, 'resume')}>対応を終えてつづける</button>
            </div>}
        </section>)}
        {recordIds.map(requestId => <SupportRecordForm key={requestId} requestId={requestId} open={!!recordOpen[requestId]} api={api} onClose={() => { setRecordOpen(old => ({ ...old, [requestId]: false })); (recordButtons.current[requestId] ?? heading.current)?.focus(); }}/>)}
    </>;
}
