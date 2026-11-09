import { z } from 'zod';
import { supportRecordSchema } from './support.ts';

const id = z.string().min(1);
export const workGuideSchema = z.object({
    taskId: id, title: id,
    assignment: z.object({ releaseId: id, version: z.number().int().min(1) }).strict().nullable(),
    unappliedCount: z.number().int().nonnegative(),
    latestDraft: z.object({ draftId: id, status: z.enum(['generating', 'editing', 'approved', 'failed']), revision: z.number().int().nonnegative() }).strict().nullable(),
    latestGeneration: z.object({ jobId: id, status: z.enum(['queued', 'running', 'succeeded', 'failed']) }).strict().nullable()
}).strict();
export const workGuideListResponseSchema = z.object({ schemaVersion: z.literal('1'), items: z.array(workGuideSchema) }).strict();
export const workGuideRecordsResponseSchema = z.object({ schemaVersion: z.literal('1'), records: z.array(supportRecordSchema.extend({ applied: z.boolean() }).strict()) }).strict();
