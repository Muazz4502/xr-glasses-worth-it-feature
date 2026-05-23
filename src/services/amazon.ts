import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { PriceResult } from '../types/trace';

const AMAZON_TIMEOUT_MS = parseInt(process.env.AMAZON_TIMEOUT_MS || '2500', 10);
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export async function scrapeAmazon(query: string): Promise<PriceResult | null> {
  const url = `https://www.amazon.in/s?k=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), AMAZON_TIMEOUT_MS);
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
    if (!res.ok) return null;
    const html = await res.text();
    return parseAmazonHtml(html);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export function parseAmazonHtml(html: string): PriceResult | null {
  const $ = cheerio.load(html);
  const candidates: Array<{ title: string; price_inr: number; url?: string; sponsored: boolean }> = [];

  $('div[data-component-type="s-search-result"]').each((_, el) => {
    const $el = $(el);

    const title = $el.find('h2 span').first().text().trim() || $el.find('span.a-text-normal').first().text().trim();
    if (!title) return;

    const priceWhole = $el.find('span.a-price-whole').first().text().replace(/[^\d]/g, '');
    const priceFrac = $el.find('span.a-price-fraction').first().text().replace(/[^\d]/g, '');
    if (!priceWhole) return;
    const price_inr = parseInt(priceWhole, 10);
    if (!Number.isFinite(price_inr) || price_inr < 10) return;

    const asin = $el.attr('data-asin') || '';
    const url = asin ? `https://www.amazon.in/dp/${asin}` : undefined;

    const sponsoredText = $el.text();
    const sponsored = /Sponsored/i.test(sponsoredText) && !/result/i.test(sponsoredText.slice(0, 100));

    candidates.push({ title, price_inr, url, sponsored });
  });

  if (candidates.length === 0) return null;

  // Prefer first non-sponsored, fall back to first
  const best = candidates.find((c) => !c.sponsored) || candidates[0];

  return {
    source: 'Amazon',
    title: best.title,
    price_inr: best.price_inr,
    url: best.url,
  };
}
