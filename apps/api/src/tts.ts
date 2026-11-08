import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const exec = promisify(execFile);
export type TtsAudio = { bytes: Buffer; mimeType: 'audio/wav'; durationMs: number };
// Only the short sentence selected and verified by staff at approval may enter this port.
export interface TtsAdapter {
    synthesize(approvedText: string): Promise<TtsAudio>;
}
export class FakeTtsAdapter implements TtsAdapter {
    async synthesize(approvedText: string): Promise<TtsAudio> {
        const durationMs = Math.max(500, Array.from(approvedText).length * 150);
        const dir = await mkdtemp(join(tmpdir(), 't055-tts-'));
        try {
            const output = join(dir, 'placeholder.wav');
            await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', String(durationMs / 1000), '-c:a', 'pcm_s16le', '-y', output], { timeout: 10000 });
            return { bytes: await readFile(output), mimeType: 'audio/wav', durationMs };
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    }
}
// The transport receives only the approved sentence; no profile or staff notes are sent.
export type VertexTtsTransport = (input: { model: string; text: string }) => Promise<TtsAudio>;
type VertexClient = { models: { generateContent(input: import('@google/genai').GenerateContentParameters): Promise<unknown> } };
type VertexClientFactory = (config: { project: string; location: string }) => Promise<VertexClient>;
const sampleRate = 24000;
const maxPcmBytes = sampleRate * 2 * 30;

function pcmToWav(response: unknown): TtsAudio {
    const result = response as { candidates?: { finishReason?: string; content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] } }[] };
    const candidates = result?.candidates;
    if (!Array.isArray(candidates) || candidates.length !== 1 || (candidates[0].finishReason && candidates[0].finishReason !== 'STOP')) throw Error('VERTEX_TTS_INVALID_RESPONSE');
    const parts = candidates[0].content?.parts;
    if (!Array.isArray(parts) || parts.length !== 1) throw Error('VERTEX_TTS_INVALID_RESPONSE');
    const { mimeType, data } = parts[0].inlineData ?? {};
    if (typeof mimeType !== 'string' || typeof data !== 'string') throw Error('VERTEX_TTS_INVALID_RESPONSE');
    const [mime, ...parameters] = mimeType.toLowerCase().split(';').map(part => part.trim());
    if (mime !== 'audio/l16') throw Error('VERTEX_TTS_INVALID_FORMAT');
    for (const parameter of parameters) {
        if (!['rate=24000', 'codec=pcm', 'channels=1'].includes(parameter.replace(/\s/g, ''))) throw Error('VERTEX_TTS_INVALID_FORMAT');
    }
    if (!data || data.length > Math.ceil(maxPcmBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw Error('VERTEX_TTS_INVALID_AUDIO');
    const pcm = Buffer.from(data, 'base64');
    if (!pcm.length || pcm.length > maxPcmBytes || pcm.length % 2 !== 0 || pcm.subarray(0, 4).toString('ascii') === 'RIFF') throw Error('VERTEX_TTS_INVALID_AUDIO');
    const header = Buffer.alloc(44);
    header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
    return { bytes: Buffer.concat([header, pcm]), mimeType: 'audio/wav', durationMs: pcm.length / 2 / sampleRate * 1000 };
}

export function createVertexTtsTransport(env: NodeJS.ProcessEnv, createClient: VertexClientFactory = async ({ project, location }) => {
    const { GoogleGenAI } = await import('@google/genai').catch(() => { throw Error('VERTEX_TTS_SDK_UNAVAILABLE'); });
    return new GoogleGenAI({ vertexai: true, project, location });
}): VertexTtsTransport {
    const project = env.GOOGLE_CLOUD_PROJECT?.trim(), location = env.TTS_LOCATION?.trim(), voice = env.TTS_VOICE?.trim() || 'Kore';
    return async ({ model, text }) => {
        if (!project || !location) throw Error('VERTEX_TTS_NOT_CONFIGURED');
        if (!['gemini-2.5-flash-tts', 'gemini-2.5-pro-tts'].includes(model) || !/^[a-zA-Z0-9-]+$/.test(location) || !/^[a-zA-Z]+$/.test(voice)) throw Error('VERTEX_TTS_INVALID_CONFIG');
        const client = await createClient({ project, location });
        const response = await client.models.generateContent({ model, contents: text, config: {
            httpOptions: { timeout: 30000 }, responseModalities: ['AUDIO'], speechConfig: { languageCode: 'ja-JP', voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
        } });
        return pcmToWav(response);
    };
}
export class VertexTtsAdapter implements TtsAdapter {
    constructor(readonly model = 'gemini-2.5-flash-tts', private transport?: VertexTtsTransport) {}
    async synthesize(approvedText: string): Promise<TtsAudio> {
        if (!approvedText.trim() || Array.from(approvedText).length > 40) throw Error('INVALID_TTS_TEXT');
        if (!this.transport) throw Error('VERTEX_TTS_NOT_CONFIGURED');
        return this.transport({ model: this.model, text: approvedText });
    }
}
export function configuredTts(env = process.env): TtsAdapter {
    switch (env.TTS_PROVIDER ?? 'fake') {
        case 'fake': return new FakeTtsAdapter();
        case 'vertex': return new VertexTtsAdapter(env.TTS_MODEL ?? 'gemini-2.5-flash-tts', createVertexTtsTransport(env));
        default: throw Error('INVALID_TTS_PROVIDER');
    }
}
