import { v4 as uuid } from 'uuid';
import { ToolInput, McpResult, VisionResult, SkillResponse, AwaitInputResponse } from '../types/trace';
import { downloadAndResize, sha256 } from '../lib/image';
import { callVision } from '../services/vision';
import { scrapeAmazon } from '../services/amazon';
import { searchSerpapi } from '../services/serpapi';
import { sendComparisonPush } from '../services/push';
import {
  findIdempotency,
  upsertIdempotency,
  insertComparison,
  updateAmazon,
  updateSerp,
  markPushSent,
  setStatus,
  getComparison,
  findRecentPhotoForUser,
  markPhotoConsumed,
} from '../services/db';
import {
  buildAwaitResponse,
  buildErrorResponse,
  buildHappyPathResponse,
  feedItemForAmazon,
  feedItemNoPrice,
  formatInr,
  mailSendForAmazon,
  productLabel,
} from '../lib/responses';

const IDEMPOTENCY_WINDOW_MS = parseInt(process.env.IDEMPOTENCY_WINDOW_MS || '60000', 10);
const PUSH_DELTA_INR_MIN = parseInt(process.env.PUSH_DELTA_INR_MIN || '50', 10);
const PUSH_DELTA_PCT_MIN = parseFloat(process.env.PUSH_DELTA_PCT_MIN || '0.03');
const VISION_CONFIDENCE_THRESHOLD = parseFloat(process.env.VISION_CONFIDENCE_THRESHOLD || '0.45');
// Reject SerpAPI results priced below this fraction of Amazon's price — almost
// certainly a different/refurb/accessory product, not the same SKU.
const PUSH_MIN_RATIO_VS_AMAZON = parseFloat(process.env.PUSH_MIN_RATIO_VS_AMAZON || '0.5');

