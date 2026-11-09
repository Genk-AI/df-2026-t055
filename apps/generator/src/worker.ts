import { doc, now, type Repository, type Storage, type Doc } from '../../api/src/adapters.ts';
import { media } from '../../api/src/media.ts';
import type { EditedStep } from '../../../packages/shared/src/index.ts';
import { validateProposal, type VideoModel } from './model.ts';
import {
  improvementGuideInputSnapshotSchema,
  initialGuideInputSnapshotSchema,
  correctionContextInputSnapshotSchema,
  correctionContextOutputSchema,
} from '../../../packages/shared/src/generation.ts';
import { FakeCorrectionModel, type CorrectionModel } from './correction-model.ts';
export function createWorker(
  db: Repository,
  storage: Storage,
  model: VideoModel,
  globalLimit: number,
  correctionModel: CorrectionModel = new FakeCorrectionModel(),
) {
  return async function run(jobId: string) {
    let token = '';
    let job = await db.get('generationJobs', jobId);
    if (!job) throw Error('JOB_NOT_FOUND');
    if (['succeeded', 'failed'].includes(job.status)) return;
    const claimed = await db.transaction(async () => {
      job = (await db.get('generationJobs', jobId))!;
      if (['succeeded', 'failed'].includes(job.status)) return 'done';
      if (job.status === 'running' && job.leaseUntil > Date.now()) return 'busy';
      const jobs = await db.all('generationJobs');
      if (
        job.attempt >= 3 ||
        (job.attempt > 0 &&
          (jobs.reduce((n, j) => n + j.budgetUsed, 0) >= globalLimit ||
            (job.kind !== 'correction_context' &&
              jobs
                .filter((j) => j.taskId === job!.taskId && j.kind !== 'correction_context')
                .reduce((n, j) => n + j.budgetUsed, 0) >= 10)))
      ) {
        await db.put('generationJobs', { ...job, status: 'failed', errorCode: 'ATTEMPT_LIMIT' });
        if (job.kind !== 'correction_context') {
          const d = (await db.get('drafts', job.draftId))!;
          await db.put('drafts', { ...d, status: 'failed' });
        }
        return 'done';
      }
      token = crypto.randomUUID();
      job = {
        ...job,
        status: 'running',
        attempt: job.attempt + 1,
        budgetUsed: job.budgetUsed + (job.attempt > 0 ? 1 : 0),
        leaseUntil: Date.now() + 250000,
        leaseToken: token,
      };
      await db.put('generationJobs', job);
      return 'claimed';
    });
    if (claimed !== 'claimed') return claimed;
    const started = Date.now();
    let errorCode = 'GENERATION_FAILED';
    try {
      if (job.kind === 'correction_context') {
        const snapshot = correctionContextInputSnapshotSchema.parse(job.inputSnapshot);
        const controller = new AbortController();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        errorCode = 'MODEL_CALL_FAILED';
        const generated = await Promise.race([
          correctionModel.generate(
            {
              title: snapshot.title,
              changes: snapshot.changes.map((c) => ({
                field: c.field,
                before: c.before,
                after: c.after,
              })),
            },
            controller.signal,
          ),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              errorCode = 'MODEL_TIMEOUT';
              controller.abort();
              reject(Error('MODEL_TIMEOUT'));
            }, 120000);
          }),
        ]).finally(() => clearTimeout(timeout));
        errorCode = 'MODEL_OUTPUT_INVALID';
        const summary = correctionContextOutputSchema.parse(generated);
        await db.transaction(async () => {
          const current = await db.get('generationJobs', jobId);
          if (!current || current.leaseToken !== token || current.status !== 'running') return;
          const correction = await db.get('draftCorrections', snapshot.correctionId);
          if (
            !correction ||
            correction.orgId !== current.orgId ||
            correction.contextJobId !== current.id ||
            correction.draftRevision !== snapshot.draftRevision
          )
            throw Error('CORRECTION_CHANGED');
          await db.put('draftCorrections', { ...correction, contextSummary: summary });
          await db.put('generationJobs', {
            ...current,
            status: 'succeeded',
            finishedAt: now(),
            durationMs: Date.now() - started,
          });
        });
        return;
      }
      const d = (await db.get('drafts', job.draftId))!,
        t = (await db.get('tasks', job.taskId))!,
        v = (await db.get('assets', t.videoAssetId))!,
        l = (await db.get('learners', d.learnerId))!;
      let improvement: import('./model.ts').ModelInput['improvement'];
      let displayMode = d.displayMode ?? 'photo_text';
      let confirmedGuidance = l.confirmedGuidance ?? [];
      let frozen = job.inputSnapshot?.sourceReleaseId
        ? undefined
        : job.inputSnapshot
          ? initialGuideInputSnapshotSchema.parse(job.inputSnapshot)
          : undefined;
      if (
        frozen &&
        (frozen.taskId !== d.taskId ||
          frozen.learnerId !== d.learnerId ||
          frozen.videoAssetId !== v.id)
      )
        throw Error('INVALID_GUIDE_SNAPSHOT');
      let correctionInputs = frozen?.correctionInputs;
      if (frozen) {
        displayMode = frozen.displayMode;
        confirmedGuidance = frozen.confirmedGuidance;
      }
      let preferences = {
        sentenceLength: l.preferences.sentenceLength,
        splitHints: l.preferences.splitHints ?? '',
        audioGuidance: false,
      };
      if (job.inputSnapshot?.sourceReleaseId) {
        const snapshot = improvementGuideInputSnapshotSchema.parse(job.inputSnapshot);
        const source = await db.get('releases', snapshot.sourceReleaseId);
        if (
          !source ||
          source.orgId !== d.orgId ||
          source.taskId !== d.taskId ||
          source.learnerId !== d.learnerId ||
          source.version !== snapshot.sourceReleaseVersion ||
          snapshot.taskId !== d.taskId ||
          snapshot.learnerId !== d.learnerId ||
          d.sourceReleaseId !== source.id
        )
          throw Error('INVALID_IMPROVEMENT_SOURCE');
        correctionInputs = snapshot.correctionInputs;
        improvement = {
          sourceSteps: source.learnerSteps.map((s: any) => ({
            order: s.order,
            text: s.text,
            imageAltText: s.imageAltText,
            visibleCaution: s.visibleCaution,
          })),
          supportSummaries: snapshot.supportInputs.map((input) => input.summary),
        };
        displayMode = snapshot.displayMode;
        confirmedGuidance = snapshot.confirmedGuidance;
        preferences = snapshot.preferences;
      }
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      errorCode = 'MODEL_CALL_FAILED';
      const output = await Promise.race([
        model.generate(
          {
            // 未確認の希望は省略できる（正本第2節）ため、生成への入力は空の分割ヒントで補う。
            videoUri: v.objectPath,
            title: frozen?.title ?? t.title,
            completionCriteria:
              frozen?.completionCriteria ?? '帯紙の向き、袋口、テープを見本と比較する',
            preferences: frozen?.preferences ?? preferences,
            displayMode,
            confirmedGuidance,
            durationMs: v.durationMs,
            ...(improvement ? { improvement } : {}),
            ...(correctionInputs?.length
              ? {
                  corrections: correctionInputs.map((c) => ({
                    changes: c.changes.map((v) => ({
                      field: v.field,
                      before: v.before,
                      after: v.after,
                    })),
                    ...(c.contextSummary ? { referenceNote: c.contextSummary } : {}),
                  })),
                }
              : {}),
          },
          controller.signal,
        ),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            errorCode = 'MODEL_TIMEOUT';
            controller.abort();
            reject(Error('MODEL_TIMEOUT'));
          }, 120000);
        }),
      ]).finally(() => clearTimeout(timeout));
      errorCode = 'MODEL_OUTPUT_INVALID';
      const proposal = validateProposal(output, v.durationMs);
      errorCode = 'GENERATION_FAILED';
      const editedSteps: EditedStep[] = [];
      const assets: Doc[] = [];
      const video = await storage.get(v.objectPath, v.generation);
      for (const s of proposal.steps) {
        if (Date.now() - started > 230000) {
          errorCode = 'JOB_TIMEOUT';
          throw Error('JOB_TIMEOUT');
        }
        errorCode = 'FRAME_EXTRACTION_FAILED';
        const { image } = await media(video, s.frameMs);
        if (!image?.length) throw Error('FRAME_EXTRACTION_FAILED');
        errorCode = 'GENERATION_FAILED';
        const a = doc(d.orgId, {
          kind: 'image',
          objectPath: `draft/${d.orgId}/${d.id}/${crypto.randomUUID()}.jpg`,
          generation: 1,
          mimeType: 'image/jpeg',
          sourceVideoId: v.id,
          frameMs: s.frameMs,
          draftId: d.id,
          visibility: 'staff',
        });
        a.generation = (await storage.put(a.objectPath, image)) ?? a.generation;
        assets.push(a);
        editedSteps.push({
          stepId: s.stepId,
          text: s.instructionDraft,
          visibleCaution: '',
          imageAssetId: a.id,
          sourceStartMs: s.startMs,
          sourceEndMs: s.endMs,
          frameMs: s.frameMs,
          verifiedObservation: s.observationCandidate,
          verifiedSpeech: s.speechCandidate,
          coaching: s.coachingDraft,
          completionCheck: s.completionCheckDraft,
        });
      }
      await db.transaction(async () => {
        const current = (await db.get('generationJobs', jobId))!;
        if (current.leaseToken !== token || current.status !== 'running') return;
        for (const a of assets) await db.put('assets', a);
        await db.put('drafts', {
          ...d,
          status: 'editing',
          revision: 1,
          aiProposal: proposal,
          editedSteps,
          reviewChecks: {
            presentationConfirmed: false,
            flagResolution: '',
            steps: Object.fromEntries(
              editedSteps.map((s) => [
                s.stepId,
                { videoVerified: false, photoTextVerified: false },
              ]),
            ),
          },
        });
        await db.put('generationJobs', {
          ...current,
          status: 'succeeded',
          finishedAt: now(),
          durationMs: Date.now() - started,
        });
      });
    } catch {
      await db.transaction(async () => {
        const current = (await db.get('generationJobs', jobId))!;
        if (current.leaseToken !== token || current.status !== 'running') return;
        await db.put('generationJobs', {
          ...current,
          status: 'failed',
          errorCode,
          finishedAt: now(),
          durationMs: Date.now() - started,
        });
        if (current.kind !== 'correction_context') {
          const d = (await db.get('drafts', current.draftId))!;
          await db.put('drafts', { ...d, status: 'failed' });
        }
      });
    }
  };
}
