import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { PriceResult } from '../types/trace';

const AMAZON_TIMEOUT_MS = parseInt(process.env.AMAZON_TIMEOUT_MS || '6000', 10);
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Words that indicate the result is NOT the actual product (case/accessory/knockoff)
const COMPATIBILITY_PATTERN = /\b(compatible|case for|cover for|skin for|sleeve for|replacement|fits|adapter for|protector for|stand for|holder for|charger for|cable for|sticker)\b/i;
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'a', 'an', 'of', 'in', 'on', 'to', 'is',
  'inch', 'inches', 'cm', 'mm', 'gen', 'series', 'edition', 'new', 'india', 'compatible',
]);

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  );
}

function tokenOverlap(queryTokens: Set<string>, title: string): number {
  if (queryTokens.size === 0) return 0;
  const titleTokens = tokenize(title);
  let hits = 0;
  for (const t of queryTokens) if (titleTokens.has(t)) hits++;
  return hits / queryTokens.size; // [0, 1]
}

export async function scrapeAmazon(query: string): Promise<PriceResult | null> {
  const url = `https://www.amazon.in/s?k=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), AMAZON_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      signal: controller.signal as any,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'en-IN,en;q=0.9',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      },
    });
    const dur = Date.now() - t0;
    console.log(`[amazon] HTTP ${res.status} in ${dur}ms for "${query.slice(0, 40)}"`);
    if (!res.ok) {
      console.warn(`[amazon] non-200 status, returning null`);
      return null;
    }
    const html = await res.text();
    const parsed = parseAmazonHtml(html, query);
    if (!parsed) {
      console.warn(`[amazon] parser returned null (html=${html.length}B; saw 's-search-result'? ${html.includes('s-search-result')})`);
    } else {
      console.log(`[amazon] parsed → ₹${parsed.price_inr} :: ${parsed.title.slice(0, 60)}`);
    }
    return parsed;
  } catch (err: any) {
    const dur = Date.now() - t0;
    console.warn(`[amazon] failed after ${dur}ms: ${err?.message || err?.name || err}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

export function parseAmazonHtml(html: string, query: string = ''): PriceResult | null {
  const $ = cheerio.load(html);
  const queryTokens = tokenize(query);

  interface Candidate {
    title: string;
    price_inr: number;
    url?: string;
    sponsored: boolean;
    compatibilityNoise: boolean;
    score: number;
  }
  const candidates: Candidate[] = [];

  $('div[data-component-type="s-search-result"]').each((_, el) => {
    const $el = $(el);

    const title = $el.find('h2 span').first().text().trim() || $el.find('span.a-text-normal').first().text().trim();
    if (!title) return;

    const priceWhole = $el.find('span.a-price-whole').first().text().replace(/[^\d]/g, '');
    if (!priceWhole) return;
    const price_inr = parseInt(priceWhole, 10);
    if (!Number.isFinite(price_inr) || price_inr < 10) return;

    const asin = $el.attr('data-asin') || '';
    const url = asin ? `https://www.amazon.in/dp/${asin}` : undefined;

    const elText = $el.text();
    const sponsored = /Sponsored/i.test(elText) && !/result/i.test(elText.slice(0, 100));
    const compatibilityNoise = COMPATIBILITY_PATTERN.test(title);
    const overlap = tokenOverlap(queryTokens, title);

    // Score: higher = better match. Penalize sponsored + compatibility noise heavily.
    let score = overlap;
    if (sponsored) score *= 0.5;
    if (compatibilityNoise) score *= 0.3;

    candidates.push({ title, price_inr, url, sponsored, compatibilityNoise, score });
  });

  if (candidates.length === 0) return null;

  // Pick highest-scoring; require score >= 0.35 (i.e. ≥35% token overlap unless penalized down)
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  if (best.score < 0.35) {
    console.warn(`[amazon] best candidate has low score=${best.score.toFixed(2)} (title="${best.title.slice(0, 60)}") — rejecting`);
    return null;
  }

  if (best.compatibilityNoise) {
    console.warn(`[amazon] best candidate flagged as compatibility/accessory: "${best.title.slice(0, 60)}" (score=${best.score.toFixed(2)})`);
  }

  return {
    source: 'Amazon',
    title: best.title,
    price_inr: best.price_inr,
    url: best.url,
  };
}
