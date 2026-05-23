import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import { verifyTraceSignature } from './hmac';
import { v4 as uuid } from 'uuid';
import { handleDialog } from './handlers/mcp';
import { deleteUserData, cacheRecentPhoto } from './services/db';
import { ToolInput } from './types/trace';

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);
const TRACE_HMAC_SECRET = process.env.TRACE_HMAC_SECRET || '';

// Capture rawBody for HMAC verification on /webhook
app.use(
  express.json({
    limit: '5mb',
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ─── MCP — JSON-RPC 2.0 ──────────────────────────────────────────────────────
// Per spec, /mcp is NOT HMAC-signed by the platform.
app.post('/mcp', async (req: Request, res: Response) => {
  const { jsonrpc, method, params, id } = req.body || {};
  if (jsonrpc !== '2.0') {
    return res.status(400).json({ error: 'Invalid JSON-RPC' });
  }

  if (method === 'tools/list') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'handle_dialog',
            description:
              "Handle 'is this worth it?' voice + image. Identifies the product, returns the cheapest Indian online price.",
            inputSchema: {
              type: 'object',
              properties: {
                utterance: { type: 'string' },
                userId: { type: 'string' },
                items: { type: 'array' },
                context: { type: 'object' },
                user: { type: 'object' },
                pending_context: { type: 'object' },
              },
              required: ['userId', 'user'],
            },
          },
        ],
      },
    });
  }

  if (method === 'tools/call') {
    const t0 = Date.now();
    const toolName = params?.name;
    if (toolName !== 'handle_dialog') {
      return res.status(404).json({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Unknown tool: ${toolName}` },
      });
    }
    try {
      const args = (params?.arguments || {}) as ToolInput;
      const result = await handleDialog(args);
      const dur = Date.now() - t0;
      console.log(`[mcp] handle_dialog ${dur}ms | userId=${args.userId} | state=${result.state || 'completed'}`);
      return res.json({ jsonrpc: '2.0', id, result });
    } catch (err) {
      console.error('[mcp] handle_dialog error', err);
      return res.status(500).json({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: 'Internal error' },
      });
    }
  }

  return res.status(404).json({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  });
});

// ─── Webhook (signed) ────────────────────────────────────────────────────────
// Per spec: /webhook IS signed. Handles passive media.photo + user.deleted events.
app.post('/webhook', verifyTraceSignature(TRACE_HMAC_SECRET), async (req: Request, res: Response) => {
  // Acknowledge immediately — never keep the platform waiting.
  res.status(202).json({ status: 'accepted' });

  const { event, user } = req.body || {};
  const userId = user?.id;

  console.log(`[webhook] channel=${event?.channel} user=${userId}`);

  if (event?.channel === 'media.photo' && userId) {
    // Cache the photo for proximity linking to the next voice query within 5 min.
    const item = (event.items || []).find((i: any) => i.url);
    if (item?.url) {
      const photoId = item.id || uuid();
      cacheRecentPhoto(photoId, userId, item.url);
      console.log(`[webhook] cached media.photo ${photoId} for user ${userId}`);
    }
    return;
  }

  if (event?.channel === 'user.deleted' && userId) {
    const counts = deleteUserData(userId);
    console.log(`[webhook] deleted user ${userId}: ${JSON.stringify(counts)}`);
    return;
  }
});

// Dedicated user-deletion endpoint declared in manifest.dataRetention.deletion_webhook
app.post('/delete-user', verifyTraceSignature(TRACE_HMAC_SECRET), (req: Request, res: Response) => {
  const userId = req.body?.user_id;
  if (!userId) return res.status(400).json({ error: 'user_id required' });
  const counts = deleteUserData(userId);
  console.log(`[delete-user] ${userId}: ${JSON.stringify(counts)}`);
  return res.json({ ok: true, deleted: counts });
});

// Health
app.get('/', (_req: Request, res: Response) => {
  res.json({ skill: 'Worth It', version: '1.0.0', status: 'ok' });
});

app.listen(PORT, () => {
  const haveKeys = !!process.env.OPENAI_API_KEY && !!process.env.SERPAPI_KEY;
  console.log(`🛒 Worth It skill on http://localhost:${PORT} | keys=${haveKeys ? 'set' : 'MISSING'}`);
});
