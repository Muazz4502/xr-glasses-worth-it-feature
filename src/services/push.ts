import fetch from 'node-fetch';
import { PriceResult, SkillResponse } from '../types/trace';

const BRAIN_BASE_URL = process.env.BRAIN_BASE_URL || 'https://brain.endlessriver.ai';

export interface ComparisonPushInput {
  userId: string;
  amazon: PriceResult;
  serpBest: PriceResult;
  deltaInr: number;
  productLabel: string;
}

export async function sendComparisonPush(input: ComparisonPushInput): Promise<boolean> {
  const skillId = process.env.TRACE_SKILL_ID;
  const secret = process.env.TRACE_HMAC_SECRET;
  if (!skillId || !secret) {
    console.warn('[push] skipping — TRACE_SKILL_ID or TRACE_HMAC_SECRET not set');
    return false;
  }

  const { serpBest, deltaInr, productLabel } = input;
  // Amazon-failed fallback path: deltaInr is 0 and "amazon" was a clone of serpBest.
  const isFallback = deltaInr === 0;
  const tts = isFallback
    ? `Found ${productLabel} at ₹${formatInr(serpBest.price_inr)} on ${serpBest.source}.`
    : `Actually, ₹${formatInr(serpBest.price_inr)} on ${serpBest.source} — ₹${formatInr(deltaInr)} cheaper.`;
  const body = isFallback
    ? `₹${formatInr(serpBest.price_inr)} on ${serpBest.source}.`
    : `₹${formatInr(serpBest.price_inr)} on ${serpBest.source} (₹${formatInr(deltaInr)} cheaper than Amazon).`;
  const feedTitle = isFallback
    ? `${productLabel} · ₹${formatInr(serpBest.price_inr)} on ${serpBest.source}`
    : `Cheaper found: ${serpBest.source} ₹${formatInr(serpBest.price_inr)}`;
  const feedStory = isFallback
    ? `${productLabel}: ₹${formatInr(serpBest.price_inr)} on ${serpBest.source}.`
    : `${productLabel}: ₹${formatInr(serpBest.price_inr)} on ${serpBest.source}, saving ₹${formatInr(deltaInr)} vs Amazon.`;

  const responses: SkillResponse[] = [
    {
      type: 'notification',
      content: {
        title: isFallback ? 'Worth It' : 'Worth It — cheaper found',
        body,
        tts,
        speak: true,
        persist: false,
      },
    },
    {
      type: 'feed_item',
      content: {
        feed_type: 'skill',
        title: feedTitle,
        story: feedStory,
      },
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
    return true;
  } catch (err) {
    console.error('[push] failed', err);
    return false;
  }
}

function formatInr(n: number): string {
  return n.toLocaleString('en-IN');
}
