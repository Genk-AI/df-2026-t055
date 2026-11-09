import { frozenCorrectionSchema } from '../../../packages/shared/src/generation.ts';
import type { Repository } from './adapters.ts';
import { newestCorrections } from './correction-order.ts';

// Freeze only the latest change for each step/field, from at most 20 histories.
export async function frozenCorrections(
  db: Repository,
  orgId: string,
  learnerId: string,
  taskId: string,
) {
  const entries = newestCorrections(
    (await db.all('draftCorrections')).filter(
      (c) => c.orgId === orgId && c.learnerId === learnerId && c.taskId === taskId,
    ),
  ).slice(0, 20);
  const seen = new Set<string>();
  const selected: Array<ReturnType<typeof frozenCorrectionSchema.parse>> = [];
  for (const entry of entries) {
    const changes = [];
    let superseded = false;
    for (const c of entry.changes) {
      if (!['text', 'imageAltText', 'visibleCaution'].includes(c.field)) continue;
      const key = JSON.stringify([c.stepId, c.field]);
      if (seen.has(key)) {
        superseded = true;
        continue;
      }
      seen.add(key);
      changes.push({
        stepId: c.stepId,
        field: c.field,
        before: c.before ?? '',
        after: c.after ?? '',
      });
    }
    if (!changes.length) continue;
    const parsed = frozenCorrectionSchema.safeParse({
      correctionId: entry.id,
      draftRevision: entry.draftRevision,
      changes,
      ...(entry.contextSummary && !superseded ? { contextSummary: entry.contextSummary } : {}),
    });
    // A malformed reference note cannot prevent the original correction text from being used.
    if (parsed.success) selected.push(parsed.data);
    else {
      const fallback = frozenCorrectionSchema.safeParse({
        correctionId: entry.id,
        draftRevision: entry.draftRevision,
        changes,
      });
      if (fallback.success) selected.push(fallback.data);
    }
  }
  return selected;
}