export async function handleDialog(input: ToolInput): Promise<McpResult> {
  // DEBUG: dump full input so we can see why image isn't arriving
  console.log('[mcp DEBUG] input keys:', Object.keys(input));
  console.log('[mcp DEBUG] utterance:', JSON.stringify(input.utterance));
  console.log('[mcp DEBUG] context:', JSON.stringify(input.context));
  console.log('[mcp DEBUG] items:', JSON.stringify(input.items));
  console.log('[mcp DEBUG] user keys:', input.user ? Object.keys(input.user) : 'no user');
  console.log('[mcp DEBUG] pending_context:', JSON.stringify(input.pending_context));

  // 1. Barcode-fallback follow-up?
  if (input.pending_context?.context_key === 'barcode_fallback') {
    return handleBarcodeFollowup(input);
  }

  // 2. Find an image — first in this dispatch, then proximity-link from a recent media.photo
  let imageItem = (input.items || []).find((i) => {
    if (i.mimeType?.startsWith('image/')) return true;
    if (i.url && /\.(jpe?g|png|webp|heic|heif)(\?|$)/i.test(i.url)) return true;
    return false;
  });
  let usedRecentPhoto: { photo_id: string; image_url: string } | null = null;
  if (!imageItem) {
    // Proximity link: was there a recent front-button photo from this user (within 5 min)?
    const recent = findRecentPhotoForUser(input.userId, 5 * 60 * 1000);
    if (recent) {
      console.log(`[mcp] proximity-linking recent photo ${recent.photo_id} (captured ${Math.round((Date.now()-recent.captured_at)/1000)}s ago)`);
      imageItem = { id: recent.photo_id, url: recent.image_url, mimeType: 'image/jpeg' };
      usedRecentPhoto = { photo_id: recent.photo_id, image_url: recent.image_url };
    }
  }
  if (!imageItem) {
    console.log('[mcp DEBUG] → no image found and no recent photo cached, returning await_input');
    return buildAwaitResponse({
      text: 'Press the front button to snap the product, then ask again.',
      await: {
        type: 'await_input',
        content: {
          question: 'Press the front button to capture, or look at the product and ask again.',
          context_key: 'no_image',
          allow_image: true,
          timeout_ms: 60_000,
        },
      },
    });
  }
  // If we used a proximity-linked photo, mark it consumed so it doesn't get reused.
  if (usedRecentPhoto) markPhotoConsumed(usedRecentPhoto.photo_id);

  // 3. Download + resize
  let imgBuf: Buffer;
  try {
    imgBuf = await downloadAndResize(imageItem.url);
  } catch (err) {
    console.error('[mcp] image download failed', err);
    return buildErrorResponse("Couldn't grab that image — try again?");
  }

  // 4. Idempotency
  const imgHash = sha256(imgBuf);
  const idemKey = `${input.userId}:${imgHash}`;
  const existing = findIdempotency(idemKey, IDEMPOTENCY_WINDOW_MS);
  if (existing) {
    const prior = getComparison(existing.comparison_id);
    if (prior?.amazon_price_inr) {
      return buildHappyPathResponse({
        text: `${formatInr(prior.amazon_price_inr)} on Amazon — already checked just now.`,
        embedded: [
          {
            type: 'feed_item',
            content: {
              feed_type: 'skill',
              title: `Worth It · ${prior.identified_brand || ''} ${prior.identified_name || ''}`.trim() + ` · Amazon ₹${formatInr(prior.amazon_price_inr)}`,
              story: 'Duplicate request within 60s — replaying earlier result.',
            },
          },
        ],
      });
    }
  }

  // 5. Vision
  let vision: VisionResult;
  try {
    vision = await callVision(imgBuf);
  } catch (err) {
    console.error('[mcp] vision failed', err);
    return buildErrorResponse("Couldn't see that clearly. Try again?");
  }
  console.log(`[mcp] vision: brand="${vision.brand}" name="${vision.name}" model="${vision.model}" confidence=${vision.confidence} query="${vision.search_query}"`);

  // 6. Low confidence → barcode fallback
  if (vision.confidence < VISION_CONFIDENCE_THRESHOLD) {
    const comparisonId = uuid();
    insertComparison({
      comparison_id: comparisonId,
      user_id: input.userId,
      session_id: input.session_id,
      image_url: imageItem.url,
      identified_name: vision.name,
      identified_brand: vision.brand,
      identified_model: vision.model,
      identified_via: 'vision',
      vision_confidence: vision.confidence,
      barcode: vision.barcode,
      status: 'awaiting_barcode',
    });
    upsertIdempotency(idemKey, comparisonId);

    const awaitResp: AwaitInputResponse = {
      type: 'await_input',
      content: {
        question: "Not quite sure what that is — show me the barcode about an arm's length away?",
        context_key: 'barcode_fallback',
        context_payload: { comparison_id: comparisonId, original_image_url: imageItem.url },
        allow_image: true,
        timeout_ms: 60_000,
      },
    };
    return buildAwaitResponse({
      text: 'Not quite sure what that is — show me the barcode?',
      await: awaitResp,
    });
  }

  // 7. Insert seed
  const comparisonId = uuid();
  insertComparison({
    comparison_id: comparisonId,
    user_id: input.userId,
    session_id: input.session_id,
    image_url: imageItem.url,
    identified_name: vision.name,
    identified_brand: vision.brand,
    identified_model: vision.model,
    identified_via: 'vision',
    vision_confidence: vision.confidence,
    barcode: vision.barcode,
    status: 'mcp_running',
  });
  upsertIdempotency(idemKey, comparisonId);

  // 8. Fan out
  const amazonP = scrapeAmazon(vision.search_query);
  const serpP = searchSerpapi(vision.search_query);

  // 9. Wait for Amazon
  const amazon = await amazonP;
  if (amazon) updateAmazon(comparisonId, amazon.price_inr, amazon.url || '');
  console.log(`[mcp] path: amazon=${amazon ? `₹${amazon.price_inr}` : 'NULL'} → ${amazon ? 'happy' : 'degraded (will push SerpAPI as fallback if found)'}`);

  // 10. Background SerpAPI → ALWAYS push results when found (informational at minimum)
  void serpP
    .then(async (serpResults) => {
      const top3 = serpResults.slice(0, 3);
      const serpBest = serpResults[0] ?? null;
      console.log(`[mcp] serp completed: ${serpResults.length} results${serpBest ? ` (best=₹${serpBest.price_inr} on ${serpBest.source})` : ''}`);
      updateSerp(
        comparisonId,
        serpBest ? { price_inr: serpBest.price_inr, source: serpBest.source, url: serpBest.url } : null,
        top3,
        serpResults.length ? 'serp_completed' : 'no_price'
      );
      if (!serpBest) {
        console.log(`[mcp] no SerpAPI result, no push`);
        return;
      }

      // Filter sanity floor (likely-wrong matches priced ≪ amazon)
      const filteredTop3 = top3.filter((r) =>
        !amazon || r.price_inr >= amazon.price_inr * PUSH_MIN_RATIO_VS_AMAZON
      );

      // Decide TTS-loud vs silent push.
      // Loud (speak): Amazon failed OR a meaningfully cheaper non-Amazon option exists.
      // Silent (no speak, feed only): SerpAPI completed but Amazon was already best — still surface results.
      let speak = false;
      let deltaInr = 0;

      if (!amazon) {
        speak = true;  // Amazon failed; SerpAPI is the primary answer
      } else {
        const cheaperBest = filteredTop3.find((r) => !r.source.toLowerCase().includes('amazon'));
        if (cheaperBest) {
          deltaInr = amazon.price_inr - cheaperBest.price_inr;
          const meaningfullyCheaper =
            cheaperBest.price_inr < amazon.price_inr * (1 - PUSH_DELTA_PCT_MIN) || deltaInr >= PUSH_DELTA_INR_MIN;
          if (meaningfullyCheaper) speak = true;
        }
      }

      console.log(`[mcp] firing push: speak=${speak} delta=₹${deltaInr} top3=${filteredTop3.length}`);
      const ok = await sendComparisonPush({
        userId: input.userId,
        amazon: amazon || { source: serpBest.source, title: vision.name, price_inr: serpBest.price_inr, url: serpBest.url },
        serpBest,
        top3: filteredTop3,
        deltaInr,
        productLabel: productLabel(vision),
        speak,
        amazonFailed: !amazon,
      });
      if (ok) markPushSent(comparisonId);
    })
    .catch((err) => console.error('[mcp] serp background failed', err));

  // 11. Build MCP response
  if (amazon) {
    setStatus(comparisonId, 'mcp_returned');
    const text = `₹${formatInr(amazon.price_inr)} on Amazon — checking others now.`;
    const embedded: SkillResponse[] = [feedItemForAmazon(vision, amazon)];
    if (input.granted_integrations?.includes('gmail')) {
      embedded.push(mailSendForAmazon(vision, amazon));
    }
    return buildHappyPathResponse({ text, embedded });
  }

  // 12. Amazon failed → degrade
  setStatus(comparisonId, 'amazon_failed');
  return buildHappyPathResponse({
    text: "Saved to your feed — I'll send the price in a moment.",
    embedded: [feedItemNoPrice(vision)],
  });
}

