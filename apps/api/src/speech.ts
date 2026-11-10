import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoogleAuth } from 'google-auth-library';
const exec = promisify(execFile);

// Audio is only ever handled in memory or in a per-request temporary directory that is
// removed in `finally`; it is never written to Storage, Firestore or logs.
export const maxSpeechAudioBytes = 5 * 1024 * 1024;
export const minSpeechAudioMs = 5000;
export const maxSpeechAudioMs = 60000;
const sampleRate = 16000;
const bytesPerSample = 2;
// 61 seconds of 16 kHz mono 16-bit PCM plus headers: ffmpeg is asked for at most 61
// seconds, so anything larger means the output is unusable.
const maxNormalizedBytes = sampleRate * bytesPerSample * (maxSpeechAudioMs / 1000 + 1) + 4096;
// Ask ffmpeg for at most 61 seconds so an over-long input cannot inflate the result.
const ffmpegSeconds = String(maxSpeechAudioMs / 1000 + 1);

function wavChunks(wav: Buffer) {
  if (
    wav.length < 44 ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 12) !== 'WAVE'
  )
    throw Error('INVALID_AUDIO');
  const chunks = new Map<string, number>();
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString('ascii', offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    chunks.set(chunkId, offset);
    // A placeholder size (pipe output) means this is the final chunk.
    if (chunkSize === 0xffffffff) break;
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  return chunks;
}

function wavDataLength(wav: Buffer): number {
  const data = wavChunks(wav).get('data');
  if (data === undefined) throw Error('INVALID_AUDIO');
  const declared = wav.readUInt32LE(data + 4);
  // ffmpeg cannot seek on a pipe, so it writes 0xFFFFFFFF placeholders; the actual
  // payload is whatever follows the chunk header.
  const size = declared === 0xffffffff ? wav.length - data - 8 : declared;
  if (size === 0 || size > wav.length - data - 8 || size % bytesPerSample !== 0)
    throw Error('INVALID_AUDIO');
  return size;
}

