import type { Request, Response, NextFunction } from './http.ts';
export async function uploadVideo(req: Request, _res: Response, next: NextFunction) {
  try {
    if (!req.is('multipart/form-data')) throw Error();
    const request = new globalThis.Request('http://localhost', {
      method: 'POST',
      headers: { 'content-type': String(req.headers['content-type']) },
      body: new Uint8Array(req.rawBody),
    });
    const form = await request.formData();
    const entries = [...form.entries()];
    if (
      entries.length !== 1 ||
      entries[0][0] !== 'video' ||
      !(entries[0][1] instanceof File) ||
      entries[0][1].size > 50 * 1024 * 1024
    )
      throw Error();
    req.file = { buffer: Buffer.from(await entries[0][1].arrayBuffer()) };
    next();
  } catch {
    next(Object.assign(Error('INVALID_MULTIPART'), { status: 422, code: 'INVALID_MULTIPART' }));
  }
}