// ─── Barcode fallback handler ────────────────────────────────────────────────

async function handleBarcodeFollowup(input: ToolInput): Promise<McpResult> {
  const ctx = input.pending_context!;
  const comparisonId = ctx.context_payload?.comparison_id as string | undefined;
  if (!comparisonId) {
    return buildErrorResponse("Lost track of that — say 'is this worth it?' to start over.");
  }

  const imageItem = (input.items || []).find((i) => i.mimeType?.startsWith('image/'));
  if (!imageItem) {
    return buildErrorResponse('Need to see the barcode — try again with the camera close to it.');
  }

  let imgBuf: Buffer;
  try {
    imgBuf = await downloadAndResize(imageItem.url);
  } catch {
    return buildErrorResponse("Couldn't grab that image — try again?");
  }

  // Re-call vision with barcode-focused prompt; we reuse callVision and rely on its barcode field
  let vision: VisionResult;
  try {
    vision = await callVision(imgBuf);
  } catch {
    return buildErrorResponse("Couldn't read that — try a clearer angle?");
  }

  // If neither barcode nor a confident product was read, give up gracefully
  if (!vision.barcode && vision.confidence < 0.6 && !vision.search_query) {
    setStatus(comparisonId, 'error');
    return buildErrorResponse('Still no luck — try a different angle?');
  }

  const queryForSearch = vision.search_query || vision.barcode || `${vision.brand} ${vision.name}`.trim();

  const amazon = await scrapeAmazon(queryForSearch);
  const serpP = searchSerpapi(queryForSearch);

  if (amazon) updateAmazon(comparisonId, amazon.price_inr, amazon.url || '');

  void serpP
    .then(async (serpResults) => {
      const top3 = serpResults.slice(0, 3);
      const serpBest = serpResults[0] ?? null;
      console.log(`[mcp:barcode] serp completed: ${serpResults.length} results${serpBest ? ` (best=₹${serpBest.price_inr} on ${serpBest.source})` : ''}`);
      updateSerp(
        comparisonId,
        serpBest ? { price_inr: serpBest.price_inr, source: serpBest.source, url: serpBest.url } : null,
        top3,
        serpResults.length ? 'serp_completed' : 'no_price'
      );
      if (!serpBest) return;

      const filteredTop3 = top3.filter((r) =>
        !amazon || r.price_inr >= amazon.price_inr * PUSH_MIN_RATIO_VS_AMAZON
      );

      let speak = false;
      let deltaInr = 0;
      if (!amazon) {
        speak = true;
      } else {
        const cheaperBest = filteredTop3.find((r) => !r.source.toLowerCase().includes('amazon'));
        if (cheaperBest) {
          deltaInr = amazon.price_inr - cheaperBest.price_inr;
          const meaningfullyCheaper =
            cheaperBest.price_inr < amazon.price_inr * (1 - PUSH_DELTA_PCT_MIN) || deltaInr >= PUSH_DELTA_INR_MIN;
          if (meaningfullyCheaper) speak = true;
        }
      }

      const ok = await sendComparisonPush({
        userId: input.userId,
        amazon: amazon || { source: serpBest.source, title: vision.name, price_inr: serpBest.price_inr, url: serpBest.url },
        serpBest,
        top3: filteredTop3,
        deltaInr,
        productLabel: productLabel(vision),
        speak,
        amazonFailed: !amazon,
      });
      if (ok) markPushSent(comparisonId);
    })
    .catch((err) => console.error('[mcp] serp background failed', err));

  if (amazon) {
    setStatus(comparisonId, 'mcp_returned');
    const text = `Got it — ₹${formatInr(amazon.price_inr)} on Amazon, checking others now.`;
    const embedded: SkillResponse[] = [feedItemForAmazon(vision, amazon)];
    if (input.granted_integrations?.includes('gmail')) {
      embedded.push(mailSendForAmazon(vision, amazon));
    }
    return buildHappyPathResponse({ text, embedded });
  }

  setStatus(comparisonId, 'amazon_failed');
  return buildHappyPathResponse({
    text: "Saved to your feed — I'll send the price in a moment.",
    embedded: [feedItemNoPrice(vision)],
  });
}
