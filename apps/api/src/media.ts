import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const exec = promisify(execFile);
export async function media(
  bytes: Buffer,
  frameMs?: number,
): Promise<{
  durationMs: number;
  image?: Buffer;
}> {
  const dir = await mkdtemp(join(tmpdir(), 't055-'));
  try {
    const input = join(dir, 'input.mp4');
    await writeFile(input, bytes);
    const { stdout } = await exec(
      'ffprobe',
      ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', input],
      { timeout: 10000, maxBuffer: 1024 * 1024 },
    );
    const p = JSON.parse(stdout);
    const durationMs = Math.floor(Number(p.format.duration) * 1000);
    if (
      !/^(isom|iso[2-9]|mp4[12]|avc1|dash|M4V )$/.test(p.format.tags?.major_brand ?? '') ||
      !p.format.format_name?.includes('mp4') ||
      !p.streams.some((s: any) => s.codec_type === 'video') ||
      !p.streams.some((s: any) => s.codec_type === 'audio') ||
      !Number.isFinite(durationMs) ||
      durationMs <= 0 ||
      durationMs > 180000
    )
      throw Error('INVALID_VIDEO');
    if (frameMs === undefined) return { durationMs };
    if (!Number.isInteger(frameMs) || frameMs < 0 || frameMs > durationMs)
      throw Error('INVALID_FRAME');
    const output = join(dir, 'frame.jpg');
    async function extract(startMs: number) {
      // Keep the last decoded frame at/before the requested time, including EOF.
      await exec(
        'ffmpeg',
        [
          '-v',
          'error',
          '-ss',
          String(startMs / 1000),
          '-i',
          input,
          '-t',
          String((frameMs! - startMs + 1) / 1000),
          '-an',
          '-vf',
          'scale=960:-2',
          '-fps_mode',
          'passthrough',
          '-update',
          '1',
          '-y',
          output,
        ],
        { timeout: 10000, maxBuffer: 1024 * 1024 },
      );
      return readFile(output);
    }
    let image: Buffer;
    try {
      image = await extract(Math.max(0, frameMs - 1000));
    } catch {
      image = await extract(0);
    }
    return { durationMs, image };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
