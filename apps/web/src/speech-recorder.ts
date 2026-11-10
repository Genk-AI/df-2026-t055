// 支援記録の音声入力の録音・変換だけを行う。文字起こしの送信と、記録への反映は
// support-record.tsx が行う。音声はメモリ上で扱い、Storage・localStorage・
// sessionStorage・ログへは書かない。

export const MAX_RECORDING_MS = 60_000;
export const MIN_RECORDING_MS = 5_000;
export const TARGET_SAMPLE_RATE = 16_000;
export const MAX_WAV_BYTES = 5 * 1024 * 1024;
const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];

type AudioContextLike = {
  sampleRate: number;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike>;
  close?: () => Promise<void>;
};
type AudioBufferLike = {
  duration: number;
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  getChannelData(channel: number): Float32Array;
};

export interface Recording {
  /** 録音を停止し、生の音声 Blob を返す。停止済みなら同じ Promise を返す。 */
  stop(): Promise<Blob>;
  /** 録音を破棄する。マイクを解放し、音声は保持しない。 */
  cancel(): void;
}

function fail(code: string) {
  return Object.assign(Error(code), { code });
}

function browser(): {
  mediaDevices?: { getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream> };
  MediaRecorder?: typeof MediaRecorder;
  AudioContext?: new () => AudioContextLike;
  webkitAudioContext?: new () => AudioContextLike;
} {
  return globalThis as unknown as {
    mediaDevices?: { getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream> };
    MediaRecorder?: typeof MediaRecorder;
    AudioContext?: new () => AudioContextLike;
    webkitAudioContext?: new () => AudioContextLike;
  };
}

function pickMimeType(Recorder: typeof MediaRecorder): string {
  for (const type of MIME_TYPES) {
    if (typeof Recorder.isTypeSupported !== 'function' || Recorder.isTypeSupported(type))
      return type;
  }
  return '';
}

/**
 * マイクの録音を開始する。非対応の環境では例外で落とさず `RECORDING_UNSUPPORTED` を投げる。
 * 録音開始から 60 秒で自動停止する。停止・破棄のどちらでも `track.stop()` でマイクを解放する。
 */
export async function startRecording(): Promise<Recording> {
  const env = browser();
  const getUserMedia = env.mediaDevices?.getUserMedia;
  const Recorder = env.MediaRecorder;
  if (typeof getUserMedia !== 'function' || typeof Recorder !== 'function')
    throw fail('RECORDING_UNSUPPORTED');
  let stream: MediaStream;
  try {
    stream = await getUserMedia.call(env.mediaDevices, { audio: true });
  } catch (e) {
    // マイク許可の拒否は呼び出し側が理由を出し分けられるよう、名前を保ったまま伝える。
    if ((e as { name?: string }).name === 'NotAllowedError') throw e;
    throw fail('RECORDING_FAILED');
  }
  const tracks = stream.getTracks?.() ?? [];
  const release = () => {
    for (const track of tracks) track.stop();
  };
  let recorder: MediaRecorder;
  try {
    const mimeType = pickMimeType(Recorder);
    recorder = mimeType ? new Recorder(stream, { mimeType }) : new Recorder(stream);
  } catch {
    release();
    throw fail('RECORDING_UNSUPPORTED');
  }
  const chunks: Blob[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled: Promise<Blob> | undefined;
  let resolveStop: ((blob: Blob) => void) | undefined;
  let rejectStop: ((error: Error) => void) | undefined;
  const finish = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    release();
  };
  recorder.addEventListener('dataavailable', (event: BlobEvent) => {
    if (event.data && event.data.size) chunks.push(event.data);
  });
  recorder.addEventListener('error', () => {
    finish();
    rejectStop?.(fail('RECORDING_FAILED'));
  });
  recorder.addEventListener('stop', () => {
    finish();
    const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
    chunks.length = 0;
    resolveStop?.(blob);
  });
  const stop = () => {
    if (!settled)
      settled = new Promise<Blob>((resolve, reject) => {
        resolveStop = resolve;
        rejectStop = reject;
      });
    if (recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        finish();
        rejectStop?.(fail('RECORDING_FAILED'));
      }
    }
    return settled;
  };
  try {
    recorder.start();
  } catch {
    release();
    throw fail('RECORDING_UNSUPPORTED');
  }
  timer = setTimeout(() => void stop(), MAX_RECORDING_MS);
  return {
    stop,
    cancel() {
      if (recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          // 破棄時は結果を使わないので、停止の失敗は無視してマイクだけ解放する。
        }
      }
      finish();
      chunks.length = 0;
    },
  };
}

function writeString(view: DataView, offset: number, value: string) {
  for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
}

/** 16kHz・16bit・モノラルの WAV を組み立てる。 */
export function wavFromSamples(samples: Float32Array, sampleRate = TARGET_SAMPLE_RATE): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/** チャンネル平均でモノラル化し、単純な線形補間で 16kHz へ変換する。 */
export function toMono16k(audio: AudioBufferLike): Float32Array {
  const channels = audio.numberOfChannels || 1;
  const mono = new Float32Array(audio.length);
  for (let channel = 0; channel < channels; channel++) {
    const data = audio.getChannelData(channel);
    for (let i = 0; i < mono.length; i++) mono[i] += (data[i] ?? 0) / channels;
  }
  const sourceRate = audio.sampleRate || TARGET_SAMPLE_RATE;
  if (sourceRate === TARGET_SAMPLE_RATE) return mono;
  const ratio = sourceRate / TARGET_SAMPLE_RATE;
  const length = Math.max(1, Math.floor(mono.length / ratio));
  const resampled = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const position = i * ratio;
    const before = Math.floor(position);
    const after = Math.min(before + 1, mono.length - 1);
    const weight = position - before;
    resampled[i] = (mono[before] ?? 0) * (1 - weight) + (mono[after] ?? 0) * weight;
  }
  return resampled;
}

/**
 * 録音した音声を 16kHz・16bit・モノラルの WAV へ変換する。
 * デコードできない場合は `DECODE_FAILED`、5秒未満は `AUDIO_TOO_SHORT`、
 * 5MB を超える場合は `AUDIO_TOO_LARGE` を投げる。
 */
export async function encodeWav(blob: Blob): Promise<Blob> {
  const env = browser();
  const Context = env.AudioContext ?? env.webkitAudioContext;
  if (typeof Context !== 'function' || typeof blob.arrayBuffer !== 'function')
    throw fail('DECODE_FAILED');
  const context = new Context();
  let audio: AudioBufferLike;
  try {
    audio = await context.decodeAudioData(await blob.arrayBuffer());
  } catch {
    throw fail('DECODE_FAILED');
  } finally {
    // 変換後はデコーダを閉じ、音声データを保持し続けない。
    await context.close?.().catch(() => {});
  }
  if (audio.duration * 1000 < MIN_RECORDING_MS) throw fail('AUDIO_TOO_SHORT');
  const wav = wavFromSamples(toMono16k(audio));
  if (wav.size > MAX_WAV_BYTES) throw fail('AUDIO_TOO_LARGE');
  return wav;
}
