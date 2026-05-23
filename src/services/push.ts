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
  const tts = `Actually, ₹${formatInr(serpBest.price_inr)} on ${serpBest.source} — ₹${formatInr(deltaInr)} cheaper.`;
  const responses: SkillResponse[] = [
    {
      type: 'notification',
      content: {
        title: 'Worth It — cheaper found',
        body: `₹${formatInr(serpBest.price_inr)} on ${serpBest.source} (₹${formatInr(deltaInr)} cheaper than Amazon).`,
        tts,
        speak: true,
        persist: false,
      },
    },
    {
      type: 'feed_item',
      content: {
        feed_type: 'skill',
        title: `Cheaper found: ${serpBest.source} ₹${formatInr(serpBest.price_inr)}`,
        story: `${productLabel}: ₹${formatInr(serpBest.price_inr)} on ${serpBest.source}, saving ₹${formatInr(deltaInr)} vs Amazon.`,
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