// Measure the source before conversion so a 60.0–60.5 s input cannot slip through
// truncated by ffmpeg. An unreadable duration falls back to the converted-length check.
async function sourceDurationMs(input: string): Promise<number | undefined> {
  try {
    const { stdout } = await exec(
      'ffprobe',
      ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', input],
      { timeout: 10000, maxBuffer: 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout);
    const durations = [
      Number(parsed?.format?.duration),
      ...(Array.isArray(parsed?.streams)
        ? parsed.streams.map((s: any) => Number(s?.duration))
        : []),
    ].filter((value) => Number.isFinite(value) && value > 0);
    return durations.length ? Math.max(...durations) * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export async function normalizeSpeechAudio(bytes: Buffer): Promise<Buffer> {
  if (!bytes.length) throw Error('INVALID_AUDIO');
  if (bytes.length > maxSpeechAudioBytes) throw Error('AUDIO_TOO_LARGE');
  const dir = await mkdtemp(join(tmpdir(), 't055-speech-'));
  try {
    const input = join(dir, 'input');
    await writeFile(input, bytes);
    const sourceMs = await sourceDurationMs(input);
    if (sourceMs !== undefined && sourceMs > maxSpeechAudioMs) throw Error('AUDIO_TOO_LONG');
    let wav: Buffer;
    try {
      const { stdout } = await exec(
        'ffmpeg',
        [
          '-v',
          'error',
          '-i',
          input,
          '-t',
          ffmpegSeconds,
          '-ac',
          '1',
          '-ar',
          String(sampleRate),
          '-f',
          'wav',
          '-acodec',
          'pcm_s16le',
          'pipe:1',
        ],
        { timeout: 20000, maxBuffer: maxNormalizedBytes, encoding: 'buffer' },
      );
      wav = Buffer.from(stdout);
    } catch {
      // ffmpeg reports undecodable input on stderr; never surface it (it may echo the audio).
      throw Error('INVALID_AUDIO');
    }
    if (wav.length > maxNormalizedBytes) throw Error('AUDIO_TOO_LONG');
    const durationMs = (wavDataLength(wav) / bytesPerSample / sampleRate) * 1000;
    if (durationMs < minSpeechAudioMs) throw Error('AUDIO_TOO_SHORT');
    if (durationMs > maxSpeechAudioMs) throw Error('AUDIO_TOO_LONG');
    return wav;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface SpeechTranscriber {
  transcribe(wav: Buffer): Promise<string>;
}

export const fakeTranscript = 'はしがそろわず、赤い線に合わせる声かけをした';
export class FakeSpeechTranscriber implements SpeechTranscriber {
  async transcribe(wav: Buffer): Promise<string> {
    if (!wav.length) throw Error('INVALID_AUDIO');
    return fakeTranscript;
  }
}

type SpeechRequestOptions = {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  data: string;
  timeout: number;
};
export type SpeechTransport = {
  request(options: SpeechRequestOptions): Promise<{ data: unknown }>;
};
class GoogleAuthSpeechTransport implements SpeechTransport {
  private auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  async request(options: SpeechRequestOptions) {
    const client = await this.auth.getClient();
    return client.request(options);
  }
}

const maxTranscriptLength = 2000;

function transcriptFrom(data: unknown): string {
  const results = (data as { results?: unknown })?.results;
  if (results === undefined) return '';
  if (!Array.isArray(results)) throw Error('SPEECH_REQUEST_FAILED');
  const parts: string[] = [];
  for (const result of results) {
    const alternatives = (result as { alternatives?: unknown })?.alternatives;
    if (!Array.isArray(alternatives)) throw Error('SPEECH_REQUEST_FAILED');
    const transcript = (alternatives[0] as { transcript?: unknown } | undefined)?.transcript;
    if (transcript === undefined) continue;
    if (typeof transcript !== 'string') throw Error('SPEECH_REQUEST_FAILED');
    parts.push(transcript);
  }
  return parts.join('');
}

export class GoogleSpeechTranscriber implements SpeechTranscriber {
  private transport: SpeechTransport;
  private project?: string;
  private location?: string;
  private model: string;
  private language: string;
  private recognizer: string;
  constructor(
    env: NodeJS.ProcessEnv,
    transport?: SpeechTransport,
    private timeoutMs = 30000,
  ) {
    this.project = env.GOOGLE_CLOUD_PROJECT?.trim() || undefined;
    this.location = env.SPEECH_LOCATION?.trim() || undefined;
    this.model = env.SPEECH_MODEL?.trim() || 'chirp_3';
    this.language = env.SPEECH_LANGUAGE?.trim() || 'ja-JP';
    this.recognizer = env.SPEECH_RECOGNIZER?.trim() || '_';
    this.transport = transport ?? new GoogleAuthSpeechTransport();
  }
  private url() {
    if (!this.project || !this.location) throw Error('SPEECH_NOT_CONFIGURED');
    // chirp_3 is only generally available in the `us` and `eu` multi-regions.
    if (!['us', 'eu'].includes(this.location)) throw Error('SPEECH_INVALID_CONFIG');
    if (
      !/^[a-zA-Z0-9_-]+$/.test(this.project) ||
      !/^[a-zA-Z0-9_-]+$/.test(this.model) ||
      !/^[a-zA-Z0-9-]+$/.test(this.language) ||
      !/^[a-zA-Z0-9_-]+$/.test(this.recognizer)
    )
      throw Error('SPEECH_INVALID_CONFIG');
    return `https://${this.location}-speech.googleapis.com/v2/projects/${this.project}/locations/${this.location}/recognizers/${this.recognizer}:recognize`;
  }
  async transcribe(wav: Buffer): Promise<string> {
    if (!wav.length) throw Error('INVALID_AUDIO');
    const url = this.url();
    let data: unknown;
    try {
      ({ data } = await this.transport.request({
        url,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        data: JSON.stringify({
          config: {
            autoDecodingConfig: {},
            languageCodes: [this.language],
            model: this.model,
          },
          content: wav.toString('base64'),
        }),
        timeout: this.timeoutMs,
      }));
    } catch {
      // Provider errors can echo the request; keep the cause out of the message.
      throw Error('SPEECH_REQUEST_FAILED');
    }
    const transcript = transcriptFrom(data);
    if (!transcript.trim()) throw Error('SPEECH_NO_TRANSCRIPT');
    if (Array.from(transcript).length > maxTranscriptLength)
      throw Error('SPEECH_TRANSCRIPT_TOO_LONG');
    return transcript;
  }
}

export function createSpeechTranscriber(
  env: NodeJS.ProcessEnv,
  request?: SpeechTransport,
): SpeechTranscriber {
  switch (env.SPEECH_PROVIDER ?? 'fake') {
    case 'fake':
      return new FakeSpeechTranscriber();
    case 'vertex':
    case 'google':
      return new GoogleSpeechTranscriber(env, request);
    default:
      throw Error('INVALID_SPEECH_PROVIDER');
  }
}

export function configuredSpeech(env = process.env): SpeechTranscriber {
  return createSpeechTranscriber(env);
}
