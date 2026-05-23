// Types for the Trace platform contract (per TRACE_CONTEXT.md).

export type InstantMessageSource =
  | 'glasses_voice'
  | 'phone_voice'
  | 'phone_text'
  | 'phone_image'
  | 'phone_image_text'
  | 'phone_voice_image'
  | 'ai_agent'
  | 'instant_image';

export interface ToolInputItem {
  id: string;
  url: string;
  mimeType: string;
  imageDescription?: string | null;
  thumbnailUrl?: string;
  captured_at?: string;
  tags?: string[];
}

export interface TraceUser {
  id: string;
  timezone: string;
  locale: string;
  name?: string;
  location?: {
    country: string;
    city: string;
    latitude: number;
    longitude: number;
  };
}

export interface ToolInput {
  utterance: string;
  userId: string;
  deviceId?: string;
  session_id?: string;
  turn_index?: number;
  context?: {
    source?: InstantMessageSource | string;
    query?: string;
    hasImage?: boolean;
    imageDescription?: string | null;
  };
  items?: ToolInputItem[];
  user: TraceUser;
  pending_context?: PendingContext | null;
  granted_permissions?: string[];
  granted_integrations?: string[];
}

export interface PendingContext {
  context_key: string;
  context_payload: any;
  question?: string;
  turn_count?: number;
}

// ─── MCP response shapes ─────────────────────────────────────────────────────

export interface FeedItemResponse {
  type: 'feed_item';
  content: {
    feed_type?: 'skill';
    title: string;
    story?: string;
  };
}

export interface NotificationResponse {
  type: 'notification';
  content: {
    title: string;
    body: string;
    tts?: string;
    speak?: boolean;
    persist?: boolean;
  };
}

export interface ToolCallResponse {
  type: 'tool_call';
  content: {
    tool: 'mail.send' | 'calendar.create';
    params: Record<string, any>;
    on_result?: 'silent' | 'notify_user' | 'callback';
    success_message?: string;
    error_message?: string;
    speak?: boolean;
  };
}

export interface AwaitInputResponse {
  type: 'await_input';
  content: {
    question: string;
    context_key?: string;
    context_payload?: any;
    allow_image?: boolean;
    timeout_ms?: number;
  };
}

export interface SetReminderResponse {
  type: 'set_reminder';
  content: { reminderText: string; time: string };
}

export type SkillResponse =
  | FeedItemResponse
  | NotificationResponse
  | ToolCallResponse
  | AwaitInputResponse
  | SetReminderResponse;

export interface McpTextContent {
  type: 'text';
  text: string;
}

export interface McpEmbeddedResponsesContent {
  type: 'embedded_responses';
  responses: SkillResponse[];
}

export type McpContent = McpTextContent | McpEmbeddedResponsesContent;

export interface McpResult {
  content: McpContent[];
  state?: 'completed' | 'awaiting_input' | 'error';
}

// ─── Internal skill types ────────────────────────────────────────────────────

export interface VisionResult {
  brand: string;
  name: string;
  model: string;
  category: string;
  search_query: string;
  confidence: number;
  barcode?: string;
}

export interface PriceResult {
  source: string;         // retailer name, e.g. "Amazon", "Flipkart"
  title: string;
  price_inr: number;
  url?: string;
  rating?: number;
}
