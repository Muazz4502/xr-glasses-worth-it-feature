import OpenAI from 'openai';
import { VisionResult } from '../types/trace';

const VISION_TIMEOUT_MS = parseInt(process.env.VISION_TIMEOUT_MS || '5000', 10);

let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

const SYSTEM_PROMPT = `You are a product identification expert for Indian shoppers. Identify the product in the image precisely.`;

const USER_PROMPT = `Identify the product in this image. Return STRICT JSON with exactly these keys:
- brand: string (e.g. "Anker", "boAt", "Apple"; empty string if unknown)
- name: string (e.g. "Soundcore 2 Bluetooth Speaker"; empty if unknown)
- model: string (e.g. "A3105"; empty if unknown)
- category: string (e.g. "Bluetooth Speaker", "Headphones", "Mouse"; empty if unknown)
- search_query: string (4-8 words optimized for Google Shopping in India, e.g. "Anker Soundcore 2 Bluetooth Speaker black")
- confidence: number (0.0 to 1.0; how confident you are this matches a real findable product)
- barcode: string (EAN-13 or UPC-A digits if a barcode is visible and clearly readable; empty otherwise)

Return ONLY the JSON object, no other text.`;

export async function callVision(imageBuf: Buffer): Promise<VisionResult> {
  const b64 = imageBuf.toString('base64');
  const dataUrl = `data:image/jpeg;base64,${b64}`;

  const completion = await getOpenAI().chat.completions.create(
    {
      model: 'gpt-4o-mini',
      max_tokens: 200,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: USER_PROMPT },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    },
    { timeout: VISION_TIMEOUT_MS }
  );

  const content = completion.choices?.[0]?.message?.content;
  if (!content) throw new Error('vision: empty response');

  const parsed = JSON.parse(content);
  const result: VisionResult = {
    brand: String(parsed.brand || ''),
    name: String(parsed.name || ''),
    model: String(parsed.model || ''),
    category: String(parsed.category || ''),
    search_query: String(parsed.search_query || `${parsed.brand || ''} ${parsed.name || ''}`).trim(),
    confidence: Number(parsed.confidence ?? 0),
    barcode: parsed.barcode ? String(parsed.barcode) : undefined,
  };
  return result;
}
