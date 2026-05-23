import fetch from 'node-fetch';
import { PriceResult, SkillResponse } from '../types/trace';

const BRAIN_BASE_URL = process.env.BRAIN_BASE_URL || 'https://brain.endlessriver.ai';

export interface ComparisonPushInput {
  userId: string;
  amazon: PriceResult;            // when amazonFailed=true, this is a clone of serpBest (builder convenience)
  serpBest: PriceResult;
  top3: PriceResult[];            // up to 3 cross-platform results
  deltaInr: number;               // 0 when Amazon failed or no cheaper option
  productLabel: string;
  speak: boolean;                 // true = play TTS; false = feed-only silent push
  amazonFailed: boolean;
}

function formatInr(n: number): string {
  return n.toLocaleString('en-IN');
}

function buildFeedStory(productLabel: string, top3: PriceResult[], amazon: PriceResult, amazonFailed: boolean): string {
  const lines: string[] = [`${productLabel}:`];
  if (!amazonFailed) lines.push(`Amazon ₹${formatInr(amazon.price_inr)}`);
  top3.forEach((r) => lines.push(`${r.source}: ₹${formatInr(r.price_inr)}`));
  return lines.join('\n');
}

export async function sendComparisonPush(input: ComparisonPushInput): Promise<boolean> {
  const skillId = process.env.TRACE_SKILL_ID;
  const secret = process.env.TRACE_HMAC_SECRET;
  if (!skillId || !secret) {
    console.warn('[push] skipping — TRACE_SKILL_ID or TRACE_HMAC_SECRET not set');
    return false;
  }

  const { serpBest, deltaInr, productLabel, top3, speak, amazonFailed, amazon } = input;

  // Body / TTS depend on which scenario this is.
  let title: string;
  let body: string;
  let tts: string;
  let feedTitle: string;

  if (amazonFailed) {
    title = 'Worth It';
    body = `${productLabel}: ₹${formatInr(serpBest.price_inr)} on ${serpBest.source}.`;
    tts = `Found ${productLabel} at ₹${formatInr(serpBest.price_inr)} on ${serpBest.source}.`;
    feedTitle = `${productLabel} · ₹${formatInr(serpBest.price_inr)} on ${serpBest.source}`;
  } else if (deltaInr > 0) {
    title = 'Worth It — cheaper found';
    body = `₹${formatInr(serpBest.price_inr)} on ${serpBest.source} (₹${formatInr(deltaInr)} cheaper than Amazon).`;
    tts = `Actually, ₹${formatInr(serpBest.price_inr)} on ${serpBest.source} — ₹${formatInr(deltaInr)} cheaper.`;
    feedTitle = `Cheaper found: ${serpBest.source} ₹${formatInr(serpBest.price_inr)}`;
  } else {
    title = 'Worth It — cross-platform check';
    body = `Amazon was already the best (₹${formatInr(amazon.price_inr)}).`;
    tts = '';  // not spoken
    feedTitle = `Cross-platform check · Amazon ₹${formatInr(amazon.price_inr)} best`;
  }

  const story = buildFeedStory(productLabel, top3, amazon, amazonFailed);

  const responses: SkillResponse[] = [
    {
      type: 'notification',
      content: { title, body, tts, speak, persist: false },
    },
    {
      type: 'feed_item',
      content: { feed_type: 'skill', title: feedTitle, story },
    },
  ];

  const url = `${BRAIN_BASE_URL}/api/skill-push/${skillId}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({ user_id: input.userId, responses }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`[push] ${res.status}: ${text.slice(0, 200)}`);
      return false;
    }
    console.log(`[push] delivered ok (speak=${speak}, top3=${top3.length})`);
    return true;
  } catch (err) {
    console.error('[push] failed', err);
    return false;
  }
}
