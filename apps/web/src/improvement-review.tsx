import React from 'react';
import type { EditedStep, SupportRecordRef } from '../../../packages/shared/src/index.ts';

type Source = {
  learnerSteps: Array<{ text: string; imageAltText: string; visibleCaution: string }>;
  staffGuide: Array<{ sourceStartMs: number; sourceEndMs: number }>;
  videoAssetId: string;
};
type Reference = { recordId: string; revision: number; summary: string };
export function ImprovementReview({
  source,
  steps,
  references,
  selected,
  onChange,
  video,
}: {
  source?: Source;
  steps: EditedStep[];
  references: Reference[];
  selected: SupportRecordRef[];
  onChange: (refs: SupportRecordRef[]) => void;
  video: (id: string, start: number, end: number) => React.ReactNode;
}) {
  return (
    <section aria-label='改善内容の比較'>
      <h2>元版と改善下書きの比較</h2>
      <p>
        工程を順番に並べています。追加・削除や順番の変更も含め、原動画を見て対応を確認してください。
      </p>
      {!source ? (
        <p role='status'>元版を読み込み中です</p>
      ) : (
        Array.from({ length: Math.max(source.learnerSteps.length, steps.length) }, (_, i) => {
          const before = source.learnerSteps[i],
            after = steps[i],
            guide = source.staffGuide[i];
          return (
            <section key={i}>
              <h3>順番 {i + 1}</h3>
              <div className='two'>
                <div>
                  <h4>元の承認版</h4>
                  {before ? (
                    <>
                      <p>文：{before.text}</p>
                      <p>写真の説明：{before.imageAltText}</p>
                      <p>注意：{before.visibleCaution || 'なし'}</p>
                      {guide && video(source.videoAssetId, guide.sourceStartMs, guide.sourceEndMs)}
                    </>
                  ) : (
                    <p>この順番の工程はありません。</p>
                  )}
                </div>
                <div>
                  <h4>改善下書き</h4>
                  {after ? (
                    <>
                      <p>文：{after.text}</p>
                      <p>写真の説明：{after.imageAltText || '未記入'}</p>
                      <p>注意：{after.visibleCaution || 'なし'}</p>
                      {video(source.videoAssetId, after.sourceStartMs, after.sourceEndMs)}
                    </>
                  ) : (
                    <p>この順番の工程はありません。</p>
                  )}
                </div>
              </div>
            </section>
          );
        })
      )}
      <h3>参照した支援記録</h3>
      <p>参照しただけの記録は未反映のままです。実際に反映した記録版だけを選んでください。</p>
      {references.map((r) => (
        <label key={`${r.recordId}:${r.revision}`}>
          <input
            type='checkbox'
            checked={selected.some((s) => s.recordId === r.recordId && s.revision === r.revision)}
            onChange={(e) =>
              onChange(
                e.target.checked
                  ? [...selected, { recordId: r.recordId, revision: r.revision }]
                  : selected.filter(
                      (s) => !(s.recordId === r.recordId && s.revision === r.revision),
                    ),
              )
            }
          />
          版 {r.revision}：{r.summary}
        </label>
      ))}
      {!references.length && <p>参照記録はありません。</p>}
      <p>承認と次回版への割当は別の操作です。現在の作業中の表示は変わりません。</p>
    </section>
  );
}
