import { GoogleAuth } from 'google-auth-library';
import { Readable } from 'node:stream';
import type { CloudStorageClient } from './cloud-storage.ts';

type RequestOptions = {
  url: string;
  method: 'GET' | 'POST';
  responseType: 'json' | 'stream';
  headers?: Record<string, string>;
  data?: Buffer | Record<string, never>;
};
export interface StorageTransport {
  request(options: RequestOptions): Promise<{ data: unknown }>;
}

// Use the JSON API directly: generation numbers must never pass through a JS number.
export class GoogleStorageClient implements CloudStorageClient {
  private transport: StorageTransport;
  constructor(projectId: string, transport?: StorageTransport) {
    this.transport =
      transport ??
      new GoogleAuth({
        projectId,
        scopes: ['https://www.googleapis.com/auth/devstorage.read_write'],
      });
  }
  private url(path: string, params: Record<string, string>) {
    return `https://storage.googleapis.com${path}?${new URLSearchParams(params)}`;
  }
  private async request(options: RequestOptions) {
    try {
      return (await this.transport.request(options)).data;
    } catch {
      throw Error('CLOUD_STORAGE_REQUEST_FAILED');
    }
  }
  private generation(data: unknown) {
    if (
      !data ||
      typeof data !== 'object' ||
      !('generation' in data) ||
      typeof data.generation !== 'string' ||
      !/^[1-9][0-9]*$/.test(data.generation)
    )
      throw Error('INVALID_STORAGE_GENERATION_RESPONSE');
    return data.generation;
  }
  async put(bucket: string, path: string, bytes: Buffer, options: { ifGenerationMatch: '0' }) {
    const url = this.url(`/upload/storage/v1/b/${encodeURIComponent(bucket)}/o`, {
      uploadType: 'media',
      name: path,
      ifGenerationMatch: options.ifGenerationMatch,
    });
    return this.generation(
      await this.request({
        url,
        method: 'POST',
        responseType: 'json',
        headers: { 'content-type': 'application/octet-stream' },
        data: bytes,
      }),
    );
  }
  async open(bucket: string, path: string, options: { ifGenerationMatch: string }) {
    const url = this.url(
      `/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(path)}`,
      {
        alt: 'media',
        ifGenerationMatch: options.ifGenerationMatch,
      },
    );
    const data = await this.request({ url, method: 'GET', responseType: 'stream' });
    if (data instanceof Readable) return Readable.toWeb(data) as ReadableStream<Uint8Array>;
    if (data instanceof ReadableStream) return data as ReadableStream<Uint8Array>;
    throw Error('INVALID_STORAGE_STREAM_RESPONSE');
  }
  async copy(
    bucket: string,
    from: string,
    to: string,
    options: { ifSourceGenerationMatch: string; ifGenerationMatch: '0' },
  ) {
    const b = encodeURIComponent(bucket);
    const url = this.url(
      `/storage/v1/b/${b}/o/${encodeURIComponent(from)}/copyTo/b/${b}/o/${encodeURIComponent(to)}`,
      options,
    );
    return this.generation(
      await this.request({ url, method: 'POST', responseType: 'json', data: {} }),
    );
  }
}
