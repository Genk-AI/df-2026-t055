import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRepository, doc } from '../apps/api/src/adapters.ts';
import { frozenCorrections } from '../apps/api/src/correction-input.ts';

const change = (stepId: string, after: string) => ({ stepId, field: 'text', before: '前', after });
test('corrections are scoped, latest per field, bounded and separate facts from notes', async () => {
    const db = new MemoryRepository();
    const add = (id: string, orgId: string, learnerId: string, taskId: string, createdAt: string, changes: object[], extra: object = {}) =>
        db.put('draftCorrections', doc(orgId, { id, learnerId, taskId, createdAt, draftRevision: 1, changes, ...extra }));
    add('old', 'demo', 'a', 'task', '2026-01-01T00:00:00.000Z', [change('s', '古い'), change('other', '残す')], { contextSummary: { editSummary: '旧要約', nextDraftHint: '旧参考', reviewFlags: [] } });
    add('new', 'demo', 'a', 'task', '2026-01-02T00:00:00.000Z', [change('s', '新しい')], { contextSummary: { editSummary: '新要約', nextDraftHint: '新参考', reviewFlags: [] } });
    add('other-org', 'other', 'a', 'task', '2026-01-03T00:00:00.000Z', [change('s', 'secret')]);
    add('other-person', 'demo', 'b', 'task', '2026-01-03T00:00:00.000Z', [change('s', 'secret')]);
    add('other-task', 'demo', 'a', 'other', '2026-01-03T00:00:00.000Z', [change('s', 'secret')]);
    const result = await frozenCorrections(db, 'demo', 'a', 'task');
    assert.deepEqual(result.map(c => c.correctionId), ['new', 'old']);
    assert.equal(result[0].changes[0].after, '新しい');
    assert.equal(result[0].contextSummary?.editSummary, '新要約');
    assert.deepEqual(result[1].changes.map(c => c.stepId), ['other']);
    assert.equal(result[1].contextSummary, undefined);
    assert.equal(JSON.stringify(result).includes('secret'), false);
    for (let i = 0; i < 25; i++) add(`extra-${i}`, 'demo', 'a', 'task', `2026-02-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`, [change(`step-${i}`, `${i}`)]);
    assert.equal((await frozenCorrections(db, 'demo', 'a', 'task')).length, 20);
});

test('same-millisecond corrections use transactional sequence rather than UUID order', async () => {
    const db = new MemoryRepository();
    const createdAt = '2026-01-01T00:00:00.000Z';
    db.put('draftCorrections', doc('demo', { id: 'zz-older', taskId: 'task', learnerId: 'a', draftId: 'one', draftRevision: 2, correctionSequence: 1, createdAt, changes: [change('s', '古い')] }));
    db.put('draftCorrections', doc('demo', { id: 'aa-newer', taskId: 'task', learnerId: 'a', draftId: 'two', draftRevision: 2, correctionSequence: 2, createdAt, changes: [change('s', '新しい')] }));
    const result = await frozenCorrections(db, 'demo', 'a', 'task');
    assert.deepEqual(result.map(c => c.correctionId), ['aa-newer']);
    assert.equal(result[0].changes[0].after, '新しい');
});

test('deduplication never pulls a correction from before the latest 20 histories', async () => {
    const db = new MemoryRepository();
    db.put('draftCorrections', doc('demo', { id: 'old', taskId: 'task', learnerId: 'a', draftId: 'd', draftRevision: 1, correctionSequence: 1, changes: [change('old-only', '対象外')] }));
    for (let i = 2; i <= 21; i++) db.put('draftCorrections', doc('demo', { id: `entry-${i}`, taskId: 'task', learnerId: 'a', draftId: 'd', draftRevision: i, correctionSequence: i, changes: [change('same', `値${i}`)] }));
    const result = await frozenCorrections(db, 'demo', 'a', 'task');
    assert.deepEqual(result.map(c => c.correctionId), ['entry-21']);
});

test('ambiguous legacy order fails closed; same-draft revisions can be ordered', async () => {
    const db = new MemoryRepository(); const createdAt = '2026-01-01T00:00:00.000Z';
    const entry = (id: string, draftId: string, draftRevision: number) => doc('demo', { id, taskId: 'task', learnerId: 'a', draftId, draftRevision, createdAt, changes: [change('s', id)] });
    db.put('draftCorrections', entry('first', 'd', 1));
    db.put('draftCorrections', entry('second', 'd', 2));
    assert.equal((await frozenCorrections(db, 'demo', 'a', 'task'))[0].correctionId, 'second');
    db.put('draftCorrections', entry('other', 'other-draft', 1));
    await assert.rejects(frozenCorrections(db, 'demo', 'a', 'task'), /CORRECTION_ORDER_AMBIGUOUS/);
});

test('ambiguous legacy entries outside the newest 20 do not block generation', async () => {
    const db = new MemoryRepository(); const createdAt = '2026-01-01T00:00:00.000Z';
    for (const id of ['old-a', 'old-b']) db.put('draftCorrections', doc('demo', { id, taskId: 'task', learnerId: 'a', draftId: id, draftRevision: 1, createdAt, changes: [change(id, id)] }));
    for (let sequence = 1; sequence <= 20; sequence++) db.put('draftCorrections', doc('demo', { id: `new-${sequence}`, taskId: 'task', learnerId: 'a', draftId: 'd', draftRevision: sequence, correctionSequence: sequence, changes: [change(`s${sequence}`, '新')]}));
    const result = await frozenCorrections(db, 'demo', 'a', 'task');
    assert.equal(result.length, 20);
    assert.ok(result.every(c => c.correctionId.startsWith('new-')));
});
