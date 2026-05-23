import {
  AwaitInputResponse,
  FeedItemResponse,
  McpResult,
  PriceResult,
  SkillResponse,
  ToolCallResponse,
  VisionResult,
} from '../types/trace';

export function formatInr(n: number): string {
  return n.toLocaleString('en-IN');
}

export function productLabel(v: VisionResult): string {
  const parts = [v.brand, v.name].filter(Boolean);
  const out = parts.join(' ').trim();
  return out || v.category || 'this product';
}

export function feedItemForAmazon(v: VisionResult, amazon: PriceResult): FeedItemResponse {
  return {
    type: 'feed_item',
    content: {
      feed_type: 'skill',
      title: `Worth It · ${productLabel(v)} · Amazon ₹${formatInr(amazon.price_inr)}`,
      story: `Amazon: ₹${formatInr(amazon.price_inr)}${amazon.url ? `\n${amazon.url}` : ''}\nChecking other retailers in background…`,
    },
  };
}

export function feedItemNoPrice(v: VisionResult): FeedItemResponse {
  return {
    type: 'feed_item',
    content: {
      feed_type: 'skill',
      title: `Worth It · ${productLabel(v)} · checking prices…`,
      story: `Saved your capture; cross-platform lookup in progress.`,
    },
  };
}

export function mailSendForAmazon(v: VisionResult, amazon: PriceResult): ToolCallResponse {
  const subject = `Worth It: ${productLabel(v)} — ₹${formatInr(amazon.price_inr)} on Amazon`;
  const body = `${amazon.url || 'Amazon.in product page'}\n\nWorth It saved this for you.\n\nCross-platform comparison may follow in a few seconds.`;
  const html = `<p>Worth It saved this for you — <strong>₹${formatInr(amazon.price_inr)} on Amazon</strong>.</p>${amazon.url ? `<p><a href='${amazon.url}'>Buy on Amazon &rarr;</a></p>` : ''}<p style="color:#888;font-size:12px;">Cross-platform comparison may follow in a few seconds.</p>`;

  return {
    type: 'tool_call',
    content: {
      tool: 'mail.send',
      params: { subject, body, html },
      on_result: 'silent',
      speak: false,
      success_message: '',
      error_message: 'Connect Gmail in Settings to receive Worth It buy links.',
    },
  };
}

export function buildHappyPathResponse(opts: {
  text: string;
  embedded: SkillResponse[];
}): McpResult {
  return {
    content: [
      { type: 'text', text: opts.text },
      { type: 'embedded_responses', responses: opts.embedded },
    ],
    state: 'completed',
  };
}

export function buildAwaitResponse(opts: {
  text?: string;
  await: AwaitInputResponse;
  feed?: FeedItemResponse;
}): McpResult {
  const embedded: SkillResponse[] = [opts.await];
  if (opts.feed) embedded.push(opts.feed);
  return {
    content: [
      ...(opts.text ? [{ type: 'text' as const, text: opts.text }] : []),
      { type: 'embedded_responses', responses: embedded },
    ],
    state: 'awaiting_input',
  };
}

export function buildErrorResponse(text: string): McpResult {
  return {
    content: [{ type: 'text', text }],
    state: 'error',
  };
}
