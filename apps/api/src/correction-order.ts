import { createHash } from 'node:crypto';
import { doc, type Doc, type Repository } from './adapters.ts';

// Call inside the same transaction that writes the correction. The shared counter
// serializes saves for this org/person/task, including saves from different drafts.
export async function nextCorrectionSequence(
  db: Repository,
  orgId: string,
  learnerId: string,
  taskId: string,
) {
  const key = createHash('sha256')
    .update(JSON.stringify([orgId, learnerId, taskId]))
    .digest('hex');
  const counter = await db.get('correctionCounters', key);
  if (
    counter &&
    (counter.orgId !== orgId ||
      counter.learnerId !== learnerId ||
      counter.taskId !== taskId ||
      !Number.isSafeInteger(counter.sequence) ||
      counter.sequence < 0)
  )
    throw Error('INVALID_CORRECTION_COUNTER');
  if (!counter) {
    const existing = (await db.all('draftCorrections')).filter(
      (c) => c.orgId === orgId && c.learnerId === learnerId && c.taskId === taskId,
    );
    if (existing.some((c) => c.correctionSequence !== undefined))
      throw Error('CORRECTION_COUNTER_MISSING');
  }
  const sequence = (counter?.sequence ?? 0) + 1;
  if (!Number.isSafeInteger(sequence)) throw Error('CORRECTION_COUNTER_EXHAUSTED');
  await db.put(
    'correctionCounters',
    counter ? { ...counter, sequence } : doc(orgId, { id: key, learnerId, taskId, sequence }),
  );
  return sequence;
}

function ambiguous(): never {
  throw Object.assign(Error('CORRECTION_ORDER_AMBIGUOUS'), {
    status: 409,
    code: 'CORRECTION_ORDER_AMBIGUOUS',
  });
}

export function newestCorrections(entries: Doc[]) {
  const sequences = new Set<number>();
  const legacyTimes = new Map<string, Doc[]>();
  for (const entry of entries) {
    if (entry.correctionSequence !== undefined) {
      if (
        !Number.isSafeInteger(entry.correctionSequence) ||
        entry.correctionSequence < 1 ||
        sequences.has(entry.correctionSequence)
      )
        ambiguous();
      sequences.add(entry.correctionSequence);
    } else {
      const group = legacyTimes.get(entry.createdAt) ?? [];
      group.push(entry);
      legacyTimes.set(entry.createdAt, group);
    }
  }
  let neededLegacy = Math.max(0, 20 - sequences.size);
  for (const [, group] of [...legacyTimes].sort(([a], [b]) => b.localeCompare(a))) {
    if (!neededLegacy) break;
    if (
      group.length > 1 &&
      (!group[0].draftId ||
        group.some(
          (c) => c.draftId !== group[0].draftId || !Number.isSafeInteger(c.draftRevision),
        ) ||
        new Set(group.map((c) => c.draftRevision)).size !== group.length)
    )
      ambiguous();
    neededLegacy = Math.max(0, neededLegacy - group.length);
  }
  return entries.slice().sort((a, b) => {
    if (a.correctionSequence !== undefined && b.correctionSequence !== undefined)
      return b.correctionSequence - a.correctionSequence;
    if (a.correctionSequence !== undefined) return -1;
    if (b.correctionSequence !== undefined) return 1;
    return b.createdAt.localeCompare(a.createdAt) || b.draftRevision - a.draftRevision;
  });
}
