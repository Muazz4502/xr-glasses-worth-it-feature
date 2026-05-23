import sharp from 'sharp';
import crypto from 'crypto';
import fetch from 'node-fetch';

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 5000;
const MAX_DOWNLOAD_BYTES = parseInt(process.env.MAX_IMAGE_BYTES || '4000000', 10); // 4MB hard cap

// Sharp memory tuning — Railway free tier is ~512MB
sharp.cache({ memory: 50, files: 0, items: 100 });
sharp.concurrency(1);

export async function downloadAndResize(url: string, opts?: { maxEdge?: number; timeoutMs?: number }): Promise<Buffer> {
  const maxEdge = opts?.maxEdge ?? 1024;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal as any });
    if (!res.ok) throw new Error(`image download ${res.status}`);

    const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_DOWNLOAD_BYTES) {
      throw new Error(`image too large: ${contentLength}B > ${MAX_DOWNLOAD_BYTES}B`);
    }
    const arrayBuf = await res.arrayBuffer();
    if (arrayBuf.byteLength > MAX_DOWNLOAD_BYTES) {
      throw new Error(`image too large after download: ${arrayBuf.byteLength}B`);
    }

    const inputBuf = Buffer.from(arrayBuf);
    const resized = await sharp(inputBuf, { sequentialRead: true, limitInputPixels: 268_402_689 /* 16384x16384 */ })
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

export function memSnapshot(): string {
  const m = process.memoryUsage();
  const fmt = (n: number) => `${Math.round(n / 1024 / 1024)}MB`;
  return `rss=${fmt(m.rss)} heap=${fmt(m.heapUsed)}/${fmt(m.heapTotal)} ext=${fmt(m.external)}`;
}
