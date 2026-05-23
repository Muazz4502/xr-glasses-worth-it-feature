import { LRUCache } from 'lru-cache';
import { PriceResult } from '../types/trace';

const CACHE_TTL_MS = parseInt(process.env.SERP_CACHE_TTL_MS || `${1000 * 60 * 60 * 24}`, 10);
const CACHE_MAX = parseInt(process.env.SERP_CACHE_MAX || '500', 10);

export const serpCache = new LRUCache<string, PriceResult[]>({
  max: CACHE_MAX,
  ttl: CACHE_TTL_MS,
});

export function normalizeQueryKey(q: string): string {
  return q.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
