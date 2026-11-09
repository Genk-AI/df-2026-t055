import { supportWebSocket } from './support-ws.ts';
import http, { type Request, type Response, type NextFunction } from './http.ts';
import { uploadVideo } from './upload.ts';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { releaseCopyRequestSchema, releaseCopyResponseSchema, draftDetailSchema, editedStepSchema, eventSchema, approvalRequestSchema, releaseSchema, draftPatchSchema, sessionStartSchema, normalizeRelease, projectReleaseToSessionSteps, learnerSessionSchema, type Member } from '../../../packages/shared/src/index.ts';
import { learnerProfileCreateRequestSchema, learnerProfileUpdateRequestSchema, learnerProfileDetailSchema, learnerProfileListResponseSchema, toLearnerProfileSummary } from '../../../packages/shared/src/learner-profile.ts';
import { supportResumeRequestSchema, supportResumeResponseSchema, supportRecordSchema, supportRecordSaveRequestSchema, supportOperationRequestSchema, supportStartResponseSchema, supportAcknowledgeResponseSchema, supportClaimResponseSchema, supportRequestListResponseSchema, supportRequestStatusQuerySchema } from '../../../packages/shared/src/support.ts';
import { draftCorrectionSchema, correctionsListResponseSchema } from '../../../packages/shared/src/generation.ts';
import { MemoryRepository, seed, doc, id, now, type Repository, type Storage, type Auth, type Doc } from './adapters.ts';
import { configuredAuth } from './firebase-auth.ts';
import { configuredStorage } from './cloud-storage.ts';
import { configuredRepository } from './firestore-repository.ts';
import { configuredTts, type TtsAdapter } from './tts.ts';
import { media } from './media.ts';
import type { GenerationQueue } from './cloud-tasks.ts';
import { generationEnabled } from './generation-control.ts';
import { frozenCorrections } from './correction-input.ts';
import { nextCorrectionSequence } from './correction-order.ts';
import { guideGenerationRequestSchema, improvementGuideInputSnapshotSchema, initialGuideInputSnapshotSchema, correctionContextInputSnapshotSchema } from '../../../packages/shared/src/generation.ts';
export class HttpError extends Error {
    constructor(public status: number, public code: string) {
        super(code);
    }
}
export function fail(status: number, code: string): never {
    throw new HttpError(status, code);
}
function learnerProfileDetail(d: Doc) {
    return learnerProfileDetailSchema.parse({
        schemaVersion: '1', learnerId: d.id, orgId: d.orgId, displayName: d.displayName,
        preferences: d.preferences ?? {}, revision: d.revision ?? 1,
        enteredBy: d.enteredBy, updatedBy: d.updatedBy ?? d.enteredBy, createdAt: d.createdAt,
        ...Object.fromEntries(['learnerWishes', 'staffObservations', 'staffSuggestions', 'confirmedGuidance', 'disabilityInfo']
            .filter(key => d[key] !== undefined).map(key => [key, d[key]]))
    });
}
function savedRelease(d: Doc) {
    const { id, orgId, createdAt, approvalRequestId, ...contract } = d;
    return normalizeRelease({ schemaVersion: '1', appliedSupportRecordRefs: [], ...contract, releaseId: id });
}
export function createApp(options: {
    tts?: TtsAdapter;
    db?: Repository;
    storage?: Storage;
    auth?: Auth;
    globalLimit?: number;
    internalToken?: string;
    modelId?: string;
    runJob?: (jobId: string) => Promise<unknown>;
    queue?: GenerationQueue;
} = {}) {
    const db = options.db ?? configuredRepository();
    if (!options.db && db instanceof MemoryRepository)
        seed(db);
    const storage = options.storage ?? configuredStorage();
    const tts = options.tts ?? configuredTts();
    const auth = configuredAuth(db, process.env, undefined, options.auth);
    const app = http();
    const notifications = supportWebSocket(db, auth);
    app.upgrade = notifications.upgrade;
    const limit = options.globalLimit ?? Number(process.env.GENERATION_GLOBAL_LIMIT ?? 30);
    if (!Number.isInteger(limit) || limit < 0)
        throw Error('INVALID_GENERATION_GLOBAL_LIMIT');
    const internalToken = options.internalToken ?? process.env.INTERNAL_TOKEN ?? 'local-generator-only';
    app.use((req: Request, res: Response, next: NextFunction) => {
        res.set('Cache-Control', 'no-store');
        res.locals.requestId = id();
        next();
    });
    app.use(http.json({ limit: '1mb' }));
    app.use('/api/v1', async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (['/api/v1/internal/generate', '/api/v1/internal/drain'].includes(req.path)) {
                if (options.queue) fail(404, 'NOT_FOUND');
                if (req.headers.authorization !== `Bearer ${internalToken}`)
                    fail(403, 'INTERNAL_ONLY');
                return next();
            }
            const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
            const m = bearer ? await auth.verify(bearer[1]) : undefined;
            if (!m || (m.expiresAt !== undefined && (!Number.isFinite(m.expiresAt) || m.expiresAt <= Date.now())))
                fail(401, 'UNAUTHENTICATED');
            res.locals.member = m;
            if (!['GET', 'HEAD'].includes(req.method)) {
                const origin = req.headers.origin;
                if (origin && origin !== (process.env.WEB_ORIGIN ?? 'http://localhost:5173') && origin !== `http://${req.headers.host}`)
                    fail(403, 'ORIGIN');
                if (!req.is('application/json') && !req.is('multipart/form-data'))
                    fail(422, 'CONTENT_TYPE');
            }
            next();
        }
        catch (e) {
            next(e);
        }
    });
    const api = http.Router();
    app.use('/api/v1', api);
    const member = (res: Response) => res.locals.member as Member;
    const role = (res: Response, ...roles: string[]) => {
        if (!roles.includes(member(res).role))
            fail(403, 'FORBIDDEN');
    };
    const get = async (c: string, key: string, res: Response) => {
        const d = await db.get(c, key);
        if (!d)
            fail(404, 'NOT_FOUND');
        if (d.orgId !== member(res).orgId)
            fail(403, 'ORG_FORBIDDEN');
        return d;
    };
    const list = async (c: string, res: Response) => (await db.all(c)).filter(x => x.orgId === member(res).orgId);
    const send = (res: Response, data: object, status = 200) => res.status(status).json({ schemaVersion: '1', ...data });
    const staff = (res: Response) => role(res, 'staff');
    // ルートは対象ごとにまとめる。新しいルートは対象のまとまりへ追加し、競合時は両側のルートを残す。
    api.post('/tasks', async (req, res) => {
        staff(res);
        const { title } = z.object({ title: z.string().min(1).max(100) }).strict().parse(req.body);
        const t = doc(member(res).orgId, { title, status: 'uploading', createdBy: member(res).uid });
        await db.put('tasks', t);
        send(res, { taskId: t.id }, 201);
    });
    api.get('/tasks', async (req, res) => {
        staff(res);
        send(res, { tasks: await Promise.all((await list('tasks', res)).map(async (t) => ({ ...t, generationJobs: (await list('generationJobs', res)).filter(j => j.taskId === t.id).map(j => ({ jobId: j.id, draftId: j.draftId, status: j.status })) }))) });
    });
    api.get('/tasks/:id', async (req, res) => {
        staff(res);
        send(res, { task: await get('tasks', req.params.id, res) });
    });
    api.post('/tasks/:id/video', uploadVideo, async (req, res) => {
        staff(res);
        const t = await get('tasks', req.params.id, res);
        if (t.status !== 'uploading')
            fail(409, 'VIDEO_IMMUTABLE');
        if (!req.file)
            fail(422, 'VIDEO_REQUIRED');
        let durationMs;
        try {
            ({ durationMs } = await media(req.file.buffer));
        }
        catch {
            fail(422, 'INVALID_VIDEO');
        }
        const a = doc(t.orgId, {
            kind: 'video', objectPath: `source/${t.orgId}/${t.id}/${id()}.mp4`, generation: 1, mimeType: 'video/mp4', durationMs, visibility: 'staff'
        });
        a.generation = await storage.put(a.objectPath, req.file.buffer) ?? a.generation;
        await db.transaction(async () => {
            const fresh = await get('tasks', t.id, res);
            if (fresh.status !== 'uploading')
                fail(409, 'VIDEO_IMMUTABLE');
            await db.put('assets', a);
            await db.put('tasks', { ...fresh, videoAssetId: a.id, status: 'ready' });
        });
        send(res, { assetId: a.id, status: 'ready' });
    });
    api.post('/learners', async (req, res) => {
        staff(res);
        const input = learnerProfileCreateRequestSchema.parse(req.body);
        const m = member(res);
        const learner = doc(m.orgId, { ...input, preferences: input.preferences ?? {}, enteredBy: m.uid, updatedBy: m.uid, revision: 1 });
        const detail = learnerProfileDetail(learner);
        await db.put('learners', learner);
        res.status(201).json(detail);
    });
    api.get('/learners', async (req, res) => {
        staff(res);
        const items = (await list('learners', res)).map(d => toLearnerProfileSummary(learnerProfileDetail(d)));
        res.json(learnerProfileListResponseSchema.parse({ items }));
    });
    api.get('/learners/:id', async (req, res) => {
        staff(res);
        res.json(learnerProfileDetail(await get('learners', req.params.id, res)));
    });
    api.patch('/learners/:id', async (req, res) => {
        staff(res);
        await get('learners', req.params.id, res);
        const { expectedRevision, disabilityInfo, ...changes } = learnerProfileUpdateRequestSchema.parse(req.body);
        const detail = await db.transaction(async () => {
            const learner = await get('learners', req.params.id, res);
            const revision = learner.revision ?? 1;
            if (revision !== expectedRevision)
                fail(409, 'REVISION_CONFLICT');
            const updated: Doc = { ...learner, ...changes, updatedBy: member(res).uid, revision: revision + 1 };
            if (disabilityInfo === null)
                delete updated.disabilityInfo;
            else if (disabilityInfo !== undefined)
                updated.disabilityInfo = disabilityInfo;
            const detail = learnerProfileDetail(updated);
            await db.put('learners', updated);
            return detail;
        });
        res.json(detail);
    });
    api.post('/tasks/:id/generations', async (req, res) => {
        staff(res);
        const request = guideGenerationRequestSchema.parse(req.body);
        const { learnerId } = request;
        const t = await get('tasks', req.params.id, res);
        await get('learners', learnerId, res);
        const improvement = 'clientRequestId' in request ? request : undefined;
        const requestHash = improvement ? createHash('sha256').update(JSON.stringify({ taskId: t.id, ...improvement })).digest('hex') : undefined;
        const result = await db.transaction(async () => {
            const jobs = await db.all('generationJobs');
            if (improvement) {
                const existing = jobs.find(j => j.clientRequestId === improvement.clientRequestId && j.orgId === t.orgId);
                if (existing) {
                    if (existing.requestHash !== requestHash) fail(409, 'IDEMPOTENCY_CONFLICT');
                    return { jobId: existing.id, draftId: existing.draftId };
                }
            }
            if (!await generationEnabled(db)) fail(409, 'GENERATION_PAUSED');
            if ((await get('tasks', t.id, res)).status !== 'ready') fail(409, 'VIDEO_NOT_READY');
            const learner = await get('learners', learnerId, res);
            if (jobs.reduce((n, j) => n + j.budgetUsed, 0) >= limit || jobs.filter(j => j.taskId === t.id && j.kind !== 'correction_context').reduce((n, j) => n + j.budgetUsed, 0) >= 10)
                fail(409, 'GENERATION_LIMIT');
            const correctionInputs = await frozenCorrections(db, t.orgId, learnerId, t.id);
            let inputSnapshot: unknown;
            if (improvement) {
                const source = await get('releases', improvement.sourceReleaseId, res);
                const assignment = (await db.all('assignments')).find(a => a.orgId === t.orgId && a.taskId === t.id && a.learnerId === learnerId);
                if (source.taskId !== t.id || source.learnerId !== learnerId || assignment?.releaseId !== source.id) fail(409, 'SOURCE_RELEASE_CHANGED');
                for (const input of improvement.supportInputs) {
                    const record = await get('supportRecords', input.recordId, res);
                    if (record.taskId !== t.id || record.learnerId !== learnerId || record.revision !== input.revision) fail(409, 'SUPPORT_RECORD_CHANGED');
                }
                inputSnapshot = improvementGuideInputSnapshotSchema.parse({ taskId: t.id, learnerId, sourceReleaseId: source.id,
                    sourceReleaseVersion: source.version, supportInputs: improvement.supportInputs, correctionRefs: correctionInputs.map(c => ({ correctionId: c.correctionId, draftRevision: c.draftRevision })), correctionInputs,
                    displayMode: learner.preferences.displayMode ?? 'photo_text', confirmedGuidance: learner.confirmedGuidance ?? [] });
            } else if (correctionInputs.length) {
                const video = await get('assets', t.videoAssetId, res);
                inputSnapshot = initialGuideInputSnapshotSchema.parse({ taskId: t.id, learnerId, videoAssetId: video.id, title: t.title,
                    completionCriteria: '帯紙の向き、袋口、テープを見本と比較する', durationMs: video.durationMs,
                    preferences: { sentenceLength: learner.preferences.sentenceLength ?? 40, splitHints: learner.preferences.splitHints ?? '', audioGuidance: false },
                    displayMode: learner.preferences.displayMode ?? 'photo_text', confirmedGuidance: learner.confirmedGuidance ?? [], correctionInputs });
            }
            const d = doc(t.orgId, {
                taskId: t.id, learnerId, displayMode: learner.preferences.displayMode ?? 'photo_text', audioGuidance: learner.preferences.audioGuidance ?? false, revision: 0, status: 'generating', editedSteps: [], reviewChecks: { presentationConfirmed: false, flagResolution: '', steps: {} }, updatedBy: member(res).uid,
                ...(improvement ? { sourceReleaseId: improvement.sourceReleaseId, origin: 'improvement', appliedSupportRecordRefs: [] } : {})
            });
            const j = doc(t.orgId, {
                taskId: t.id, draftId: d.id, kind: 'guide', status: 'queued', attempt: 0, budgetUsed: 1, modelId: options.modelId ?? 'fake-fixture', promptVersion: '1',
                ...(inputSnapshot ? { inputSnapshot } : {}), ...(improvement ? { clientRequestId: improvement.clientRequestId, requestHash } : {})
            });
            d.jobId = j.id;
            await db.put('drafts', d);
            await db.put('generationJobs', j);
            return { jobId: j.id, draftId: d.id };
        });
        // The committed queued job is recovered by the external reconciliation schedule.
        if (options.queue) { try { await options.queue.enqueue(result.jobId); } catch { /* Recovery retries after transient enqueue errors. */ } }
        send(res, result, 202);
    });
    api.post('/releases/:id/drafts', async (req, res) => {
        staff(res);
        const { clientRequestId } = releaseCopyRequestSchema.parse(req.body);
        const source = await get('releases', req.params.id, res);
        const priorCopy = (await list('drafts', res)).find(d => d.sourceReleaseId === source.id && d.clientRequestId === clientRequestId);
        if (priorCopy) return res.status(201).json(releaseCopyResponseSchema.parse({ schemaVersion: '1', draftId: priorCopy.id, status: 'editing', revision: priorCopy.revision }));
        // Prepare media once; transaction retries only publish metadata.
        const copiedAssets: Doc[] = [];
        const release = savedRelease(source);
        const d = doc(source.orgId, {
            sourceReleaseId: source.id, clientRequestId, taskId: release.taskId, learnerId: release.learnerId,
            status: 'editing', revision: 0, displayMode: release.displayMode, audioGuidance: release.audioGuidance,
            appliedSupportRecordRefs: release.appliedSupportRecordRefs, updatedBy: member(res).uid
        });
        const editedSteps = [];
        for (const step of release.learnerSteps) {
            const guide = release.staffGuide.find(g => g.stepId === step.stepId);
            if (!guide)
                fail(422, 'INVALID_STEPS');
            const image = await get('assets', step.imageAssetId, res);
            if (image.kind !== 'image' || image.visibility !== 'approved' || image.releaseId !== source.id)
                fail(422, 'INVALID_IMAGE');
            const asset = doc(d.orgId, {
                kind: 'image', objectPath: `draft/${d.orgId}/${d.id}/${id()}.jpg`, generation: 1,
                mimeType: image.mimeType, sourceVideoId: image.sourceVideoId, frameMs: image.frameMs,
                draftId: d.id, visibility: 'staff'
            });
            asset.generation = await storage.copy(image.objectPath, asset.objectPath, image.generation) ?? asset.generation;
            copiedAssets.push(asset);
            const { order, audioAssetId, ...content } = step;
            editedSteps.push(editedStepSchema.parse({ ...content, ...guide, imageAssetId: asset.id, frameMs: asset.frameMs }));
        }
        d.editedSteps = editedSteps;
        d.reviewChecks = { presentationConfirmed: false, flagResolution: '', steps: Object.fromEntries(editedSteps.map(s => [s.stepId, { videoVerified: false, photoTextVerified: false }])) };
        const result = await db.transaction(async () => {
            const existing = (await list('drafts', res)).find(d => d.sourceReleaseId === source.id && d.clientRequestId === clientRequestId);
            if (existing)
                return existing;
            for (const asset of copiedAssets) await db.put('assets', asset);
            await db.put('drafts', d);
            return d;
        });
        res.status(201).json(releaseCopyResponseSchema.parse({ schemaVersion: '1', draftId: result.id, status: 'editing', revision: result.revision }));
    });
    api.get('/jobs/:id', async (req, res) => {
        staff(res);
        const j = await get('generationJobs', req.params.id, res);
        send(res, { status: j.status, draftId: j.draftId, errorCode: j.errorCode });
    });
    api.get('/drafts/:id', async (req, res) => {
        staff(res);
        const d = await get('drafts', req.params.id, res);
        if (d.sourceReleaseId) {
            const { id, orgId, createdAt, clientRequestId, modificationCount, correctionReason, ...detail } = d;
            return send(res, { draft: draftDetailSchema.parse({ ...detail, schemaVersion: '1', draftId: id }) });
        }
        send(res, { draft: d });
    });
    async function validSteps(d: Doc, steps: z.infer<typeof editedStepSchema>[], res: Response, requireImages = false) {
        const t = await get('tasks', d.taskId, res), v = await get('assets', t.videoAssetId, res);
        const ids = new Set();
        let previous = -1;
        for (const s of steps) {
            if (ids.has(s.stepId) || s.sourceStartMs < previous || s.sourceStartMs > s.frameMs || s.frameMs > s.sourceEndMs || s.sourceEndMs > v.durationMs)
                fail(422, 'INVALID_STEPS');
            ids.add(s.stepId);
            previous = s.sourceStartMs;
            if (s.imageAssetId) {
                const a = await get('assets', s.imageAssetId, res);
                if (a.kind !== 'image' || a.draftId !== d.id || a.sourceVideoId !== v.id || a.frameMs !== s.frameMs)
                    fail(422, 'INVALID_IMAGE');
            }
            else if (requireImages)
                fail(422, 'IMAGE_REQUIRED');
        }
    }
    api.patch('/drafts/:id', async (req, res) => {
        staff(res);
        const { displayMode, audioGuidance, appliedSupportRecordRefs, correctionReason, ...input } = draftPatchSchema.parse(req.body);
        const result = await db.transaction(async () => {
            const d = await get('drafts', req.params.id, res);
            if (d.status !== 'editing' || d.revision !== input.expectedRevision)
                fail(409, 'REVISION_CONFLICT');
            await validSteps(d, input.editedSteps, res);
            const previousSteps = new Map<string, { step: z.infer<typeof editedStepSchema>; index: number }>(d.editedSteps.map((step: z.infer<typeof editedStepSchema>, index: number) => [step.stepId, { step, index }]));
            const currentSteps = new Map(input.editedSteps.map((step, index) => [step.stepId, { step, index }]));
            const changedFields = ['text', 'visibleCaution', 'imageAltText', 'imageAssetId', 'sourceStartMs', 'sourceEndMs', 'frameMs', 'verifiedObservation', 'verifiedSpeech', 'coaching', 'completionCheck'] as const;
            const changes: z.infer<typeof draftCorrectionSchema>['changes'] = [];
            for (const stepId of new Set([...previousSteps.keys(), ...currentSteps.keys()])) {
                const before = previousSteps.get(stepId), after = currentSteps.get(stepId);
                for (const field of changedFields) {
                    const oldValue = before?.step[field] ?? null, newValue = after?.step[field] ?? null;
                    if (oldValue !== newValue) changes.push({ stepId, field, before: oldValue, after: newValue });
                }
                const oldPosition = before?.index ?? null, newPosition = after?.index ?? null;
                if (oldPosition !== newPosition) changes.push({ stepId, field: 'position', before: oldPosition, after: newPosition });
            }
            const reviewChecks: typeof input.reviewChecks = { ...input.reviewChecks, steps: {} };
            if ((displayMode ?? d.displayMode ?? 'photo_text') !== (d.displayMode ?? 'photo_text') ||
                (audioGuidance ?? d.audioGuidance ?? false) !== (d.audioGuidance ?? false) ||
                d.editedSteps.length !== input.editedSteps.length)
                reviewChecks.presentationConfirmed = false;
            reviewChecks.steps = Object.fromEntries(input.editedSteps.flatMap((step, index) => {
                const previous = previousSteps.get(step.stepId);
                const videoChanged = !previous || previous.index !== index ||
                    previous.step.sourceStartMs !== step.sourceStartMs || previous.step.sourceEndMs !== step.sourceEndMs || previous.step.frameMs !== step.frameMs;
                const explanationChanged = !previous || (['imageAssetId', 'text', 'visibleCaution', 'imageAltText', 'coaching', 'verifiedObservation', 'verifiedSpeech', 'completionCheck'] as const)
                    .some(field => previous.step[field] !== step[field]);
                if (videoChanged || explanationChanged) {
                    reviewChecks.presentationConfirmed = false;
                    return [[step.stepId, { videoVerified: videoChanged ? false : (input.reviewChecks.steps[step.stepId]?.videoVerified ?? false), photoTextVerified: false }]];
                }
                const checks = input.reviewChecks.steps[step.stepId];
                return checks ? [[step.stepId, checks]] : [];
            }));
            const modificationCount = input.editedSteps.filter(s => {
                const ai = d.aiProposal?.steps.find((p: any) => p.stepId === s.stepId);
                return !ai || s.text !== ai.instructionDraft || s.sourceStartMs !== ai.startMs || s.sourceEndMs !== ai.endMs || s.frameMs !== ai.frameMs || s.coaching !== ai.coachingDraft;
            }).length;
            await db.put('drafts', {
                ...d, ...(displayMode !== undefined ? { displayMode } : {}), ...(audioGuidance !== undefined ? { audioGuidance } : {}), ...(appliedSupportRecordRefs !== undefined ? { appliedSupportRecordRefs } : {}), ...(correctionReason !== undefined ? { correctionReason } : {}), editedSteps: input.editedSteps, reviewChecks, modificationCount, revision: d.revision + 1, updatedBy: member(res).uid
            });
            let contextJobId: string | undefined;
            if (changes.length) {
                const correctionSequence = await nextCorrectionSequence(db, d.orgId, d.learnerId, d.taskId);
                const correction = doc(member(res).orgId, { correctionSequence, taskId: d.taskId, learnerId: d.learnerId, draftId: d.id,
                    draftRevision: d.revision + 1, changes, ...(correctionReason !== undefined ? { reason: correctionReason } : {}), createdBy: member(res).uid });
                const eligible = changes.filter(c => ['text', 'imageAltText', 'visibleCaution'].includes(c.field));
                if (eligible.length && await generationEnabled(db)) {
                    const jobs = await db.all('generationJobs');
                    if (jobs.reduce((n, j) => n + j.budgetUsed, 0) < limit) {
                        const task = await get('tasks', d.taskId, res);
                        const snapshot = correctionContextInputSnapshotSchema.safeParse({ correctionId: correction.id, draftRevision: correction.draftRevision, title: task.title,
                            changes: eligible.map(c => ({ stepId: c.stepId, field: c.field, before: c.before ?? '', after: c.after ?? '' })) });
                        if (snapshot.success) {
                            const job = doc(d.orgId, { taskId: d.taskId, draftId: d.id, kind: 'correction_context', status: 'queued', attempt: 0, budgetUsed: 1,
                                modelId: options.modelId ?? 'fake-fixture', promptVersion: '1', inputSnapshot: snapshot.data });
                            contextJobId = job.id;
                            correction.contextJobId = job.id;
                            await db.put('generationJobs', job);
                        }
                    }
                }
                const { id: correctionId, orgId: _orgId, correctionSequence: _sequence, ...details } = correction;
                draftCorrectionSchema.parse({ ...details, schemaVersion: '1', correctionId });
                await db.put('draftCorrections', correction);
            }
            return { revision: d.revision + 1, reviewChecks, contextJobId };
        });
        // The scheduler (or local drain) discovers the committed job without delaying editing.
        const { contextJobId: _contextJobId, ...response } = result;
        send(res, response);
    });
    api.get('/learners/:learnerId/work-guides/:taskId/corrections', async (req, res) => {
        staff(res);
        await get('learners', req.params.learnerId, res);
        await get('tasks', req.params.taskId, res);
        const entries = (await list('draftCorrections', res)).filter(c => c.learnerId === req.params.learnerId && c.taskId === req.params.taskId);
        const jobs = await list('generationJobs', res);
        const corrections = entries.map(({ id, orgId, correctionSequence, ...entry }) => {
            const job = jobs.find(j => j.id === entry.contextJobId && j.kind === 'correction_context');
            return { ...entry, schemaVersion: '1', correctionId: id, ...(job ? { contextJobStatus: job.status } : {}) };
        }).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.correctionId.localeCompare(b.correctionId));
        res.json(correctionsListResponseSchema.parse({ corrections }));
    });
    api.post('/drafts/:id/frames', async (req, res) => {
        staff(res);
        const { frameMs } = z.object({ frameMs: z.number().int().nonnegative() }).strict().parse(req.body);
        const d = await get('drafts', req.params.id, res);
        if (d.status !== 'editing')
            fail(409, 'DRAFT_CLOSED');
        const t = await get('tasks', d.taskId, res), v = await get('assets', t.videoAssetId, res);
        let image;
        try {
            ({ image } = await media(await storage.get(v.objectPath, v.generation), frameMs));
        }
        catch {
            fail(422, 'INVALID_FRAME');
        }
        const a = doc(d.orgId, {
            kind: 'image', objectPath: `draft/${d.orgId}/${d.id}/${id()}.jpg`, generation: 1, mimeType: 'image/jpeg', sourceVideoId: v.id, frameMs, draftId: d.id, visibility: 'staff'
        });
        a.generation = await storage.put(a.objectPath, image!) ?? a.generation;
        await db.put('assets', a);
        send(res, { imageAssetId: a.id });
    });
    api.post('/drafts/:id/approve', async (req, res) => {
        staff(res);
        const { expectedRevision, approvalRequestId } = approvalRequestSchema.parse(req.body);
        const d = await get('drafts', req.params.id, res);
        const existing = (await list('releases', res)).find(r => r.sourceDraftId === d.id && r.approvalRequestId === approvalRequestId);
        if (existing)
            return send(res, { releaseId: existing.id, version: existing.version });
        if (d.status !== 'editing' || d.revision !== expectedRevision)
            fail(409, 'REVISION_CONFLICT');
        const steps = z.array(editedStepSchema).min(1).max(20).parse(d.editedSteps);
        await validSteps(d, steps, res, true);
        if (!d.reviewChecks.presentationConfirmed || steps.some(s => !d.reviewChecks.steps[s.stepId]?.videoVerified || !d.reviewChecks.steps[s.stepId]?.photoTextVerified))
            fail(422, 'REVIEW_REQUIRED');
        if (d.sourceReleaseId) {
            const source = await get('releases', d.sourceReleaseId, res);
            if (source.taskId !== d.taskId || source.learnerId !== d.learnerId)
                fail(422, 'INVALID_SOURCE_RELEASE');
            const job = d.jobId ? await get('generationJobs', d.jobId, res) : undefined;
            if (job && (job.draftId !== d.id || job.taskId !== d.taskId || job.inputSnapshot?.sourceReleaseId !== source.id)) fail(422, 'INVALID_IMPROVEMENT_JOB');
            const allowed = job ? job.inputSnapshot.supportInputs : source.appliedSupportRecordRefs ?? [];
            if ((d.appliedSupportRecordRefs ?? []).some((ref: any) => !allowed.some((input: any) => input.recordId === ref.recordId && input.revision === ref.revision)))
                fail(422, 'INVALID_SUPPORT_RECORD_REFS');
        }
        if (d.aiProposal && (d.aiProposal.reviewFlags.length || d.aiProposal.steps.some((s: any) => s.reviewFlags.length)) && !d.reviewChecks.flagResolution.trim())
            fail(422, 'FLAGS_UNRESOLVED');
        const releaseId = id();
        const assets: Doc[] = [];
        for (const s of steps) {
            const source = await get('assets', s.imageAssetId, res);
            const a = doc(d.orgId, {
                ...source, id: id(), createdAt: now(), objectPath: `approved/${d.orgId}/${releaseId}/${id()}.jpg`, visibility: 'approved', releaseId
            });
            a.generation = await storage.copy(source.objectPath, a.objectPath, source.generation) ?? a.generation;
            assets.push(a);
        }
        // TTS and Storage must not run inside a retryable Firestore callback.
        const audioAssets: Doc[] = [];
        const learner = await get('learners', d.learnerId, res);
        const audioGuidance = (d.audioGuidance ?? learner.preferences.audioGuidance) === true;
        const displayMode = d.displayMode ?? 'photo_text';
        if (audioGuidance) {
            try {
                for (const s of steps) {
                    const audio = await tts.synthesize(s.text);
                    if (!audio.bytes.length || audio.mimeType !== 'audio/wav' || !Number.isFinite(audio.durationMs) || audio.durationMs <= 0)
                        throw Error('INVALID_TTS_AUDIO');
                    const a = doc(d.orgId, {
                        kind: 'audio', objectPath: `approved/${d.orgId}/${releaseId}/${id()}.wav`,
                        generation: 1, mimeType: audio.mimeType, durationMs: audio.durationMs,
                        visibility: 'approved', releaseId
                    });
                    a.generation = await storage.put(a.objectPath, audio.bytes) ?? a.generation;
                    audioAssets.push(a);
                }
            } catch {
                fail(502, 'TTS_GENERATION_FAILED');
            }
        }
        const result = await db.transaction(async () => {
            const prior = (await list('releases', res)).find(r => r.sourceDraftId === d.id && r.approvalRequestId === approvalRequestId);
            if (prior)
                return prior;
            const fresh = await get('drafts', d.id, res);
            if (fresh.revision !== expectedRevision || fresh.status !== 'editing')
                fail(409, 'REVISION_CONFLICT');
            const currentLearner = await get('learners', d.learnerId, res);
            if ((currentLearner.preferences.audioGuidance === true) !== (learner.preferences.audioGuidance === true))
                fail(409, 'REVISION_CONFLICT');
            const learnerSteps = steps.map((s, i) => ({
                stepId: s.stepId, order: i + 1, imageAssetId: assets[i].id, imageAltText: s.imageAltText?.trim() || s.text, ...(audioAssets[i] ? { audioAssetId: audioAssets[i].id } : {}), text: s.text, visibleCaution: s.visibleCaution
            }));
            const staffGuide = steps.map(({ stepId, sourceStartMs, sourceEndMs, verifiedObservation, verifiedSpeech, coaching, completionCheck }) => ({
                stepId, sourceStartMs, sourceEndMs, verifiedObservation, verifiedSpeech, coaching, completionCheck
            }));
            const snapshot = releaseSchema.parse({
                schemaVersion: '1', releaseId, ...(d.sourceReleaseId ? { sourceReleaseId: d.sourceReleaseId } : {}), taskId: d.taskId, learnerId: d.learnerId, sourceDraftId: d.id, sourceRevision: d.revision, version: (await list('releases', res)).filter(r => r.taskId === d.taskId && r.learnerId === d.learnerId).length + 1, displayMode, audioGuidance, appliedSupportRecordRefs: fresh.appliedSupportRecordRefs ?? [], learnerSteps, staffGuide, approvedBy: member(res).uid, approvedAt: now(), contentHash: createHash('sha256').update(JSON.stringify({ displayMode, audioGuidance, learnerSteps, staffGuide })).digest('hex')
            });
            const r = doc(d.orgId, { ...snapshot, id: releaseId, approvalRequestId });
            for (const a of [...assets, ...audioAssets])
                await db.put('assets', a);
            await db.put('releases', r);
            await db.put('drafts', { ...fresh, status: 'approved' });
            return r;
        });
        send(res, { releaseId: result.id, version: result.version });
    });
    api.put('/assignments/:learnerId/:taskId', async (req, res) => {
        staff(res);
        const { releaseId } = z.object({ releaseId: z.string() }).strict().parse(req.body);
        await get('learners', req.params.learnerId, res);
        await get('tasks', req.params.taskId, res);
        const r = await get('releases', releaseId, res);
        if (r.learnerId !== req.params.learnerId || r.taskId !== req.params.taskId)
            fail(403, 'LEARNER_FORBIDDEN');
        const key = `${r.orgId}:${r.learnerId}:${r.taskId}`;
        await db.put('assignments', doc(r.orgId, {
            id: key, learnerId: r.learnerId, taskId: r.taskId, releaseId, assignedBy: member(res).uid, updatedAt: now()
        }));
        send(res, { releaseId });
    });
    const own = (s: Doc, res: Response) => {
        if (s.learnerId !== member(res).learnerId)
            fail(403, 'LEARNER_FORBIDDEN');
        return s;
    };
    async function dto(s: Doc) {
        const r = await db.get('releases', s.releaseId);
        if (!r || r.orgId !== s.orgId || r.learnerId !== s.learnerId)
            fail(403, 'RELEASE_FORBIDDEN');
        const release = savedRelease(r);
        // 旧承認版は audioGuidance を保存していない。読み上げは版に承認済み音声が
        // ある工程に限る（正本第3節）ため、設定がない版は音声資産の有無で決める。
        const audioGuidance = r.audioGuidance ?? release.learnerSteps.some(s => s.audioAssetId !== undefined);
        const steps = projectReleaseToSessionSteps(release).map(step => {
            if (audioGuidance) return step;
            const { audioAssetId, ...silent } = step;
            return silent;
        });
        return learnerSessionSchema.parse({
            schemaVersion: '1', sessionId: s.id, releaseId: release.releaseId,
            displayMode: release.displayMode, audioGuidance, steps,
            status: s.status, stepIndex: s.stepIndex, revision: s.revision
        });
    }
    api.get('/me/assignments', async (req, res) => {
        role(res, 'learner');
        send(res, { assignments: await Promise.all((await list('assignments', res)).filter(a => a.learnerId === member(res).learnerId).map(async (a) => ({ taskId: a.taskId, title: (await get('tasks', a.taskId, res)).title, releaseId: a.releaseId }))) });
    });
    api.post('/me/sessions', async (req, res) => {
        role(res, 'learner');
        const { taskId, clientRequestId } = sessionStartSchema.parse(req.body);
        const m = member(res);
        const session = await db.transaction(async () => {
            const prior = (await list('sessions', res)).find(s => s.learnerId === m.learnerId && s.clientRequestId === clientRequestId);
            if (prior)
                return prior;
            const a = (await list('assignments', res)).find(a => a.learnerId === m.learnerId && a.taskId === taskId);
            if (!a)
                fail(403, 'NOT_ASSIGNED');
            own(await get('releases', a.releaseId, res), res);
            const s = doc(m.orgId, {
                learnerId: m.learnerId, releaseId: a.releaseId, status: 'active', stepIndex: 0, revision: 0, startedAt: now(), clientRequestId
            });
            await db.put('sessions', s);
            return s;
        });
        res.json(await dto(session));
    });
    api.get('/me/sessions/:id', async (req, res) => {
        role(res, 'learner');
        res.json(await dto(own(await get('sessions', req.params.id, res), res)));
    });
    api.post('/me/sessions/:id/events', async (req, res) => {
        role(res, 'learner');
        const input = eventSchema.parse(req.body);
        const result = await db.transaction(async () => {
            const s = own(await get('sessions', req.params.id, res), res);
            const prior = (await list('sessionEvents', res)).find(e => e.sessionId === s.id && e.clientEventId === input.clientEventId);
            if (s.status === 'stopped') {
                if (input.type === 'stop')
                    return s;
                fail(409, 'SESSION_STOPPED');
            }
            if (prior)
                return s;
            if (input.type !== 'stop') {
                if (s.revision !== input.expectedRevision)
                    fail(409, 'REVISION_CONFLICT');
                if (s.status === 'completed')
                    fail(409, 'SESSION_COMPLETED');
            }
            const r = await get('releases', s.releaseId, res);
            switch (input.type) {
                case 'stop':
                    s.status = 'stopped';
                    s.endedAt = now();
                    break;
                case 'help':
                    if (s.status !== 'active')
                        fail(409, 'INVALID_STATE');
                    s.status = 'waiting_help';
                    break;
                case 'resume': {
                    const q = s.activeSupportRequestId ? await get('supportRequests', s.activeSupportRequestId, res) : undefined;
                    if (s.status !== 'waiting_help' || !q || q.sessionId !== s.id || q.kind !== 'help' || q.status !== 'acknowledged')
                        fail(409, 'HELP_PENDING');
                    s.status = 'active';
                    delete s.activeSupportRequestId;
                    break;
                }
                default:
                    if (s.status !== 'active')
                        fail(409, 'INVALID_STATE');
                    if (input.type === 'next') {
                        if (s.stepIndex >= r.learnerSteps.length - 1)
                            fail(409, 'LAST_STEP');
                        s.stepIndex++;
                    }
                    if (input.type === 'back')
                        s.stepIndex = Math.max(0, s.stepIndex - 1);
                    if (input.type === 'complete') {
                        if (s.stepIndex !== r.learnerSteps.length - 1)
                            fail(409, 'NOT_LAST_STEP');
                        s.status = 'completed';
                        s.endedAt = now();
                    }
            }
            s.revision++;
            const e = doc(s.orgId, {
                sessionId: s.id, clientEventId: input.clientEventId, type: input.type, stepId: r.learnerSteps[s.stepIndex].stepId, createdBy: member(res).uid, receivedAt: now()
            });
            await db.put('sessionEvents', e);
            if (['stop', 'help'].includes(input.type)) {
                const q = doc(s.orgId, {
                    sessionId: s.id, eventId: e.id, learnerId: s.learnerId, stepId: e.stepId, kind: input.type, status: 'open', revision: 1
                });
                if (input.type === 'help')
                    s.activeSupportRequestId = q.id;
                await db.put('supportRequests', q);
            }
            await db.put('sessions', s);
            return s;
        });
        notifications.publish(member(res).orgId, req.params.id);
        send(res, { status: result.status, stepIndex: result.stepIndex, revision: result.revision });
    });
    api.get('/support-requests', async (req, res) => {
        staff(res);
        if (req.searchParams.getAll('status').length > 1)
            fail(422, 'INVALID_INPUT');
        const { status } = supportRequestStatusQuerySchema.parse(Object.fromEntries(req.searchParams));
        const requests = (await list('supportRequests', res))
            .filter(q => status ? q.status === status : ['open', 'assigned', 'in_progress'].includes(q.status))
            .map(q => ({
                schemaVersion: '1', requestId: q.id, sessionId: q.sessionId, eventId: q.eventId,
                learnerId: q.learnerId, stepId: q.stepId, kind: q.kind, status: q.status, revision: q.revision, createdAt: q.createdAt,
                ...(q.kind === 'help' && q.status !== 'open' ? { assignedTo: q.assignedTo, assignedAt: q.assignedAt } : {}),
                ...(q.kind === 'help' && ['in_progress', 'acknowledged'].includes(q.status) ? { startedBy: q.startedBy, startedAt: q.startedAt } : {}),
                ...(q.status === 'acknowledged' ? { acknowledgedBy: q.acknowledgedBy, acknowledgedAt: q.acknowledgedAt } : {})
            }));
        res.json(supportRequestListResponseSchema.parse({ requests }));
    });
    api.post('/support-requests/:id/claim', async (req, res) => {
        staff(res);
        supportOperationRequestSchema.parse(req.body);
        const result = await db.transaction(async () => {
            const q = await get('supportRequests', req.params.id, res);
            if (q.kind !== 'help')
                fail(409, 'INVALID_STATE');
            if (q.status === 'assigned' && q.assignedTo === member(res).uid)
                return supportClaimResponseSchema.parse({ schemaVersion: '1', status: 'assigned', assignedTo: q.assignedTo, assignedAt: q.assignedAt, revision: q.revision });
            if (q.status !== 'open')
                fail(409, q.assignedTo && q.assignedTo !== member(res).uid ? 'CLAIM_CONFLICT' : 'INVALID_STATE');
            const response = supportClaimResponseSchema.parse({
                schemaVersion: '1', status: 'assigned', assignedTo: member(res).uid, assignedAt: now(), revision: q.revision + 1
            });
            const { schemaVersion, ...update } = response;
            await db.put('supportRequests', { ...q, ...update });
            return response;
        });
        notifications.publishRequest(member(res).orgId, req.params.id);
        res.json(result);
    });
    api.post('/support-requests/:id/start', async (req, res) => {
        staff(res);
        supportOperationRequestSchema.parse(req.body);
        const result = await db.transaction(async () => {
            const q = await get('supportRequests', req.params.id, res);
            if (q.kind !== 'help')
                fail(409, 'INVALID_STATE');
            if (q.assignedTo && q.assignedTo !== member(res).uid)
                fail(403, 'NOT_ASSIGNED');
            if (q.status === 'in_progress' && q.startedBy === member(res).uid)
                return supportStartResponseSchema.parse({ schemaVersion: '1', status: q.status, startedAt: q.startedAt });
            if (q.status !== 'assigned')
                fail(409, 'INVALID_STATE');
            if (q.assignedTo !== member(res).uid)
                fail(403, 'NOT_ASSIGNED');
            const response = supportStartResponseSchema.parse({ schemaVersion: '1', status: 'in_progress', startedAt: now() });
            await db.put('supportRequests', { ...q, status: response.status, startedAt: response.startedAt, startedBy: member(res).uid, revision: q.revision + 1 });
            return response;
        });
        notifications.publishRequest(member(res).orgId, req.params.id);
        res.json(result);
    });
    api.post('/support-requests/:id/acknowledge', async (req, res) => {
        staff(res);
        supportOperationRequestSchema.parse(req.body);
        const result = await db.transaction(async () => {
            const q = await get('supportRequests', req.params.id, res);
            if (q.kind === 'help' && q.assignedTo && q.assignedTo !== member(res).uid)
                fail(403, 'NOT_ASSIGNED');
            if (q.status === 'acknowledged' && q.acknowledgedBy === member(res).uid)
                return supportAcknowledgeResponseSchema.parse({ schemaVersion: '1', status: q.status, acknowledgedAt: q.acknowledgedAt });
            if (!(q.kind === 'help' && q.status === 'in_progress') && !(q.kind === 'stop' && q.status === 'open'))
                fail(409, 'INVALID_STATE');
            if (q.kind === 'help' && q.assignedTo !== member(res).uid)
                fail(403, 'NOT_ASSIGNED');
            const response = supportAcknowledgeResponseSchema.parse({ schemaVersion: '1', status: 'acknowledged', acknowledgedAt: now() });
            await db.put('supportRequests', { ...q, status: response.status, acknowledgedAt: response.acknowledgedAt, acknowledgedBy: member(res).uid, revision: q.revision + 1 });
            return response;
        });
        notifications.publishRequest(member(res).orgId, req.params.id);
        res.json(result);
    });
    api.post('/support-requests/:id/resume', async (req, res) => {
        staff(res);
        const input = supportResumeRequestSchema.parse(req.body);
        const result = await db.transaction(async () => {
            const q = await get('supportRequests', req.params.id, res);
            if (q.kind !== 'help' || !['in_progress', 'acknowledged'].includes(q.status))
                fail(409, 'INVALID_STATE');
            if (q.assignedTo !== member(res).uid)
                fail(403, 'NOT_ASSIGNED');
            const s = await get('sessions', q.sessionId, res);
            // Stop takes priority even over a successful resume retry.
            if (s.status === 'stopped')
                fail(409, 'SESSION_STOPPED');
            const prior = (await list('sessionEvents', res)).find(e =>
                e.supportRequestId === q.id && e.clientRequestId === input.clientRequestId);
            if (prior) {
                if (prior.expectedSessionRevision !== input.expectedSessionRevision)
                    fail(409, 'REVISION_CONFLICT');
                return supportResumeResponseSchema.parse(prior.response);
            }
            if (s.revision !== input.expectedSessionRevision)
                fail(409, 'REVISION_CONFLICT');
            if (s.status !== 'waiting_help' || s.activeSupportRequestId !== q.id)
                fail(409, 'INVALID_STATE');
            const r = await get('releases', s.releaseId, res);
            const timestamp = now();
            const response = supportResumeResponseSchema.parse({
                schemaVersion: '1', sessionId: s.id, status: 'active', stepIndex: s.stepIndex, revision: s.revision + 1
            });
            const e = doc(s.orgId, {
                sessionId: s.id, supportRequestId: q.id, ...input, type: 'resume',
                stepId: r.learnerSteps[s.stepIndex].stepId, createdBy: member(res).uid, receivedAt: timestamp, response
            });
            if (q.status === 'in_progress')
                await db.put('supportRequests', { ...q, status: 'acknowledged', acknowledgedBy: member(res).uid,
                    acknowledgedAt: timestamp, revision: q.revision + 1 });
            s.status = response.status;
            s.revision = response.revision;
            delete s.activeSupportRequestId;
            await db.put('sessionEvents', e);
            await db.put('sessions', s);
            return response;
        });
        notifications.publishRequest(member(res).orgId, req.params.id);
        res.json(result);
    });
    const recordDto = (record: Doc) => {
        const { id, orgId, ...fields } = record;
        return supportRecordSchema.parse({ ...fields, schemaVersion: '1', recordId: id });
    };
    api.get('/support-requests/:id/record', async (req, res) => {
        staff(res);
        await get('supportRequests', req.params.id, res);
        res.json(recordDto(await get('supportRecords', req.params.id, res)));
    });
    api.put('/support-requests/:id/record', async (req, res) => {
        staff(res);
        const { expectedRevision, ...text } = supportRecordSaveRequestSchema.parse(req.body);
        const result = await db.transaction(async () => {
            const q = await get('supportRequests', req.params.id, res);
            if (q.kind !== 'help' || !['in_progress', 'acknowledged'].includes(q.status))
                fail(409, 'INVALID_STATE');
            const session = await get('sessions', q.sessionId, res);
            const release = await get('releases', session.releaseId, res);
            const event = await get('sessionEvents', q.eventId, res);
            if (release.learnerId !== session.learnerId || event.sessionId !== session.id || event.type !== 'help' ||
                !release.learnerSteps.some((step: any) => step.stepId === event.stepId))
                fail(409, 'INVALID_STATE');
            // The request UUID is also the record UUID, so concurrent first saves cannot create duplicates.
            const prior = await db.get('supportRecords', q.id);
            if (prior && prior.orgId !== member(res).orgId)
                fail(403, 'ORG_FORBIDDEN');
            if ((prior?.revision ?? 0) !== expectedRevision)
                fail(409, 'REVISION_CONFLICT');
            const timestamp = now();
            const record = doc(q.orgId, {
                id: q.id, supportRequestId: q.id, sessionId: session.id, learnerId: session.learnerId,
                taskId: release.taskId, releaseId: release.id, stepId: event.stepId, ...text,
                createdBy: prior?.createdBy ?? member(res).uid, createdAt: prior?.createdAt ?? timestamp,
                updatedBy: member(res).uid, updatedAt: timestamp, revision: expectedRevision + 1
            });
            const response = recordDto(record);
            await db.put('supportRecords', record);
            return response;
        });
        res.json(result);
    });
    api.get('/handover/releases', async (req, res) => {
        role(res, 'staff', 'newcomer');
        send(res, { releases: await Promise.all((await list('releases', res)).map(async (r) => ({
                releaseId: r.id, taskId: r.taskId, title: (await get('tasks', r.taskId, res)).title, learnerId: r.learnerId, displayName: (await get('learners', r.learnerId, res)).displayName, version: r.version, approvedBy: r.approvedBy, approvedAt: r.approvedAt
            }))) });
    });
    api.get('/handover/releases/:id', async (req, res) => {
        role(res, 'staff', 'newcomer');
        const r = await get('releases', req.params.id, res);
        send(res, { release: {
                releaseId: r.id, learnerSteps: r.learnerSteps, staffGuide: r.staffGuide, approvedBy: r.approvedBy, approvedAt: r.approvedAt, videoAssetId: (await get('tasks', r.taskId, res)).videoAssetId
            } });
    });
    api.post('/handover/releases/:id/read', async (req, res) => {
        role(res, 'newcomer');
        const r = await get('releases', req.params.id, res);
        const readAt = now();
        await db.put('handoverReads', doc(r.orgId, { releaseId: r.id, newcomerUid: member(res).uid, readAt }));
        send(res, { readAt });
    });
    api.get('/assets/:id', async (req, res) => {
        const a = await get('assets', req.params.id, res), m = member(res);
        if (m.role === 'learner') {
            if (a.visibility !== 'approved' || !['image', 'audio'].includes(a.kind))
                fail(403, 'ASSET_FORBIDDEN');
            const r = own(await get('releases', a.releaseId, res), res);
            if (!r.learnerSteps.some((s: any) => (a.kind === 'audio' ? s.audioAssetId : s.imageAssetId) === a.id) || !(await list('assignments', res)).some(x => x.learnerId === m.learnerId && x.releaseId === r.id) && !(await list('sessions', res)).some(x => x.learnerId === m.learnerId && x.releaseId === r.id))
                fail(403, 'NOT_ASSIGNED');
        }
        if (m.role === 'newcomer') {
            // 既読記録を条件にしない。引き継ぎは内容を見てから「読んだ」を押す順序
            // （正本第2節）のため、初回閲覧の時点で承認版の素材が見えなければならない。
            const allowed = a.kind === 'video' ? (await Promise.all((await list('releases', res)).map(async (r) => (await get('tasks', r.taskId, res)).videoAssetId))).includes(a.id) : a.visibility === 'approved' && !!await db.get('releases', a.releaseId);
            if (!allowed)
                fail(403, 'ASSET_FORBIDDEN');
        }
        res.type(a.mimeType).send(await storage.open(a.objectPath, a.generation));
    });
    api.post('/internal/drain', async (req, res) => {
        if (!options.runJob)
            fail(503, 'WORKER_UNAVAILABLE');
        const j = (await db.all('generationJobs')).find(j => j.status === 'queued' || j.status === 'running' && j.leaseUntil <= Date.now());
        if (j)
            await options.runJob(j.id);
        send(res, { status: 'processed' });
    });
    api.post('/internal/generate', async (req, res) => {
        const { jobId } = z.object({ jobId: z.string() }).strict().parse(req.body);
        if (!options.runJob)
            fail(503, 'WORKER_UNAVAILABLE');
        await options.runJob(jobId);
        send(res, { status: 'processed' });
    });
    app.use((err: any, req: Request, res: Response, next: NextFunction) => {
        const status = err instanceof HttpError ? err.status : typeof err.status === 'number' ? err.status : err instanceof z.ZodError || err.type === 'entity.parse.failed' ? 422 : 500;
        res.status(status).json({ error: { code: status === 500 ? 'INTERNAL_ERROR' : err.code ?? 'INVALID_INPUT', message: status === 500 ? '処理に失敗しました' : '操作を確認してください', requestId: res.locals.requestId } });
    });
    return {
        app, db, storage, limit
    };
}
