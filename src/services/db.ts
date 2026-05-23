import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_DIR = path.resolve(__dirname, '../../data');
const DB_PATH = path.join(DB_DIR, 'worthit.db');

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS recent_photos (
    photo_id    TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    image_url   TEXT NOT NULL,
    captured_at INTEGER NOT NULL,
    consumed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_user_photos ON recent_photos(user_id, captured_at DESC);

  CREATE TABLE IF NOT EXISTS comparisons (
    comparison_id     TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL,
    created_at        INTEGER NOT NULL,
    session_id        TEXT,
    image_url         TEXT,
    identified_name   TEXT,
    identified_brand  TEXT,
    identified_model  TEXT,
    identified_via    TEXT CHECK (identified_via IN ('vision','barcode','manual')),
    vision_confidence REAL,
    barcode           TEXT,
    amazon_price_inr  INTEGER,
    amazon_url        TEXT,
    amazon_at         INTEGER,
    serp_best_price_inr INTEGER,
    serp_best_source    TEXT,
    serp_best_url       TEXT,
    serp_completed_at   INTEGER,
    serp_raw_top3_json  TEXT,
    push_sent           INTEGER NOT NULL DEFAULT 0,
    push_sent_at        INTEGER,
    status              TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_user_created ON comparisons(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_session ON comparisons(session_id);

  CREATE TABLE IF NOT EXISTS idempotency (
    key           TEXT PRIMARY KEY,
    comparison_id TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );
`);

// ─── Helpers ─────────────────────────────────────────────────────────────────

export interface ComparisonSeed {
  comparison_id: string;
  user_id: string;
  session_id?: string;
  image_url?: string;
  identified_name?: string;
  identified_brand?: string;
  identified_model?: string;
  identified_via: 'vision' | 'barcode' | 'manual';
  vision_confidence?: number;
  barcode?: string;
  status: string;
}

const insertComparisonStmt = db.prepare(`
  INSERT INTO comparisons (
    comparison_id, user_id, created_at, session_id, image_url,
    identified_name, identified_brand, identified_model, identified_via,
    vision_confidence, barcode, status
  ) VALUES (
    @comparison_id, @user_id, @created_at, @session_id, @image_url,
    @identified_name, @identified_brand, @identified_model, @identified_via,
    @vision_confidence, @barcode, @status
  )
`);

export function insertComparison(seed: ComparisonSeed) {
  insertComparisonStmt.run({
    comparison_id: seed.comparison_id,
    user_id: seed.user_id,
    created_at: Date.now(),
    session_id: seed.session_id ?? null,
    image_url: seed.image_url ?? null,
    identified_name: seed.identified_name ?? null,
    identified_brand: seed.identified_brand ?? null,
    identified_model: seed.identified_model ?? null,
    identified_via: seed.identified_via,
    vision_confidence: seed.vision_confidence ?? null,
    barcode: seed.barcode ?? null,
    status: seed.status,
  });
}

const updateAmazonStmt = db.prepare(`
  UPDATE comparisons SET amazon_price_inr=?, amazon_url=?, amazon_at=?
  WHERE comparison_id=?
`);
export function updateAmazon(comparisonId: string, priceInr: number, url: string) {
  updateAmazonStmt.run(priceInr, url, Date.now(), comparisonId);
}

const updateSerpStmt = db.prepare(`
  UPDATE comparisons
  SET serp_best_price_inr=?, serp_best_source=?, serp_best_url=?,
      serp_completed_at=?, serp_raw_top3_json=?, status=?
  WHERE comparison_id=?
`);
export function updateSerp(
  comparisonId: string,
  best: { price_inr: number; source: string; url?: string } | null,
  top3: any[],
  status: string
) {
  updateSerpStmt.run(
    best?.price_inr ?? null,
    best?.source ?? null,
    best?.url ?? null,
    Date.now(),
    JSON.stringify(top3),
    status,
    comparisonId
  );
}

const markPushSentStmt = db.prepare(`
  UPDATE comparisons SET push_sent=1, push_sent_at=?, status='push_sent' WHERE comparison_id=?
`);
export function markPushSent(comparisonId: string) {
  markPushSentStmt.run(Date.now(), comparisonId);
}

const setStatusStmt = db.prepare(`UPDATE comparisons SET status=? WHERE comparison_id=?`);
export function setStatus(comparisonId: string, status: string) {
  setStatusStmt.run(status, comparisonId);
}

// ─── Idempotency ─────────────────────────────────────────────────────────────

const findIdemStmt = db.prepare(`
  SELECT comparison_id, created_at FROM idempotency
  WHERE key=? AND created_at > ?
`);
export function findIdempotency(key: string, withinMs: number): { comparison_id: string } | null {
  const row = findIdemStmt.get(key, Date.now() - withinMs) as
    | { comparison_id: string; created_at: number }
    | undefined;
  return row ? { comparison_id: row.comparison_id } : null;
}

const upsertIdemStmt = db.prepare(`
  INSERT OR REPLACE INTO idempotency (key, comparison_id, created_at)
  VALUES (?, ?, ?)
`);
export function upsertIdempotency(key: string, comparisonId: string) {
  upsertIdemStmt.run(key, comparisonId, Date.now());
}

const getComparisonStmt = db.prepare(`SELECT * FROM comparisons WHERE comparison_id=?`);
export function getComparison(comparisonId: string): any | undefined {
  return getComparisonStmt.get(comparisonId);
}

// ─── Recent photos (proximity-linking for button-then-voice flow) ───────────

const cachePhotoStmt = db.prepare(`
  INSERT INTO recent_photos (photo_id, user_id, image_url, captured_at)
  VALUES (?, ?, ?, ?)
`);
export function cacheRecentPhoto(photoId: string, userId: string, imageUrl: string) {
  cachePhotoStmt.run(photoId, userId, imageUrl, Date.now());
}

const findRecentPhotoStmt = db.prepare(`
  SELECT photo_id, image_url, captured_at FROM recent_photos
  WHERE user_id = ? AND consumed_at IS NULL AND captured_at > ?
  ORDER BY captured_at DESC LIMIT 1
`);
export function findRecentPhotoForUser(userId: string, withinMs: number): { photo_id: string; image_url: string; captured_at: number } | null {
  const row = findRecentPhotoStmt.get(userId, Date.now() - withinMs) as
    | { photo_id: string; image_url: string; captured_at: number }
    | undefined;
  return row || null;
}

const markPhotoConsumedStmt = db.prepare(`
  UPDATE recent_photos SET consumed_at = ? WHERE photo_id = ?
`);
export function markPhotoConsumed(photoId: string) {
  markPhotoConsumedStmt.run(Date.now(), photoId);
}

// ─── User deletion (GDPR) ───────────────────────────────────────────────────

const deleteUserComparisonsStmt = db.prepare(`DELETE FROM comparisons WHERE user_id=?`);
const deleteUserIdemStmt = db.prepare(`DELETE FROM idempotency WHERE key LIKE ? || ':%'`);
const deleteUserPhotosStmt = db.prepare(`DELETE FROM recent_photos WHERE user_id=?`);
export function deleteUserData(userId: string): { comparisons: number; idem: number; photos: number } {
  const c = deleteUserComparisonsStmt.run(userId).changes;
  const i = deleteUserIdemStmt.run(userId).changes;
  const p = deleteUserPhotosStmt.run(userId).changes;
  return { comparisons: c, idem: i, photos: p };
}
