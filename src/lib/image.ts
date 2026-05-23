import sharp from 'sharp';
import crypto from 'crypto';
import fetch from 'node-fetch';

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 5000;

export async function downloadAndResize(url: string, opts?: { maxEdge?: number; timeoutMs?: number }): Promise<Buffer> {
  const maxEdge = opts?.maxEdge ?? 1024;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal as any });
    if (!res.ok) throw new Error(`image download ${res.status}`);
    const arrayBuf = await res.arrayBuffer();
    const inputBuf = Buffer.from(arrayBuf);
    const resized = await sharp(inputBuf)
      .rotate()
      .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return resized;
  } finally {
    clearTimeout(t);
  }
}

export function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
