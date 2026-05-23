import fetch from 'node-fetch';
import { PriceResult } from '../types/trace';
import { serpCache, normalizeQueryKey } from '../lib/cache';

const SERPAPI_TIMEOUT_MS = parseInt(process.env.SERPAPI_TIMEOUT_MS || '30000', 10);

export async function searchSerpapi(query: string): Promise<PriceResult[]> {
  const cacheKey = normalizeQueryKey(query);
  const cached = serpCache.get(cacheKey);
  if (cached) return cached;

  const params = new URLSearchParams({
    engine: 'google_shopping',
    q: query,
    gl: 'in',
    hl: 'en',
    api_key: process.env.SERPAPI_KEY || '',
  });
  const url = `https://serpapi.com/search.json?${params.toString()}`;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), SERPAPI_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal as any });
    if (!res.ok) return [];
    const data = (await res.json()) as any;
    const raw: any[] = data?.shopping_results || [];

    const normalized: PriceResult[] = raw
      .map((r) => {
        const priceStr = String(r.price || '');
        const digits = priceStr.replace(/[^\d]/g, '');
        const price_inr = digits ? parseInt(digits, 10) : NaN;
        return {
          source: String(r.source || ''),
          title: String(r.title || ''),
          price_inr,
          url: r.product_link || r.link || undefined,
          rating: typeof r.rating === 'number' ? r.rating : undefined,
        };
      })
      .filter((r) => Number.isFinite(r.price_inr) && r.price_inr > 50)
      .sort((a, b) => a.price_inr - b.price_inr);

    serpCache.set(cacheKey, normalized);
    return normalized;
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}
