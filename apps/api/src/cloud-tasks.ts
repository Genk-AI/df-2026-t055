import { createHash } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import type { Repository } from './adapters.ts';

export interface GenerationQueue {
  enqueue(jobId: string, now?: number): Promise<void>;
}
type QueueConfig = {
  project: string;
  location: string;
  queue: string;
  target: string;
  audience: string;
  serviceAccount: string;
};
type Transport = {
  request(options: {
    url: string;
    method: 'GET' | 'POST';
    data?: object;
  }): Promise<{ data?: unknown }>;
};
const bucketMs = 5 * 60_000;
export class CloudTasksQueue implements GenerationQueue {
  private transport: Transport;
  private parent: string;
  constructor(
    private config: QueueConfig,
    transport?: Transport,
  ) {
    for (const value of [config.project, config.location, config.queue])
      if (!/^[A-Za-z0-9_-]+$/.test(value)) throw Error('INVALID_TASKS_CONFIG');
    const target = new URL(config.target);
    if (
      target.protocol !== 'https:' ||
      target.username ||
      target.password ||
      target.search ||
      target.hash
    )
      throw Error('INVALID_TASKS_TARGET');
    if (!config.audience || !/^[^@\s]+@[^@\s]+\.gserviceaccount\.com$/.test(config.serviceAccount))
      throw Error('INVALID_TASKS_CONFIG');
    this.parent = `projects/${config.project}/locations/${config.location}/queues/${config.queue}`;
    this.transport =
      transport ??
      new GoogleAuth({
        projectId: config.project,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
  }
  private async assertQueuePolicy() {
    let value: unknown;
    try {
      value = (
        await this.transport.request({
          url: `https://cloudtasks.googleapis.com/v2/${this.parent}`,
          method: 'GET',
        })
      ).data;
    } catch {
      throw Error('TASK_QUEUE_INSPECTION_FAILED');
    }
    const queue = value as
      | {
          rateLimits?: { maxConcurrentDispatches?: number };
          retryConfig?: { maxAttempts?: number };
          httpTarget?: unknown;
        }
      | undefined;
    if (
      !queue ||
      queue.rateLimits?.maxConcurrentDispatches !== 1 ||
      queue.retryConfig?.maxAttempts !== 3 ||
      (queue.httpTarget != null &&
        (typeof queue.httpTarget !== 'object' || Object.keys(queue.httpTarget).length > 0))
    )
      throw Error('TASK_QUEUE_CONFIGURATION_INVALID');
  }
  async enqueue(jobId: string, now = Date.now()) {
    if (!/^[A-Za-z0-9_-]+$/.test(jobId) || !Number.isFinite(now)) throw Error('INVALID_TASK_JOB');
    // Queue-level routing and token overrides take precedence over task settings.
    await this.assertQueuePolicy();
    // A new recovery window gets a new name; Cloud Tasks keeps old names after deletion.
    const taskId = createHash('sha256')
      .update(`${jobId}:${Math.floor(now / bucketMs)}`)
      .digest('hex');
    const task = {
      name: `${this.parent}/tasks/${taskId}`,
      dispatchDeadline: '240s',
      httpRequest: {
        httpMethod: 'POST',
        url: this.config.target,
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify({ jobId })).toString('base64'),
        oidcToken: {
          serviceAccountEmail: this.config.serviceAccount,
          audience: this.config.audience,
        },
      },
    };
    try {
      await this.transport.request({
        url: `https://cloudtasks.googleapis.com/v2/${this.parent}/tasks`,
        method: 'POST',
        data: { task },
      });
    } catch (error: any) {
      if (error?.response?.status === 409) return;
      throw new Error('TASK_ENQUEUE_FAILED', { cause: error });
    }
  }
}
export function configuredQueue(env: NodeJS.ProcessEnv = process.env): GenerationQueue | undefined {
  const backend = env.QUEUE_BACKEND ?? 'local';
  if (backend === 'local') return undefined;
  if (backend !== 'cloud') throw Error('INVALID_QUEUE_BACKEND');
  return new CloudTasksQueue({
    project: env.GOOGLE_CLOUD_PROJECT ?? '',
    location: env.TASKS_LOCATION ?? '',
    queue: env.TASKS_QUEUE ?? '',
    target: env.GENERATOR_URL ?? '',
    audience: env.GENERATOR_AUDIENCE ?? '',
    serviceAccount: env.TASKS_SERVICE_ACCOUNT_EMAIL ?? '',
  });
}
// Run from an authenticated external scheduler, not an in-process background timer.
export async function reconcileGenerationJobs(
  db: Repository,
  queue: GenerationQueue,
  now = Date.now(),
) {
  const jobs = await db.all('generationJobs');
  let failures = 0;
  for (const job of jobs) {
    if (
      job.status !== 'queued' &&
      !(job.status === 'running' && (job.leaseUntil == null || job.leaseUntil <= now))
    )
      continue;
    try {
      await queue.enqueue(job.id, now);
    } catch {
      failures++;
    }
  }
  if (failures) throw Error('TASK_RECONCILIATION_FAILED');
}
