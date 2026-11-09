import React, { useEffect, useRef, useState } from 'react';
import { supportRecordSchema, type SupportRecord } from '../../../packages/shared/src/support.ts';

type Fields = Pick<SupportRecord, 'observedDifficulty' | 'assistanceGiven' | 'improvementSuggestion'>;
type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
const empty: Fields = { observedDifficulty: '', assistanceGiven: '', improvementSuggestion: '' };

export function SupportRecordForm({ requestId, open, onClose, api }: { requestId: string; open: boolean; onClose: () => void; api: Api }) {
    const [fields, setFields] = useState<Fields>(empty), [revision, setRevision] = useState(0), [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [conflict, setConflict] = useState(false), [latest, setLatest] = useState<SupportRecord>();
    const sending = useRef(false), alive = useRef(true), heading = useRef<HTMLHeadingElement>(null);
    const path = `/support-requests/${encodeURIComponent(requestId)}/record`;
    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    useEffect(() => { if (open) heading.current?.focus(); }, [open]);
    useEffect(() => {
        if (!open || loaded) return;
        let active = true;
        void (async () => {
            try {
                const record = supportRecordSchema.parse(await api(path));
                if (active) { setFields({ observedDifficulty: record.observedDifficulty, assistanceGiven: record.assistanceGiven, improvementSuggestion: record.improvementSuggestion }); setRevision(record.revision); setLoaded(true); setError(''); }
            } catch (e) {
                if (active && (e as { status?: number }).status === 404) { setLoaded(true); setError(''); }
                else if (active) setError((e as Error).message);
            }
        })();
        return () => { active = false; };
    }, [open, loaded, path, api]);
    const save = async () => {
        if (!loaded || conflict || sending.current) return;
        sending.current = true; setBusy(true); setError('');
        try {
            const result = supportRecordSchema.parse(await api(path, 'PUT', { expectedRevision: revision, ...fields }));
            if (alive.current) { setRevision(result.revision); setError(''); onClose(); }
        } catch (e) {
            if (alive.current) { setError((e as Error).message); if ((e as { status?: number }).status === 409) setConflict(true); }
        } finally { sending.current = false; if (alive.current) setBusy(false); }
    };
    const fetchLatest = async () => {
        setBusy(true); setError('');
        try { const record = supportRecordSchema.parse(await api(path)); if (alive.current) setLatest(record); }
        catch (e) { if (alive.current) setError((e as Error).message); }
        finally { if (alive.current) setBusy(false); }
    };
    const field = (key: keyof Fields) => ({ value: fields[key], maxLength: 2000, disabled: busy, onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setFields(old => ({ ...old, [key]: e.target.value })) });
    return <section hidden={!open} aria-label={`支援記録 ${requestId}`}><h3 ref={heading} tabIndex={-1}>支援記録</h3><p>要求：{requestId}。入力を後回しにしても、支援や再開は続けられます。</p>
        {error && <p role="alert">記録を取得または保存できませんでした：{error}</p>}
        {!loaded ? <><p role="status">記録を読み込んでいます。</p>{error && <button onClick={() => { setError(''); setLoaded(false); onClose(); }}>閉じて後で開く</button>}</> : <form onSubmit={e => { e.preventDefault(); void save(); }}>
            <label>どこでつまずいたか<textarea {...field('observedDifficulty')}/></label>
            <label>何をしたか<textarea {...field('assistanceGiven')}/></label>
            <label>次回の改善提案<textarea {...field('improvementSuggestion')}/></label>
            <button type="submit" disabled={busy || conflict}>記録を保存</button>
        </form>}
        {conflict && <aside><p>別の更新があります。入力は保持しています。最新内容を比較してから保存してください。</p>
            <button disabled={busy} onClick={() => void fetchLatest()}>最新の記録を確認</button>
            {latest && <><dl><dt>つまずき</dt><dd>{latest.observedDifficulty || 'なし'}</dd><dt>したこと</dt><dd>{latest.assistanceGiven || 'なし'}</dd><dt>改善提案</dt><dd>{latest.improvementSuggestion || 'なし'}</dd></dl>
                <button disabled={busy} onClick={() => { setRevision(latest.revision); setLatest(undefined); setConflict(false); }}>最新の版を基準に入力内容を再確認</button></>}
        </aside>}
        <button disabled={busy} onClick={onClose}>後で記録する</button>
    </section>;
}
