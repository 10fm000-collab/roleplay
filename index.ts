import { Hono } from "hono";
import { jwtVerify, createRemoteJWKSet } from "jose";
import nodeCrypto from "node:crypto";

type Env = {
  roleplay_db: D1Database;
  ADMIN_API_KEY?: string;
  LLM_BASE_URL: string;
  LLM?: Fetcher;
  KV: KVNamespace;
  FIREBASE_PROJECT_ID: string;
  ADMIN_UIDS: string;
  QDRANT_URL: string;
  QDRANT_COLLECTION: string;
  QDRANT_API_KEY: string;
  VOYAGE_API_KEY: string;
  VOYAGE_EMBED_MODEL: string;
  VOYAGE_OUTPUT_DIM: string;
  MODEL_PLUS?: string;
  MODEL_PRO?: string;
  RAZORPAY_KEY_ID: string;
  RAZORPAY_KEY_SECRET: string;
  RAZORPAY_WEBHOOK_SECRET?: string;
};

const app = new Hono<{ Bindings: Env }>();

const CONTROL_START = "---CONTROL_JSON---";
const CONTROL_END = "---END_CONTROL_JSON---";

const HISTORY_TURNS = 14;
const MAX_MEMORY_CHARS = 1400;
const AUTO_LIMIT_DEFAULT = 4;

// ================== COINS + WALLET CONFIG ==================
const COIN_COST_PER_ASSISTANT = 2;
const FIRST_LOGIN_BONUS_COINS = 50;
const DAILY_REWARD_CHOICES = [10, 15, 20];
const FIRST_ASSISTANT_MESSAGE_FREE = true;

// ================== COIN PACKS (Razorpay) ==================
const COIN_PACKS: Record<number, number> = {
  10: 20,
  49: 120,
  99: 300,
  199: 700,
};

// ================== UNCENSORED: DISABLED ==================
// Uncensored feature disabled hai - KV writes bachane ke liye
// Code rakha hai taaki errors na aayein, bas kaam nahi karta
const UNCENSORED_ENABLED = false;

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function dateKeyIST(now = new Date()) {
  const istMs = now.getTime() + 330 * 60 * 1000;
  const d = new Date(istMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

type WalletRow = {
  user_id: string;
  coins: number;
  plan: string;
  plan_expires_at: number;
  first_bonus_given: number;
  last_daily_claim_key: string;
};

async function ensureWallet(env: Env, userId: string): Promise<WalletRow> {
  const row = await env.roleplay_db
    .prepare(`SELECT * FROM wallets WHERE user_id=? LIMIT 1`)
    .bind(userId)
    .first<any>();

  if (row) return row as WalletRow;

  const t = nowSec();

  await env.roleplay_db
    .prepare(
      `
      INSERT INTO wallets
      (user_id, coins, plan, plan_expires_at, first_bonus_given, last_daily_claim_key, created_at, updated_at)
      VALUES (?, ?, 'free', 0, 1, '', ?, ?)
    `,
    )
    .bind(userId, FIRST_LOGIN_BONUS_COINS, t, t)
    .run();

  try {
    await env.roleplay_db
      .prepare(
        `INSERT INTO wallet_ledger (id, user_id, amount, type, meta_json, ts)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        userId,
        FIRST_LOGIN_BONUS_COINS,
        "first_login_bonus",
        JSON.stringify({}),
        t,
      )
      .run();
  } catch {}

  const created = await env.roleplay_db
    .prepare(`SELECT * FROM wallets WHERE user_id=? LIMIT 1`)
    .bind(userId)
    .first<any>();

  return created as WalletRow;
}

function effectivePlan(w: WalletRow) {
  const exp = Number((w as any).plan_expires_at || 0);
  const p = String((w as any).plan || "free");
  if (p === "free") return "free";
  if (exp === 0) return p;
  return exp > nowSec() ? p : "free";
}

function pickModelForPlan(env: Env, characterDefault: string, plan: string) {
  const plus = env.MODEL_PLUS;
  const pro = env.MODEL_PRO;
  if (plan === "pro" && pro) return pro;
  if (plan === "plus" && plus) return plus;
  return characterDefault;
}

async function walletTryDebit(
  env: Env,
  userId: string,
  amount: number,
  type: string,
  meta: any,
) {
  const t = nowSec();
  const res = await env.roleplay_db
    .prepare(
      `
      UPDATE wallets
      SET coins = coins - ?, updated_at=?
      WHERE user_id=? AND coins >= ?
    `,
    )
    .bind(amount, t, userId, amount)
    .run();

  const ok = (res.meta.changes || 0) === 1;

  if (ok) {
    try {
      await env.roleplay_db
        .prepare(
          `INSERT INTO wallet_ledger (id, user_id, amount, type, meta_json, ts)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          userId,
          -Math.abs(amount),
          type,
          JSON.stringify(meta || {}),
          t,
        )
        .run();
    } catch {}
  }

  return ok;
}

async function walletCredit(
  env: Env,
  userId: string,
  amount: number,
  type: string,
  meta: any,
) {
  const t = nowSec();
  await env.roleplay_db
    .prepare(`UPDATE wallets SET coins=coins+?, updated_at=? WHERE user_id=?`)
    .bind(amount, t, userId)
    .run();

  try {
    await env.roleplay_db
      .prepare(
        `INSERT INTO wallet_ledger (id, user_id, amount, type, meta_json, ts)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        userId,
        amount,
        type,
        JSON.stringify(meta || {}),
        t,
      )
      .run();
  } catch {}
}

async function assistantAlreadyExists(env: Env, conversationId: string) {
  const row = await env.roleplay_db
    .prepare(
      `SELECT 1 AS x FROM messages WHERE conversation_id=? AND role='assistant' LIMIT 1`,
    )
    .bind(conversationId)
    .first<any>();
  return !!row;
}

// ================== RELATION SCORE ==================
function getRelationScore(state: any) {
  const v = Number(state?.relation_score ?? 0);
  if (!Number.isFinite(v)) return 0;
  return clamp(Math.round(v), -100, 100);
}

function setRelationScore(state: any, score: number) {
  state.relation_score = clamp(Math.round(score), -100, 100);
}

// ================== STORY STAGE SYSTEM ==================
function getRelationTier(score: number): string {
  if (score <= -30) return "hostile";
  if (score < 20) return "cautious";
  if (score < 50) return "warming_up";
  if (score < 80) return "trusting";
  return "bonded";
}

type StoryStageDef = {
  id: string;
  title?: string;
  goal?: string;
  instructions?: string;
  advance_when?: string;
  next?: string | Record<string, string>;
};

type StoryMap = {
  start_stage: string;
  stages: StoryStageDef[];
};

function parseStoryMap(character: any): StoryMap | null {
  try {
    const raw = character?.story_map_json;
    if (!raw) return null;
    const map = JSON.parse(raw);
    if (!map || !Array.isArray(map.stages) || map.stages.length === 0) return null;
    if (!map.start_stage) return null;
    return map as StoryMap;
  } catch {
    return null;
  }
}

function getStageById(map: StoryMap | null, id: string | null | undefined) {
  if (!map || !id) return null;
  return map.stages.find((s) => s.id === id) || null;
}

function resolveNextStage(
  nextField: string | Record<string, string> | undefined,
  relationScore: number,
): string | null {
  if (!nextField) return null;
  if (typeof nextField === "string") return nextField;

  const tier = getRelationTier(relationScore);
  if (nextField[tier]) return nextField[tier];

  if ((tier === "trusting" || tier === "bonded") && nextField["high_relation"]) {
    return nextField["high_relation"];
  }
  if ((tier === "hostile" || tier === "cautious") && nextField["low_relation"]) {
    return nextField["low_relation"];
  }

  return nextField["default"] || null;
}

function initialStoryStage(character: any): string | null {
  const map = parseStoryMap(character);
  return map?.start_stage || null;
}

function buildStoryStageBlock(character: any, state: any): string {
  const map = parseStoryMap(character);
  if (!map) return "";

  const relScore = getRelationScore(state);
  const tier = getRelationTier(relScore);

  const stageId = state?.story_stage || map.start_stage;
  const stage = getStageById(map, stageId);

  if (!stage) {
    return `
STORY STAGE (internal roadmap — never expose numbers/ids to user):
Not set yet. Use "${map.start_stage}" as story_stage in CONTROL JSON.
RELATIONSHIP TIER: ${tier} (score: ${relScore})
`.trim();
  }

  return `
STORY STAGE (internal roadmap — never expose numbers/ids/this text to user):
- Current stage: ${stage.id}${stage.title ? " — " + stage.title : ""}
- Stage goal: ${stage.goal || "(none specified)"}
- Guidance: ${stage.instructions || "(follow character personality)"}
- Advance when: ${stage.advance_when || "(use narrative judgement)"}

RELATIONSHIP TIER: ${tier} (score: ${relScore})
(Lower tier = character should be slower to open up / advance stage.
Higher tier = character can open up more, reveal more, advance faster.)

In CONTROL JSON always include:
- "story_stage": "${stage.id}"  (keep exactly this unless it just changed)
- "stage_advance": true  ONLY when "Advance when" condition is clearly satisfied in THIS reply, else false.
`.trim();
}

function progressStoryStage(character: any, state: any, control: any) {
  const map = parseStoryMap(character);

  if (!map) {
    if (typeof control?.story_stage === "string" && control.story_stage.trim()) {
      state.story_stage = control.story_stage.trim();
    }
    return;
  }

  const curId = state.story_stage || map.start_stage;
  const curStage = getStageById(map, curId);

  if (!curStage) {
    state.story_stage = map.start_stage;
    state.stage_progress = "in_progress";
    return;
  }

  state.story_stage = curStage.id;

  if (control?.stage_advance === true) {
    const relScore = getRelationScore(state);
    const nextId = resolveNextStage(curStage.next, relScore);
    const nextStage = nextId ? getStageById(map, nextId) : null;

    if (nextStage) {
      state.story_stage = nextStage.id;
      state.stage_progress = "in_progress";
    } else {
      state.stage_progress = "ready_to_advance";
    }
  } else {
    state.stage_progress = "in_progress";
  }
}

// ---------------- utils ----------------
function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function clip(s: string, n: number) {
  s = (s || "").trim();
  return s.length <= n ? s : s.slice(0, n).trimEnd() + "…";
}

function normalizeBaseUrl(url: string) {
  return String(url || "").trim().replace(/\/+$/, "");
}

function defaultState() {
  return {
    location: "town_street",
    mood: "shaken",
    trust: 0.05,
    stress: 0.85,
    energy: 0.55,
    goal: "reach_shelter_safely",
    task: "escaped_crowd",
    story_time: "late_afternoon",
    relation_score: 0,
    story_stage: null as string | null,
    stage_progress: "in_progress",
  };
}

function buildContextSystem(
  state: any,
  storySummary: string,
  relevantBlock: string,
) {
  return `
CURRENT STATE (backend truth, do not expose as numbers directly):
- location: ${state?.location ?? "unknown"}
- mood: ${state?.mood ?? ""}
- trust: ${state?.trust ?? 0}
- stress: ${state?.stress ?? 0}
- energy: ${state?.energy ?? 0}
- goal: ${state?.goal ?? ""}
- task: ${state?.task ?? ""}
- story_time: ${state?.story_time ?? ""}

STORY SUMMARY (medium-term, keep consistent):
${storySummary || "(none yet)"}

${relevantBlock || "RELEVANT MEMORIES:\n(none)"}
`.trim();
}

function continueInstruction(maxAuto = 4) {
  return `
CONTINUE SCENE:
Progress the scene for 1 beat. If still safe to progress, set continue_story=true (up to ${maxAuto} total).
Do not ask a direct question.
`.trim();
}

function companionInstruction() {
  return `
COMPANION BEAT (LIVE WITH USER):
You are physically with the user right now.
Write ONE short proactive beat:
- Notice ONE new concrete detail around you (sound/smell/people/object).
- Ask ONE grounded question based on the immediate situation (sigil/food/shelter/route).
- Do NOT repeat earlier phrasing.
End with a natural pause so the user can reply.
In CONTROL JSON set continue_story=false and ui_hint="your_turn".
`.trim();
}

// ---------------- Firebase Auth helpers ----------------
const FIREBASE_JWKS = createRemoteJWKSet(
  new URL(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
  ),
);

async function verifyFirebaseIdToken(idToken: string, projectId: string) {
  const { payload } = await jwtVerify(idToken, FIREBASE_JWKS, {
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
  });
  return String(payload.sub || "");
}

async function requireAuthUid(c: any) {
  const auth = c.req.header("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  if (!token) return null;
  try {
    const uid = await verifyFirebaseIdToken(token, c.env.FIREBASE_PROJECT_ID);
    return uid || null;
  } catch {
    return null;
  }
}

function isAdminUid(env: any, uid: string) {
  const list = String(env.ADMIN_UIDS || "")
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean);
  return list.includes(uid);
}

async function requireUserId(c: any) {
  const uid = await requireAuthUid(c);
  if (uid) return uid;
  const dev = (c.req.header("x-user-id") || "").trim();
  if (dev) return dev;
  throw new Error("unauthorized_missing_token");
}

// ================== RATE LIMIT - D1 BASED (NO KV) ==================
async function rateLimitOr429(c: any, userId: string) {
  const ip = (c.req.header("cf-connecting-ip") || "noip").trim();
  const windowSec = 600;
  const limitUser = 60;
  const limitIp = 120;

  const bucket = Math.floor(Date.now() / 1000 / windowSec);
  const now = nowSec();
  const expiry = now + windowSec + 30;

  try {
    // ── User rate limit ──
    const userKey = `rl:u:${userId}:${bucket}`;

    await c.env.roleplay_db
      .prepare(
        `INSERT INTO rate_limits (rl_key, hits, expires_at)
         VALUES (?, 1, ?)
         ON CONFLICT(rl_key) DO UPDATE SET hits = hits + 1`,
      )
      .bind(userKey, expiry)
      .run();

    // <any> hatao - type assertion alag se karo
    const uRow = await c.env.roleplay_db
      .prepare(`SELECT hits FROM rate_limits WHERE rl_key=? LIMIT 1`)
      .bind(userKey)
      .first() as { hits: number } | null;  // ← FIX: as keyword use karo

    if (Number(uRow?.hits || 0) > limitUser) {
      return c.json({ ok: false, error: "rate_limited_user" }, 429);
    }

    // ── IP rate limit ──
    const ipKey = `rl:ip:${ip}:${bucket}`;

    await c.env.roleplay_db
      .prepare(
        `INSERT INTO rate_limits (rl_key, hits, expires_at)
         VALUES (?, 1, ?)
         ON CONFLICT(rl_key) DO UPDATE SET hits = hits + 1`,
      )
      .bind(ipKey, expiry)
      .run();

    const iRow = await c.env.roleplay_db
      .prepare(`SELECT hits FROM rate_limits WHERE rl_key=? LIMIT 1`)
      .bind(ipKey)
      .first() as { hits: number } | null;  // ← FIX: as keyword use karo

    if (Number(iRow?.hits || 0) > limitIp) {
      return c.json({ ok: false, error: "rate_limited_ip" }, 429);
    }

  } catch (e: any) {
    console.error("RATE_LIMIT_ERROR", String(e?.message || e));
  }

  return null;
}

// ── Occasionally purane rate limit rows clean karo (D1 bhara nahi rahe) ──
async function cleanRateLimits(env: Env) {
  try {
    await env.roleplay_db
      .prepare(`DELETE FROM rate_limits WHERE expires_at < ?`)
      .bind(nowSec())
      .run();
  } catch {}
}

// ---------------- locks ----------------
async function acquireLock(
  env: Env,
  conversationId: string,
  token: string,
  ttlSec = 20,
) {
  const now = nowSec();
  const expires = now + ttlSec;

  const res = await env.roleplay_db
    .prepare(`
      UPDATE conversations
      SET lock_token=?, lock_expires_at=?
      WHERE id=? AND lock_expires_at < ?
    `)
    .bind(token, expires, conversationId, now)
    .run();

  return (res.meta.changes || 0) === 1;
}

async function releaseLock(env: Env, conversationId: string, token: string) {
  await env.roleplay_db
    .prepare(`
      UPDATE conversations
      SET lock_expires_at=0
      WHERE id=? AND lock_token=?
    `)
    .bind(conversationId, token)
    .run();
}

// ---------------- DB helpers ----------------
async function getCharacter(env: Env, characterId: string) {
  const row = await env.roleplay_db
    .prepare("SELECT * FROM characters WHERE id=?")
    .bind(characterId)
    .first<any>();
  if (!row) throw new Error("character_not_found");
  return row;
}

async function getConversation(
  env: Env,
  conversationId: string,
  userId: string,
) {
  const row = await env.roleplay_db
    .prepare("SELECT * FROM conversations WHERE id=? AND user_id=?")
    .bind(conversationId, userId)
    .first<any>();
  if (!row) throw new Error("conversation_not_found");
  return row;
}

async function getRecentMessages(env: Env, conversationId: string) {
  const limit = HISTORY_TURNS * 2;

  const res = await env.roleplay_db
    .prepare(`
      SELECT role, content
      FROM messages
      WHERE conversation_id=?
      ORDER BY ts DESC
      LIMIT ?
    `)
    .bind(conversationId, limit)
    .all<any>();

  const rows = (res.results || []).reverse();
  return rows.map((r) => ({ role: r.role, content: r.content }));
}

// ---------------- LLM call ----------------
async function callLLM(env: Env, payload: any, timeoutMs = 120_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    if (env.LLM) {
      const r = await env.LLM.fetch("https://llm/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });

      if (!r.ok) {
        const t = await r.text().catch(() => "");
        throw new Error(`llm_service_http_${r.status}: ${t.slice(0, 200)}`);
      }

      const data: any = await r.json();
      return data?.choices?.[0]?.message?.content || "";
    }

    const base = normalizeBaseUrl(env.LLM_BASE_URL || "");
    const url = `${base}/v1/chat/completions`;

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });

    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`llm_http_${r.status}: ${t.slice(0, 200)}`);
    }

    const data: any = await r.json();
    return data?.choices?.[0]?.message?.content || "";
  } finally {
    clearTimeout(timer);
  }
}

// ================== UNCENSORED SERVERS ==================
// UNCENSORED_ENABLED = false hone pe ye functions early return karte hain
// Code rakha hai taaki TypeScript errors na aayein

type UncensoredServerRow = {
  id: string;
  name: string;
  base_url: string;
  model_name: string;
  enabled: number;
  created_at: number;
  updated_at: number;
};

async function getEnabledUncensoredServers(
  env: Env,
): Promise<UncensoredServerRow[]> {
  if (!UNCENSORED_ENABLED) return [];
  const res = await env.roleplay_db
    .prepare(
      `SELECT * FROM uncensored_servers WHERE enabled=1 ORDER BY created_at ASC`,
    )
    .all<any>();
  return (res.results || []) as UncensoredServerRow[];
}

async function pingServer(
  server: UncensoredServerRow,
  timeoutMs = 3500,
): Promise<boolean> {
  if (!UNCENSORED_ENABLED) return false;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const url = normalizeBaseUrl(server.base_url) + "/v1/models";
    const r = await fetch(url, { method: "GET", signal: ac.signal });
    clearTimeout(timer);
    return r.ok;
  } catch {
    return false;
  }
}

async function callUncensoredLLM(
  env: Env,
  payload: any,
  timeoutMs = 120_000,
): Promise<string> {
  // ── DISABLED: KV use nahi karna, feature off hai ──
  if (!UNCENSORED_ENABLED) {
    throw new Error("uncensored_feature_disabled");
  }

  const servers = await getEnabledUncensoredServers(env);
  if (servers.length === 0) throw new Error("uncensored_no_servers");

  // ── Round-robin index: KV NAHI, D1 use karo ──
  let startIdx = 0;
  try {
    const row = await env.roleplay_db
      .prepare(
        `SELECT val_int FROM app_settings WHERE key='uncensored_rr_index' LIMIT 1`,
      )
      .first<any>();
    startIdx = row?.val_int
      ? Number(row.val_int) % servers.length
      : 0;
    if (!Number.isFinite(startIdx) || startIdx < 0) startIdx = 0;
  } catch {}

  let lastErr: any = null;

  for (let i = 0; i < servers.length; i++) {
    const idx = (startIdx + i) % servers.length;
    const srv = servers[idx];

    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);

      const url = normalizeBaseUrl(srv.base_url) + "/v1/chat/completions";
      const body = { ...payload, model: srv.model_name || "default" };

      const r = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });

      clearTimeout(timer);

      if (!r.ok) {
        const t = await r.text().catch(() => "");
        lastErr = new Error(
          `uncensored_http_${r.status}: ${t.slice(0, 150)}`,
        );
        continue;
      }

      const data: any = await r.json();
      const content = data?.choices?.[0]?.message?.content || "";

      // ── KV NAHI, D1 mein index save karo ──
      try {
        await env.roleplay_db
          .prepare(
            `INSERT INTO app_settings (key, val_int) VALUES ('uncensored_rr_index', ?)
             ON CONFLICT(key) DO UPDATE SET val_int=excluded.val_int`,
          )
          .bind((idx + 1) % servers.length)
          .run();
      } catch {}

      return content;
    } catch (e: any) {
      lastErr = e;
      continue;
    }
  }

  throw lastErr || new Error("uncensored_all_failed");
}

// ---------------- Helpers: Qdrant + Voyage ----------------
function safeJson<T = any>(s: string, fallback: T): T {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function qdrantBase(env: Env) {
  return (env.QDRANT_URL || "").trim().replace(/\/+$/, "");
}

async function voyageEmbed(
  env: Env,
  texts: string[],
  inputType: "query" | "document",
) {
  const model = (env.VOYAGE_EMBED_MODEL || "").trim();
  const outDim =
    parseInt((env.VOYAGE_OUTPUT_DIM || "0").trim(), 10) || undefined;

  const r = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      input: texts,
      input_type: inputType,
      ...(outDim ? { output_dimension: outDim } : {}),
    }),
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`voyage_embed_http_${r.status}: ${t.slice(0, 200)}`);
  }

  const data: any = await r.json();
  const arr = data?.data || [];
  return arr.map((x: any) => x.embedding) as number[][];
}

function qdrantOwnerFilter(
  userId: string,
  characterId: string,
  worldId = "default",
) {
  return {
    must: [
      { key: "user_id", match: { value: userId } },
      { key: "character_id", match: { value: characterId } },
      { key: "world_id", match: { value: worldId } },
      { key: "status", match: { value: "active" } },
    ],
  };
}

async function qdrantSearch(
  env: Env,
  vector: number[],
  filter: any,
  limit = 20,
) {
  const base = qdrantBase(env);
  const col = (env.QDRANT_COLLECTION || "").trim();
  const url = `${base}/collections/${col}/points/search`;

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(env.QDRANT_API_KEY ? { "api-key": env.QDRANT_API_KEY } : {}),
    },
    body: JSON.stringify({
      vector,
      limit,
      with_payload: true,
      filter,
    }),
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`qdrant_search_http_${r.status}: ${t.slice(0, 200)}`);
  }

  const data: any = await r.json();
  return (data?.result || []) as any[];
}

async function qdrantUpsert(env: Env, points: any[]) {
  const base = qdrantBase(env);
  const col = (env.QDRANT_COLLECTION || "").trim();
  const url = `${base}/collections/${col}/points?wait=false`;

  const r = await fetch(url, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      ...(env.QDRANT_API_KEY ? { "api-key": env.QDRANT_API_KEY } : {}),
    },
    body: JSON.stringify({ points }),
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`qdrant_upsert_http_${r.status}: ${t.slice(0, 200)}`);
  }
}

function stripCodeFences(s: string) {
  return (s || "")
    .replace(/```json/gi, "```")
    .replace(/```/g, "")
    .trim();
}

function extractFirstJsonObject(s: string) {
  s = stripCodeFences(s);
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b === -1 || b <= a) return null;
  const chunk = s.slice(a, b + 1).trim();
  return chunk;
}

function buildRelevantMemoriesBlock(hits: any[]) {
  if (!hits || hits.length === 0) return "RELEVANT MEMORIES:\n(none)";

  const lines = hits.slice(0, 10).map((h: any, i: number) => {
    const p = h.payload || {};
    const t = String(p.memory_type || "memory");
    const imp =
      typeof p.importance === "number" ? p.importance.toFixed(2) : "";
    const c = String(p.content || "").trim();
    return `${i + 1}. [${t}${imp ? ` imp=${imp}` : ""}] ${c}`;
  });

  return `RELEVANT MEMORIES:\n` + lines.join("\n");
}

// ---------------- Memory Extractor ----------------
type ExtractedMemoryItem = {
  should_store: boolean;
  memory_type: string;
  content: string;
  importance: number;
  participants?: string[];
  location?: string | null;
  emotion?: string | null;
};

async function runMemoryExtractor(
  env: Env,
  model: string,
  input: {
    userText: string;
    assistantText: string;
    characterId: string;
  },
) {
  const sys = `
You are a Memory Extractor for a roleplay chat app.

Return ONLY valid JSON (no markdown, no code fences, no extra text).
Task:
- Extract durable memories that will be useful later.
- Do NOT store trivial chit-chat.
- Output short canonical memory sentences.
- Support Hindi/Hinglish/English.

Schema:
{
  "items": [
    {
      "should_store": true|false,
      "memory_type": "fact|preference|dislike|personality|relationship|event|promise|goal|fear|emotionally_significant_event|location|possession|character_development|world_fact|secret|identity|routine",
      "content": "....",
      "importance": 0.0-1.0,
      "participants": ["..."],
      "location": "..." | null,
      "emotion": "..." | null
    }
  ]
}

Rules:
- content must be <= 240 chars.
- Return at most 2 items total.
- importance guidelines:
  0.0-0.3 trivial
  0.3-0.5 low
  0.5-0.7 medium
  0.7-0.85 important
  0.85-1.0 critical
`.trim();

  const user = `
CHARACTER_ID: ${input.characterId}

USER_MESSAGE:
${input.userText}

ASSISTANT_MESSAGE:
${input.assistantText}
`.trim();

  const raw = await callLLM(env, {
    model,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    stream: false,
    thinking: false,
    show_thoughts: false,
  });

  const jsonChunk = extractFirstJsonObject(raw);
  if (!jsonChunk) return { items: [] as ExtractedMemoryItem[] };

  const obj = safeJson<any>(jsonChunk, { items: [] });
  const items = Array.isArray(obj?.items) ? obj.items : [];
  return { items };
}

function clamp01(x: number) {
  if (!Number.isFinite(x)) return 0.5;
  return Math.max(0, Math.min(1, x));
}

function normType(t: any) {
  t = String(t || "").trim().toLowerCase();
  if (!t) return "fact";
  return t;
}

function normContent(s: any) {
  s = String(s || "").trim();
  if (s.length > 240) s = s.slice(0, 240).trimEnd() + "…";
  return s;
}

async function processMemoryAsync(
  env: Env,
  args: {
    userId: string;
    conversationId: string;
    characterId: string;
    worldId?: string;
    model: string;
    userText: string;
    assistantText: string;
  },
) {
  console.log("MEMORY_ASYNC_START", {
    conversationId: args.conversationId,
    characterId: args.characterId,
    userId: args.userId,
  });

  const worldId = (args.worldId || "default").trim() || "default";

  try {
    const extracted = await runMemoryExtractor(env, args.model, {
      userText: args.userText,
      assistantText: args.assistantText,
      characterId: args.characterId,
    });

    let items: ExtractedMemoryItem[] = (extracted.items || [])
      .map((it: any) => ({
        should_store: !!it?.should_store,
        memory_type: normType(it?.memory_type),
        content: normContent(it?.content),
        importance: clamp01(Number(it?.importance)),
        participants: Array.isArray(it?.participants)
          ? it.participants.map(String)
          : undefined,
        location: it?.location == null ? null : String(it.location),
        emotion: it?.emotion == null ? null : String(it.emotion),
      }))
      .filter(
        (it: ExtractedMemoryItem) =>
          it.should_store && it.content.length >= 4,
      );

    if (items.length === 0) return;

    items.sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0));
    const selected = items
      .filter((it) => (it.importance ?? 0) >= 0.6)
      .slice(0, 2);

    if (selected.length === 0) return;

    const toInsert: ExtractedMemoryItem[] = [];
    for (const it of selected) {
      const existing = await env.roleplay_db
        .prepare(
          `
          SELECT id, importance
          FROM memories
          WHERE user_id=? AND character_id=? AND world_id=?
            AND memory_type=? AND content=? AND status='active'
          LIMIT 1
        `,
        )
        .bind(
          args.userId,
          args.characterId,
          worldId,
          it.memory_type,
          it.content,
        )
        .first<any>();

      if (existing?.id) {
        const newImp = Math.max(
          Number(existing.importance || 0),
          it.importance,
        );
        await env.roleplay_db
          .prepare(
            `UPDATE memories SET importance=?, updated_at=? WHERE id=?`,
          )
          .bind(newImp, nowSec(), existing.id)
          .run();
      } else {
        toInsert.push(it);
      }
    }

    if (toInsert.length === 0) return;

    const contents = toInsert.map((it) => it.content);
    const vecs = await voyageEmbed(env, contents, "document");

    const t = nowSec();

    const points = toInsert.map((it, idx) => {
      const id = crypto.randomUUID();
      const payload = {
        id,
        user_id: args.userId,
        conversation_id: args.conversationId,
        character_id: args.characterId,
        world_id: worldId,
        memory_type: it.memory_type,
        content: it.content,
        importance: it.importance,
        status: "active",
        created_at: t,
      };
      return { id, it, payload, vector: vecs[idx] };
    });

    await qdrantUpsert(
      env,
      points.map((p) => ({
        id: p.id,
        vector: p.vector,
        payload: p.payload,
      })),
    );

    const stmts = points.map((p) =>
      env.roleplay_db
        .prepare(
          `
          INSERT INTO memories
          (
            id, user_id, conversation_id, character_id, world_id,
            memory_type, content, importance, status,
            participants_json, location, emotion,
            created_at, updated_at,
            qdrant_point_id, embedding_provider, embedding_model
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .bind(
          p.id,
          args.userId,
          args.conversationId,
          args.characterId,
          worldId,
          p.it.memory_type,
          p.it.content,
          p.it.importance,
          "active",
          p.it.participants ? JSON.stringify(p.it.participants) : null,
          p.it.location ?? null,
          p.it.emotion ?? null,
          t,
          t,
          p.id,
          "voyage",
          (env.VOYAGE_EMBED_MODEL || "").trim(),
        ),
    );

    await env.roleplay_db.batch(stmts);

    console.log("MEMORY_ASYNC_DONE", { storedCount: points.length });
  } catch (e: any) {
    console.error("MEMORY_ASYNC_ERROR", String(e?.message || e));
    return;
  }
}

// ---------------- CONTROL extraction ----------------
function extractControl(reply: string) {
  reply = reply || "";

  let story = reply.trim();
  let control: any = null;

  if (reply.includes(CONTROL_START) && reply.includes(CONTROL_END)) {
    const before = reply.split(CONTROL_START)[0];
    const after = reply.split(CONTROL_START)[1];
    const jsonBlock = after.split(CONTROL_END)[0];

    story = before.trim();

    try {
      control = JSON.parse(jsonBlock.trim());
    } catch {
      control = null;
    }
  }

  return { story, control };
}

function fillDefaults(control: any) {
  if (!control || typeof control !== "object") control = {};

  delete control.action;

  if (typeof control.continue_story !== "boolean")
    control.continue_story = false;
  if (typeof control.scene_complete !== "boolean")
    control.scene_complete = false;
  if (typeof control.initiative !== "boolean") control.initiative = false;
  if (typeof control.trigger !== "string") control.trigger = "none";
  if (typeof control.max_auto_messages !== "number")
    control.max_auto_messages = AUTO_LIMIT_DEFAULT;

  if (!control.state_update || typeof control.state_update !== "object") {
    control.state_update = {};
  }

  if (typeof control.memory_write !== "string") {
    control.memory_write = "";
  }

  if (typeof control.relation_delta !== "number") control.relation_delta = 0;
  control.relation_delta = Math.max(
    -3,
    Math.min(3, Math.round(control.relation_delta)),
  );

  if (typeof control.story_stage !== "string") control.story_stage = "";
  if (typeof control.stage_advance !== "boolean")
    control.stage_advance = false;

  if (typeof control.ui_hint !== "string") {
    control.ui_hint = control.continue_story
      ? "scene_can_continue"
      : "your_turn";
  }

  return control;
}

function fallbackMemory(prev: string, userText: string, story: string) {
  const line = `यूज़र: ${clip(userText, 120)} | हारा: ${clip(story, 220)}`;
  const combined = (prev ? prev + "\n" : "") + line;
  return clip(combined, MAX_MEMORY_CHARS);
}

// ---------------- error handler ----------------
app.onError((err, c) => {
  const msg = String((err as any)?.message || err);
  if (msg.startsWith("unauthorized_")) {
    return c.json({ ok: false, error: msg }, 401);
  }
  return c.json({ ok: false, error: msg }, 500);
});

// ---------------- CORS ----------------
app.use("*", async (c, next) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header(
    "Access-Control-Allow-Headers",
    "content-type, authorization, x-user-id, x-admin-key",
  );
  c.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

  if (c.req.method === "OPTIONS") return c.body(null, 204);

  await next();
});

// ---------------- Health ----------------
app.get("/health", (c) => c.json({ ok: true, service: "roleplay-backend" }));

// ---------------- Admin helpers ----------------
function requireAdminKey(c: any) {
  const key = (c.req.header("x-admin-key") || "").trim();
  const expected = String(c.env.ADMIN_API_KEY || "").trim();
  if (!expected) return false;
  return key && expected && key === expected;
}

function isAdminRequest(c: any, uid: string | null) {
  const isAdmin = !!uid && isAdminUid(c.env, uid);
  const hasKey = requireAdminKey(c);
  return isAdmin || hasKey;
}

app.get("/debug/llm", async (c) => {
  if (!requireAdminKey(c)) return c.json({ ok: false, error: "admin_only" }, 403);

  const t0 = Date.now();
  try {
    const reply = await callLLM(
      c.env,
      {
        model: "gemma-4-31b",
        messages: [{ role: "user", content: "ping" }],
        stream: false,
        thinking: false,
        show_thoughts: false,
        temperature: 0,
        max_tokens: 50,
      },
      15_000,
    );

    return c.json({
      ok: true,
      ms: Date.now() - t0,
      preview: String(reply || "").slice(0, 120),
      has_service_binding: !!c.env.LLM,
      llm_base_url: c.env.LLM_BASE_URL,
    });
  } catch (e: any) {
    return c.json(
      {
        ok: false,
        ms: Date.now() - t0,
        error: String(e?.message || e),
        has_service_binding: !!c.env.LLM,
        llm_base_url: c.env.LLM_BASE_URL,
      },
      500,
    );
  }
});

app.get("/admin/debug/llm", async (c) => {
  const uid = await requireAuthUid(c);
  if (!uid || !isAdminUid(c.env, uid))
    return c.json({ error: "admin_only" }, 403);

  const payload = {
    model: "gemma-4-31b",
    messages: [{ role: "user", content: "hi debug" }],
    stream: false,
  };

  let svc_status: number | null = null;
  let svc_preview = "";
  try {
    const r = await c.env.LLM?.fetch("https://llm/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    svc_status = r?.status ?? null;
    svc_preview = r
      ? (await r.text()).slice(0, 200)
      : "NO_SERVICE_BINDING";
  } catch (e: any) {
    svc_preview = "SERVICE_THROW: " + String(e?.message || e);
  }

  return c.json({
    has_service_binding: !!c.env.LLM,
    svc_status,
    svc_preview,
  });
});

app.get("/admin/character/get", async (c) => {
  const uid = await requireAuthUid(c);
  if (!uid || !isAdminUid(c.env, uid))
    return c.json({ error: "admin_only" }, 403);

  const id = c.req.query("id");
  if (!id) return c.json({ error: "missing_id" }, 400);

  const char = await c.env.roleplay_db
    .prepare("SELECT * FROM characters WHERE id=?")
    .bind(id)
    .first<any>();

  if (!char) return c.json({ error: "character_not_found" }, 404);

  const storyMap = parseStoryMap(char);

  return c.json({ ok: true, character: char, story_map: storyMap });
});

app.post("/admin/character/upsert", async (c) => {
  const uid = await requireAuthUid(c);
  if (!uid || !isAdminUid(c.env, uid))
    return c.json({ error: "admin_only" }, 403);

  const body = await c.req.json();

  const id = (body.id || "").trim();
  if (!id) return c.json({ error: "missing_id" }, 400);

  const existing = await c.env.roleplay_db
    .prepare("SELECT * FROM characters WHERE id=? LIMIT 1")
    .bind(id)
    .first<any>();

  const name = String(body.name ?? existing?.name ?? "").trim();
  const avatar_url = String(
    body.avatar_url ?? existing?.avatar_url ?? "",
  ).trim();
  const system_prompt = body.system_prompt ?? existing?.system_prompt ?? "";
  const output_protocol_prompt =
    body.output_protocol_prompt ?? existing?.output_protocol_prompt ?? "";
  const default_model = String(
    body.default_model ?? existing?.default_model ?? "gemma-4-31b",
  ).trim();

  let story_map_json = existing?.story_map_json ?? "";
  if (body.story_map !== undefined) {
    story_map_json =
      body.story_map == null ? "" : JSON.stringify(body.story_map);
  } else if (body.story_map_json !== undefined) {
    story_map_json = String(body.story_map_json || "");
  }

  if (!name || !system_prompt || !output_protocol_prompt) {
    return c.json(
      {
        error: "missing_fields",
        required: [
          "id",
          "name",
          "system_prompt",
          "output_protocol_prompt",
        ],
      },
      400,
    );
  }

  await c.env.roleplay_db
    .prepare(
      `
      INSERT INTO characters
      (id, name, avatar_url, system_prompt, output_protocol_prompt, default_model, story_map_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,
        avatar_url=excluded.avatar_url,
        system_prompt=excluded.system_prompt,
        output_protocol_prompt=excluded.output_protocol_prompt,
        default_model=excluded.default_model,
        story_map_json=excluded.story_map_json
    `,
    )
    .bind(
      id,
      name,
      avatar_url,
      system_prompt,
      output_protocol_prompt,
      default_model,
      story_map_json,
      nowSec(),
    )
    .run();

  return c.json({ ok: true, id });
});

app.post("/admin/character/set-story-map", async (c) => {
  const uid = await requireAuthUid(c);
  if (!uid || !isAdminUid(c.env, uid))
    return c.json({ error: "admin_only" }, 403);

  const body = await c.req.json().catch(() => ({}));
  const id = String(body.id || "").trim();
  if (!id) return c.json({ error: "missing_id" }, 400);

  const storyMap = body.story_map;
  if (
    !storyMap ||
    typeof storyMap !== "object" ||
    !storyMap.start_stage ||
    !Array.isArray(storyMap.stages) ||
    storyMap.stages.length === 0
  ) {
    return c.json(
      {
        error: "invalid_story_map",
        expected_shape: {
          start_stage: "stage_id",
          stages: [
            {
              id: "stage_id",
              title: "...",
              goal: "...",
              instructions: "...",
              advance_when: "...",
              next: "next_stage_id (or object keyed by relation tier)",
            },
          ],
        },
      },
      400,
    );
  }

  const validIds = new Set(storyMap.stages.map((s: any) => s.id));
  if (!validIds.has(storyMap.start_stage)) {
    return c.json({ error: "start_stage_not_found_in_stages" }, 400);
  }

  const existing = await c.env.roleplay_db
    .prepare("SELECT id FROM characters WHERE id=? LIMIT 1")
    .bind(id)
    .first<any>();
  if (!existing) return c.json({ error: "character_not_found" }, 404);

  await c.env.roleplay_db
    .prepare(`UPDATE characters SET story_map_json=? WHERE id=?`)
    .bind(JSON.stringify(storyMap), id)
    .run();

  return c.json({
    ok: true,
    id,
    stages: storyMap.stages.length,
    start_stage: storyMap.start_stage,
  });
});

// ---------------- Public: list characters ----------------
app.get("/api/characters", async (c) => {
  const res = await c.env.roleplay_db
    .prepare(
      `
      SELECT id, name, avatar_url, default_model
      FROM characters
      ORDER BY created_at DESC
      LIMIT 50
    `,
    )
    .all<any>();

  return c.json({ ok: true, characters: res.results || [] });
});

// ================== ADMIN: UNCENSORED SERVERS ==================
// Endpoints rakhe hain - UNCENSORED_ENABLED=false hai toh kaam nahi karega
app.get("/admin/uncensored/servers/list", async (c) => {
  const uid = await requireAuthUid(c);
  if (!isAdminRequest(c, uid)) return c.json({ ok: false, error: "admin_only" }, 403);

  if (!UNCENSORED_ENABLED) {
    return c.json({ ok: true, servers: [], note: "uncensored_feature_disabled" });
  }

  const res = await c.env.roleplay_db
    .prepare(`SELECT * FROM uncensored_servers ORDER BY created_at DESC`)
    .all<any>();

  return c.json({ ok: true, servers: res.results || [] });
});

app.post("/admin/uncensored/servers/add", async (c) => {
  const uid = await requireAuthUid(c);
  if (!isAdminRequest(c, uid))
    return c.json({ ok: false, error: "admin_only" }, 403);

  if (!UNCENSORED_ENABLED) {
    return c.json({ ok: false, error: "uncensored_feature_disabled" }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const name = String(body.name || "").trim();
  const baseUrl = String(body.baseUrl || "").trim();
  const model = String(body.model || "").trim();
  const enabled = body.enabled === false ? 0 : 1;

  if (!name || !baseUrl) {
    return c.json(
      {
        ok: false,
        error: "missing_fields",
        required: ["name", "baseUrl"],
      },
      400,
    );
  }

  const id = crypto.randomUUID();
  const t = nowSec();

  await c.env.roleplay_db
    .prepare(
      `INSERT INTO uncensored_servers (id, name, base_url, model_name, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, name, baseUrl, model, enabled, t, t)
    .run();

  return c.json({ ok: true, id });
});

app.post("/admin/uncensored/servers/update", async (c) => {
  const uid = await requireAuthUid(c);
  if (!isAdminRequest(c, uid))
    return c.json({ ok: false, error: "admin_only" }, 403);

  if (!UNCENSORED_ENABLED) {
    return c.json({ ok: false, error: "uncensored_feature_disabled" }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const id = String(body.id || "").trim();
  if (!id) return c.json({ ok: false, error: "missing_id" }, 400);

  const existing = await c.env.roleplay_db
    .prepare(`SELECT * FROM uncensored_servers WHERE id=? LIMIT 1`)
    .bind(id)
    .first<any>();

  if (!existing) return c.json({ ok: false, error: "not_found" }, 404);

  const name =
    body.name != null ? String(body.name) : existing.name;
  const baseUrl =
    body.baseUrl != null ? String(body.baseUrl) : existing.base_url;
  const model =
    body.model != null ? String(body.model) : existing.model_name;
  const enabled =
    body.enabled != null ? (body.enabled ? 1 : 0) : existing.enabled;

  await c.env.roleplay_db
    .prepare(
      `UPDATE uncensored_servers
       SET name=?, base_url=?, model_name=?, enabled=?, updated_at=?
       WHERE id=?`,
    )
    .bind(name, baseUrl, model, enabled, nowSec(), id)
    .run();

  return c.json({ ok: true });
});

app.post("/admin/uncensored/servers/delete", async (c) => {
  const uid = await requireAuthUid(c);
  if (!isAdminRequest(c, uid))
    return c.json({ ok: false, error: "admin_only" }, 403);

  if (!UNCENSORED_ENABLED) {
    return c.json({ ok: false, error: "uncensored_feature_disabled" }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const id = String(body.id || "").trim();
  if (!id) return c.json({ ok: false, error: "missing_id" }, 400);

  await c.env.roleplay_db
    .prepare(`DELETE FROM uncensored_servers WHERE id=?`)
    .bind(id)
    .run();
  return c.json({ ok: true });
});

// ================== PUBLIC: UNCENSORED STATUS ==================
app.get("/api/models/uncensored-status", async (c) => {
  // Feature disabled - always return unavailable
  if (!UNCENSORED_ENABLED) {
    return c.json({ ok: true, available: false, online: 0, total: 0 });
  }

  const userId = await requireUserId(c);
  const rl = await rateLimitOr429(c, userId);
  if (rl) return rl;

  const servers = await getEnabledUncensoredServers(c.env);
  if (servers.length === 0) {
    return c.json({ ok: true, available: false, online: 0, total: 0 });
  }

  const results = await Promise.all(servers.map((s) => pingServer(s, 3500)));
  const online = results.filter(Boolean).length;

  return c.json({
    ok: true,
    available: online > 0,
    online,
    total: servers.length,
  });
});

// ---------------- Wallet endpoints ----------------
app.get("/api/wallet/me", async (c) => {
  const userId = await requireUserId(c);
  const rl = await rateLimitOr429(c, userId);
  if (rl) return rl;

  const w = await ensureWallet(c.env, userId);

  return c.json({
    ok: true,
    wallet: {
      coins: Number(w.coins || 0),
      plan: effectivePlan(w),
      plan_expires_at: Number(w.plan_expires_at || 0),
      last_daily_claim_key: String(w.last_daily_claim_key || ""),
    },
  });
});

app.post("/api/wallet/daily-claim", async (c) => {
  const userId = await requireUserId(c);
  const rl = await rateLimitOr429(c, userId);
  if (rl) return rl;

  const w = await ensureWallet(c.env, userId);

  const today = dateKeyIST(new Date());
  const last = String(w.last_daily_claim_key || "");

  if (last === today) {
    return c.json({
      ok: true,
      awarded: 0,
      alreadyClaimed: true,
      day: today,
      wallet: { coins: Number(w.coins || 0) },
    });
  }

  const awarded =
    DAILY_REWARD_CHOICES[
      Math.floor(Math.random() * DAILY_REWARD_CHOICES.length)
    ];
  const t = nowSec();

  await c.env.roleplay_db
    .prepare(
      `UPDATE wallets SET coins=coins+?, last_daily_claim_key=?, updated_at=? WHERE user_id=?`,
    )
    .bind(awarded, today, t, userId)
    .run();

  try {
    await c.env.roleplay_db
      .prepare(
        `INSERT INTO wallet_ledger (id, user_id, amount, type, meta_json, ts) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        userId,
        awarded,
        "daily_claim",
        JSON.stringify({ day: today }),
        t,
      )
      .run();
  } catch {}

  const w2 = await c.env.roleplay_db
    .prepare(
      `SELECT coins, plan, plan_expires_at FROM wallets WHERE user_id=? LIMIT 1`,
    )
    .bind(userId)
    .first<any>();

  return c.json({
    ok: true,
    awarded,
    alreadyClaimed: false,
    day: today,
    wallet: {
      coins: Number(w2?.coins || 0),
      plan: effectivePlan(w2 as any),
    },
  });
});

app.post("/admin/wallet/credit", async (c) => {
  const uid = await requireAuthUid(c);
  const isAdmin = uid && isAdminUid(c.env, uid);
  const hasKey = requireAdminKey(c);

  if (!isAdmin && !hasKey)
    return c.json({ ok: false, error: "admin_only" }, 403);

  const body = await c.req.json().catch(() => ({}));
  const userId = String(body.userId || "").trim();
  const amount = Number(body.amount || 0);
  const reason = String(body.reason || "payment_credit");

  if (!userId || !Number.isFinite(amount) || amount <= 0) {
    return c.json({ ok: false, error: "invalid_fields" }, 400);
  }

  await ensureWallet(c.env, userId);
  await walletCredit(c.env, userId, Math.floor(amount), "payment_credit", {
    reason,
  });

  const w = await c.env.roleplay_db
    .prepare(
      `SELECT coins, plan, plan_expires_at FROM wallets WHERE user_id=? LIMIT 1`,
    )
    .bind(userId)
    .first<any>();

  return c.json({
    ok: true,
    userId,
    wallet: {
      coins: Number(w?.coins || 0),
      plan: effectivePlan(w as any),
    },
  });
});

// ---------------- Create conversation ----------------
app.post("/api/convo/create", async (c) => {
  const userId = await requireUserId(c);
  const rl = await rateLimitOr429(c, userId);
  if (rl) return rl;

  const body = await c.req.json().catch(() => ({}));
  const characterId = (body.characterId || "hara").trim();

  const character = await getCharacter(c.env, characterId);

  const id = crypto.randomUUID();
  const t = nowSec();

  const initState = defaultState();
  initState.story_stage = initialStoryStage(character);

  await c.env.roleplay_db
    .prepare(`
      INSERT INTO conversations
      (id, user_id, character_id, state_json, memory_text, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(id, userId, characterId, JSON.stringify(initState), "", t, t)
    .run();

  return c.json({ ok: true, conversationId: id });
});

// ---------------- Reset conversation ----------------
app.post("/api/convo/reset", async (c) => {
  const userId = await requireUserId(c);
  const rl = await rateLimitOr429(c, userId);
  if (rl) return rl;

  const body = await c.req.json().catch(() => ({}));
  const conversationId = String(body.conversationId || "").trim();
  if (!conversationId)
    return c.json({ ok: false, error: "missing_conversationId" }, 400);

  const convo = await getConversation(c.env, conversationId, userId);
  const character = await getCharacter(c.env, convo.character_id);

  await c.env.roleplay_db
    .prepare(`DELETE FROM messages WHERE conversation_id=?`)
    .bind(conversationId)
    .run();

  const initState = defaultState();
  initState.story_stage = initialStoryStage(character);

  await c.env.roleplay_db
    .prepare(
      `UPDATE conversations SET state_json=?, memory_text=?, updated_at=? WHERE id=? AND user_id=?`,
    )
    .bind(JSON.stringify(initState), "", nowSec(), conversationId, userId)
    .run();

  return c.json({ ok: true });
});

// ---------------- Set conversation mode ----------------
app.post("/api/convo/set-mode", async (c) => {
  const userId = await requireUserId(c);
  const rl = await rateLimitOr429(c, userId);
  if (rl) return rl;

  const body = await c.req.json().catch(() => ({}));
  const conversationId = String(body.conversationId || "").trim();
  const mode = String(body.mode || "").trim();

  // Uncensored disabled hai toh sirf default allow karo
  const allowedModes = UNCENSORED_ENABLED
    ? ["default", "uncensored"]
    : ["default"];

  if (!conversationId || !allowedModes.includes(mode)) {
    return c.json(
      {
        ok: false,
        error: UNCENSORED_ENABLED
          ? "invalid_fields"
          : "uncensored_feature_disabled",
      },
      400,
    );
  }

  await getConversation(c.env, conversationId, userId);

  await c.env.roleplay_db
    .prepare(
      `UPDATE conversations SET model_mode=?, updated_at=? WHERE id=? AND user_id=?`,
    )
    .bind(mode, nowSec(), conversationId, userId)
    .run();

  return c.json({ ok: true, mode });
});

// ---------------- Send user message ----------------
app.post("/api/chat/send", async (c) => {
  const env = c.env;
  const userId = await requireUserId(c);
  const rl = await rateLimitOr429(c, userId);
  if (rl) return rl;

  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    const raw = await c.req.text().catch(() => "");
    return c.json(
      {
        ok: false,
        error: "invalid_json_body",
        raw_preview: raw.slice(0, 120),
      },
      400,
    );
  }

  const conversationId = (body.conversationId || "").trim();
  const text = (body.text || "").trim();
  if (!conversationId || !text)
    return c.json({ ok: false, error: "missing_fields" }, 400);

  const lockToken = crypto.randomUUID();
  const locked = await acquireLock(env, conversationId, lockToken, 25);
  if (!locked)
    return c.json(
      { ok: false, error: "conversation_busy_try_again" },
      429,
    );

  let charged = 0;

  try {
    const convo = await getConversation(env, conversationId, userId);
    const character = await getCharacter(env, convo.character_id);

    // Uncensored disabled - always default mode
    const isUncensored = UNCENSORED_ENABLED
      ? String(convo.model_mode || "default") === "uncensored"
      : false;

    const w0 = await ensureWallet(env, userId);
    const plan = effectivePlan(w0);

    const isFirstAssistant = FIRST_ASSISTANT_MESSAGE_FREE
      ? !(await assistantAlreadyExists(env, conversationId))
      : false;

    const charge = isFirstAssistant
      ? 0
      : COIN_COST_PER_ASSISTANT;

    if (charge > 0) {
      const ok = await walletTryDebit(
        env,
        userId,
        charge,
        "debit_assistant_message",
        {
          conversationId,
          endpoint: "send",
          mode: "default",
        },
      );
      if (!ok) {
        const wNow = await env.roleplay_db
          .prepare(`SELECT coins FROM wallets WHERE user_id=? LIMIT 1`)
          .bind(userId)
          .first<any>();
        return c.json(
          {
            ok: false,
            error: "insufficient_coins",
            required: charge,
            coins: Number(wNow?.coins || 0),
          },
          402,
        );
      }
      charged = charge;
    }

    const history = await getRecentMessages(env, conversationId);

    await env.roleplay_db
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, content, control_json, ts)
         VALUES (?, ?, 'user', ?, NULL, ?)`,
      )
      .bind(crypto.randomUUID(), conversationId, text, nowSec())
      .run();

    const state = JSON.parse(convo.state_json || "{}");

    let relevantBlock = "RELEVANT MEMORIES:\n(none)";
    try {
      const [qVec] = await voyageEmbed(env, [text], "query");
      const hits = await qdrantSearch(
        env,
        qVec,
        qdrantOwnerFilter(userId, convo.character_id, "default"),
        20,
      );
      relevantBlock = buildRelevantMemoriesBlock(hits);
    } catch {
      relevantBlock = "RELEVANT MEMORIES:\n(error loading memories)";
    }

    const storyBlock = buildStoryStageBlock(character, state);
    const extraSystem =
      buildContextSystem(state, convo.memory_text || "", relevantBlock) +
      (storyBlock ? "\n\n" + storyBlock : "");

    const messages = [
      { role: "system", content: character.system_prompt },
      { role: "system", content: character.output_protocol_prompt },
      { role: "system", content: extraSystem },
      ...history,
      { role: "user", content: text },
    ];

    const modelUsed = pickModelForPlan(
      env,
      character.default_model,
      plan,
    );

    const llmReply = await callLLM(env, {
      model: modelUsed,
      messages,
      stream: false,
      thinking: false,
      show_thoughts: false,
    });

    const { story, control: rawControl } = extractControl(llmReply);
    const control = fillDefaults(rawControl);

    if (
      control.state_update &&
      typeof control.state_update === "object"
    ) {
      try {
        delete (control.state_update as any).relation_score;
        delete (control.state_update as any).story_stage;
      } catch {}
      Object.assign(state, control.state_update);
    }

    const curRel = getRelationScore(state);
    const delta = Math.max(
      -3,
      Math.min(3, Math.round(Number(control?.relation_delta ?? 0))),
    );
    setRelationScore(state, curRel + delta);

    progressStoryStage(character, state, control);

    let memory = convo.memory_text || "";
    if (control.memory_write && control.memory_write.trim()) {
      memory = clip(control.memory_write.trim(), MAX_MEMORY_CHARS);
    } else {
      memory = fallbackMemory(memory, text, story);
    }

    await env.roleplay_db
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, content, control_json, ts)
         VALUES (?, ?, 'assistant', ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        conversationId,
        story,
        JSON.stringify(control),
        nowSec(),
      )
      .run();

    await env.roleplay_db
      .prepare(
        `UPDATE conversations SET state_json=?, memory_text=?, updated_at=? WHERE id=? AND user_id=?`,
      )
      .bind(
        JSON.stringify(state),
        memory,
        nowSec(),
        conversationId,
        userId,
      )
      .run();

    try {
      const execCtx = (c as any).executionCtx;
      execCtx?.waitUntil?.(
        processMemoryAsync(env, {
          userId,
          conversationId,
          characterId: convo.character_id,
          worldId: "default",
          model: modelUsed,
          userText: text,
          assistantText: story,
        }),
      );
    } catch {}

    // Occasionally clean old rate limit rows
    try {
      const execCtx = (c as any).executionCtx;
      execCtx?.waitUntil?.(cleanRateLimits(env));
    } catch {}

    const wAfter = await env.roleplay_db
      .prepare(
        `SELECT coins, plan, plan_expires_at FROM wallets WHERE user_id=? LIMIT 1`,
      )
      .bind(userId)
      .first<any>();

    return c.json({
      ok: true,
      storyText: story,
      control,
      relationScore: getRelationScore(state),
      relationTier: getRelationTier(getRelationScore(state)),
      storyStage: state.story_stage || null,
      mode: "default",
      wallet: {
        coins: Number(wAfter?.coins || 0),
        plan: effectivePlan(wAfter as any),
      },
    });
  } catch (e: any) {
    if (charged > 0) {
      try {
        await walletCredit(env, userId, charged, "refund_assistant_fail", {
          conversationId,
        });
      } catch {}
    }
    return c.json({ ok: false, error: String(e?.message || e) }, 500);
  } finally {
    await releaseLock(env, conversationId, lockToken);
  }
});

// ---------------- /api/chat/continue ----------------
app.post("/api/chat/continue", async (c) => {
  const env = c.env;
  const userId = await requireUserId(c);
  const rl = await rateLimitOr429(c, userId);
  if (rl) return rl;

  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const conversationId = (body.conversationId || "").trim();
  if (!conversationId)
    return c.json({ ok: false, error: "missing_conversationId" }, 400);

  const lockToken = crypto.randomUUID();
  const locked = await acquireLock(env, conversationId, lockToken, 25);
  if (!locked)
    return c.json(
      { ok: false, error: "conversation_busy_try_again" },
      429,
    );

  let charged = 0;

  try {
    const convo = await getConversation(env, conversationId, userId);
    const character = await getCharacter(env, convo.character_id);

    const w0 = await ensureWallet(env, userId);
    const plan = effectivePlan(w0);

    const isFirstAssistant = FIRST_ASSISTANT_MESSAGE_FREE
      ? !(await assistantAlreadyExists(env, conversationId))
      : false;

    const charge = isFirstAssistant ? 0 : COIN_COST_PER_ASSISTANT;

    if (charge > 0) {
      const ok = await walletTryDebit(
        env,
        userId,
        charge,
        "debit_assistant_message",
        {
          conversationId,
          endpoint: "continue",
          mode: "default",
        },
      );
      if (!ok) {
        const wNow = await env.roleplay_db
          .prepare(`SELECT coins FROM wallets WHERE user_id=? LIMIT 1`)
          .bind(userId)
          .first<any>();
        return c.json(
          {
            ok: false,
            error: "insufficient_coins",
            required: charge,
            coins: Number(wNow?.coins || 0),
          },
          402,
        );
      }
      charged = charge;
    }

    const history = await getRecentMessages(env, conversationId);
    const state = JSON.parse(convo.state_json || "{}");

    const storyBlock = buildStoryStageBlock(character, state);
    const extraSystem =
      buildContextSystem(
        state,
        convo.memory_text || "",
        "RELEVANT MEMORIES:\n(none)",
      ) +
      "\n\n" +
      continueInstruction(AUTO_LIMIT_DEFAULT) +
      (storyBlock ? "\n\n" + storyBlock : "");

    const messages = [
      { role: "system", content: character.system_prompt },
      { role: "system", content: character.output_protocol_prompt },
      { role: "system", content: extraSystem },
      ...history,
      { role: "user", content: "Continue." },
    ];

    const modelUsed = pickModelForPlan(env, character.default_model, plan);
    const llmReply = await callLLM(env, {
      model: modelUsed,
      messages,
      stream: false,
      thinking: false,
      show_thoughts: false,
    });

    const { story, control: rawControl } = extractControl(llmReply);
    const control = fillDefaults(rawControl);

    if (
      control.state_update &&
      typeof control.state_update === "object"
    ) {
      try {
        delete (control.state_update as any).relation_score;
        delete (control.state_update as any).story_stage;
      } catch {}
      Object.assign(state, control.state_update);
    }

    progressStoryStage(character, state, control);

    let memory = convo.memory_text || "";
    if (control.memory_write && control.memory_write.trim()) {
      memory = clip(control.memory_write.trim(), MAX_MEMORY_CHARS);
    } else {
      memory = fallbackMemory(memory, "(continue)", story);
    }

    await env.roleplay_db
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, content, control_json, ts)
         VALUES (?, ?, 'assistant', ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        conversationId,
        story,
        JSON.stringify(control),
        nowSec(),
      )
      .run();

    await env.roleplay_db
      .prepare(
        `UPDATE conversations SET state_json=?, memory_text=?, updated_at=? WHERE id=? AND user_id=?`,
      )
      .bind(
        JSON.stringify(state),
        memory,
        nowSec(),
        conversationId,
        userId,
      )
      .run();

    const wAfter = await env.roleplay_db
      .prepare(
        `SELECT coins, plan, plan_expires_at FROM wallets WHERE user_id=? LIMIT 1`,
      )
      .bind(userId)
      .first<any>();

    return c.json({
      ok: true,
      storyText: story,
      control,
      relationScore: getRelationScore(state),
      relationTier: getRelationTier(getRelationScore(state)),
      storyStage: state.story_stage || null,
      mode: "default",
      wallet: {
        coins: Number(wAfter?.coins || 0),
        plan: effectivePlan(wAfter as any),
      },
    });
  } catch (e: any) {
    if (charged > 0) {
      try {
        await walletCredit(env, userId, charged, "refund_assistant_fail", {
          conversationId,
        });
      } catch {}
    }
    return c.json({ ok: false, error: String(e?.message || e) }, 500);
  } finally {
    await releaseLock(env, conversationId, lockToken);
  }
});

// ---------------- /api/chat/companion ----------------
app.post("/api/chat/companion", async (c) => {
  const env = c.env;
  const userId = await requireUserId(c);
  const rl = await rateLimitOr429(c, userId);
  if (rl) return rl;

  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const conversationId = (body.conversationId || "").trim();
  if (!conversationId)
    return c.json({ ok: false, error: "missing_conversationId" }, 400);

  const lockToken = crypto.randomUUID();
  const locked = await acquireLock(env, conversationId, lockToken, 25);
  if (!locked)
    return c.json(
      { ok: false, error: "conversation_busy_try_again" },
      429,
    );

  let charged = 0;

  try {
    const convo = await getConversation(env, conversationId, userId);
    const character = await getCharacter(env, convo.character_id);

    const w0 = await ensureWallet(env, userId);
    const plan = effectivePlan(w0);

    const isFirstAssistant = FIRST_ASSISTANT_MESSAGE_FREE
      ? !(await assistantAlreadyExists(env, conversationId))
      : false;

    const charge = isFirstAssistant ? 0 : COIN_COST_PER_ASSISTANT;

    if (charge > 0) {
      const ok = await walletTryDebit(
        env,
        userId,
        charge,
        "debit_assistant_message",
        {
          conversationId,
          endpoint: "companion",
          mode: "default",
        },
      );
      if (!ok) {
        const wNow = await env.roleplay_db
          .prepare(`SELECT coins FROM wallets WHERE user_id=? LIMIT 1`)
          .bind(userId)
          .first<any>();
        return c.json(
          {
            ok: false,
            error: "insufficient_coins",
            required: charge,
            coins: Number(wNow?.coins || 0),
          },
          402,
        );
      }
      charged = charge;
    }

    const history = await getRecentMessages(env, conversationId);
    const state = JSON.parse(convo.state_json || "{}");

    const storyBlock = buildStoryStageBlock(character, state);
    const extraSystem =
      buildContextSystem(
        state,
        convo.memory_text || "",
        "RELEVANT MEMORIES:\n(none)",
      ) +
      "\n\n" +
      companionInstruction() +
      (storyBlock ? "\n\n" + storyBlock : "");

    const messages = [
      { role: "system", content: character.system_prompt },
      { role: "system", content: character.output_protocol_prompt },
      { role: "system", content: extraSystem },
      ...history,
      { role: "user", content: "Companion beat." },
    ];

    const modelUsed = pickModelForPlan(env, character.default_model, plan);
    const llmReply = await callLLM(env, {
      model: modelUsed,
      messages,
      stream: false,
      thinking: false,
      show_thoughts: false,
    });

    const { story, control: rawControl } = extractControl(llmReply);
    const control = fillDefaults(rawControl);

    control.continue_story = false;
    control.ui_hint = "your_turn";

    if (
      control.state_update &&
      typeof control.state_update === "object"
    ) {
      try {
        delete (control.state_update as any).relation_score;
        delete (control.state_update as any).story_stage;
      } catch {}
      Object.assign(state, control.state_update);
    }

    progressStoryStage(character, state, control);

    let memory = convo.memory_text || "";
    if (control.memory_write && control.memory_write.trim()) {
      memory = clip(control.memory_write.trim(), MAX_MEMORY_CHARS);
    } else {
      memory = fallbackMemory(memory, "(companion)", story);
    }

    await env.roleplay_db
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, content, control_json, ts)
         VALUES (?, ?, 'assistant', ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        conversationId,
        story,
        JSON.stringify(control),
        nowSec(),
      )
      .run();

    await env.roleplay_db
      .prepare(
        `UPDATE conversations SET state_json=?, memory_text=?, updated_at=? WHERE id=? AND user_id=?`,
      )
      .bind(
        JSON.stringify(state),
        memory,
        nowSec(),
        conversationId,
        userId,
      )
      .run();

    const wAfter = await env.roleplay_db
      .prepare(
        `SELECT coins, plan, plan_expires_at FROM wallets WHERE user_id=? LIMIT 1`,
      )
      .bind(userId)
      .first<any>();

    return c.json({
      ok: true,
      storyText: story,
      control,
      relationScore: getRelationScore(state),
      relationTier: getRelationTier(getRelationScore(state)),
      storyStage: state.story_stage || null,
      mode: "default",
      wallet: {
        coins: Number(wAfter?.coins || 0),
        plan: effectivePlan(wAfter as any),
      },
    });
  } catch (e: any) {
    if (charged > 0) {
      try {
        await walletCredit(env, userId, charged, "refund_assistant_fail", {
          conversationId,
        });
      } catch {}
    }
    return c.json({ ok: false, error: String(e?.message || e) }, 500);
  } finally {
    await releaseLock(env, conversationId, lockToken);
  }
});

// ---------------- Conversation list ----------------
app.get("/api/convo/list", async (c) => {
  const userId = await requireUserId(c);
  const rl = await rateLimitOr429(c, userId);
  if (rl) return rl;

  const url = new URL(c.req.url);
  const limit = Math.min(
    parseInt(url.searchParams.get("limit") || "30", 10) || 30,
    100,
  );

  const res = await c.env.roleplay_db
    .prepare(`
      SELECT id, character_id, updated_at, created_at
      FROM conversations
      WHERE user_id=?
      ORDER BY updated_at DESC
      LIMIT ?
    `)
    .bind(userId, limit)
    .all<any>();

  return c.json({ ok: true, conversations: res.results || [] });
});

// ---------------- Get history ----------------
app.get("/api/chat/history", async (c) => {
  const userId = await requireUserId(c);
  const rl = await rateLimitOr429(c, userId);
  if (rl) return rl;

  const url = new URL(c.req.url);
  const conversationId = (
    url.searchParams.get("conversationId") || ""
  ).trim();
  const limit = Math.min(
    parseInt(url.searchParams.get("limit") || "50", 10) || 50,
    200,
  );

  if (!conversationId)
    return c.json({ ok: false, error: "missing_conversationId" }, 400);

  const convo = await getConversation(c.env, conversationId, userId);

  const msgRes = await c.env.roleplay_db
    .prepare(`
      SELECT role, content, control_json, ts
      FROM messages
      WHERE conversation_id=?
      ORDER BY ts DESC
      LIMIT ?
    `)
    .bind(conversationId, limit)
    .all<any>();

  const messages = (msgRes.results || []).reverse().map((m: any) => ({
    role: m.role,
    content: m.content,
    ts: m.ts,
    control: m.control_json
      ? (() => {
          try {
            return JSON.parse(m.control_json);
          } catch {
            return null;
          }
        })()
      : null,
  }));

  let stateObj: any = {};
  try {
    stateObj = JSON.parse(convo.state_json || "{}");
  } catch {}

  const relationScore = getRelationScore(stateObj);
  const modelMode = "default";

  let stageTitle: string | null = null;
  try {
    const character = await getCharacter(c.env, convo.character_id);
    const map = parseStoryMap(character);
    const stage = getStageById(map, stateObj.story_stage);
    stageTitle = stage?.title || null;
  } catch {}

  return c.json({
    ok: true,
    conversation: {
      id: convo.id,
      characterId: convo.character_id,
      state: stateObj,
      memory: convo.memory_text || "",
      updated_at: convo.updated_at,
      relationScore,
      relationTier: getRelationTier(relationScore),
      storyStage: stateObj.story_stage || null,
      storyStageTitle: stageTitle,
      modelMode,
    },
    messages,
  });
});

// ---------------- Delete conversation ----------------
app.post("/api/convo/delete", async (c) => {
  const userId = await requireUserId(c);
  const rl = await rateLimitOr429(c, userId);
  if (rl) return rl;

  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const conversationId = (body.conversationId || "").trim();
  if (!conversationId)
    return c.json({ ok: false, error: "missing_conversationId" }, 400);

  await getConversation(c.env, conversationId, userId);

  await c.env.roleplay_db
    .prepare(`DELETE FROM messages WHERE conversation_id=?`)
    .bind(conversationId)
    .run();

  await c.env.roleplay_db
    .prepare(`DELETE FROM conversations WHERE id=? AND user_id=?`)
    .bind(conversationId, userId)
    .run();

  return c.json({ ok: true });
});

// ================== RAZORPAY: COINS ==================
function btoaFix(input: string) {
  return btoa(input);
}

function razorpayAuthHeader(env: Env) {
  return `Basic ${btoaFix(env.RAZORPAY_KEY_ID + ":" + env.RAZORPAY_KEY_SECRET)}`;
}

function hmacSha256Hex(input: string, secret: string) {
  return nodeCrypto
    .createHmac("sha256", secret)
    .update(input)
    .digest("hex");
}

app.post("/api/payment/coins/create-order", async (c) => {
  const env = c.env;
  const userId = await requireUserId(c);
  const rl = await rateLimitOr429(c, userId);
  if (rl) return rl;

  const body = await c.req.json().catch(() => ({}));
  const rupees = Number(body.rupees);

  const coins = COIN_PACKS[rupees];
  if (!coins) return c.json({ ok: false, error: "invalid_pack" }, 400);

  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    return c.json({ ok: false, error: "razorpay_keys_missing" }, 500);
  }

  const amountPaise = rupees * 100;
  const receipt = `COINS_${userId.substring(0, 8)}_${Date.now()}`;

  const r = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: razorpayAuthHeader(env),
    },
    body: JSON.stringify({
      amount: amountPaise,
      currency: "INR",
      receipt,
      payment_capture: 1,
    }),
  });

  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) {
    return c.json(
      { ok: false, error: "razorpay_order_failed", detail: data },
      500,
    );
  }

  const orderId = data.id as string;
  const t = nowSec();

  await env.roleplay_db
    .prepare(
      `INSERT INTO payment_orders (order_id, user_id, rupees, coins, status, created_at)
       VALUES (?, ?, ?, ?, 'created', ?)`,
    )
    .bind(orderId, userId, rupees, coins, t)
    .run();

  return c.json({
    ok: true,
    orderId,
    amount: data.amount,
    currency: data.currency,
    coins,
    keyId: env.RAZORPAY_KEY_ID,
  });
});

app.post("/api/payment/coins/verify", async (c) => {
  const env = c.env;
  const userId = await requireUserId(c);
  const rl = await rateLimitOr429(c, userId);
  if (rl) return rl;

  const body = await c.req.json().catch(() => ({}));
  const orderId = String(body.razorpay_order_id || "").trim();
  const paymentId = String(body.razorpay_payment_id || "").trim();
  const signature = String(body.razorpay_signature || "").trim();

  if (!orderId || !paymentId || !signature) {
    return c.json({ ok: false, error: "missing_fields" }, 400);
  }

  const expected = hmacSha256Hex(
    `${orderId}|${paymentId}`,
    env.RAZORPAY_KEY_SECRET,
  );
  if (expected !== signature) {
    return c.json({ ok: false, error: "invalid_signature" }, 400);
  }

  const order = await env.roleplay_db
    .prepare(`SELECT * FROM payment_orders WHERE order_id=? LIMIT 1`)
    .bind(orderId)
    .first<any>();

  if (!order) return c.json({ ok: false, error: "order_not_found" }, 404);
  if (order.user_id !== userId)
    return c.json({ ok: false, error: "order_mismatch" }, 403);

  if (order.status === "paid") {
    const w = await ensureWallet(env, userId);
    return c.json({
      ok: true,
      alreadyProcessed: true,
      coins: Number(w.coins || 0),
    });
  }

  const coinsToAdd = Number(order.coins || 0);

  await env.roleplay_db
    .prepare(
      `UPDATE payment_orders SET status='paid', payment_id=?, signature=?, paid_at=? WHERE order_id=?`,
    )
    .bind(paymentId, signature, nowSec(), orderId)
    .run();

  await ensureWallet(env, userId);
  await walletCredit(env, userId, coinsToAdd, "razorpay_coins_purchase", {
    orderId,
    paymentId,
  });

  const w2 = await env.roleplay_db
    .prepare(`SELECT coins FROM wallets WHERE user_id=? LIMIT 1`)
    .bind(userId)
    .first<any>();

  return c.json({
    ok: true,
    coinsAdded: coinsToAdd,
    coins: Number(w2?.coins || 0),
  });
});

// ================== ADMIN: USERS LIST ==================
app.get("/admin/users/list", async (c) => {
  const uid = await requireAuthUid(c);
  if (!isAdminRequest(c, uid)) return c.json({ ok: false, error: "admin_only" }, 403);

  const page = parseInt(c.req.query("page") || "0", 10) || 0;
  const limit = 20;
  const offset = page * limit;
  const search = (c.req.query("search") || "").trim();

  let rows, total;

  if (search) {
    const res = await c.env.roleplay_db
      .prepare(`
        SELECT w.user_id, w.coins, w.plan, w.plan_expires_at,
               w.last_daily_claim_key, w.created_at, w.updated_at,
               (SELECT COUNT(*) FROM conversations cv WHERE cv.user_id = w.user_id) as convo_count,
               (SELECT COUNT(*) FROM messages m 
                JOIN conversations cv2 ON cv2.id = m.conversation_id 
                WHERE cv2.user_id = w.user_id AND m.role='assistant') as msg_count
        FROM wallets w
        WHERE w.user_id LIKE ?
        ORDER BY w.created_at DESC
        LIMIT ? OFFSET ?
      `)
      .bind(`%${search}%`, limit, offset)
      .all<any>();
    rows = res.results || [];

    const tot = await c.env.roleplay_db
      .prepare(`SELECT COUNT(*) as cnt FROM wallets WHERE user_id LIKE ?`)
      .bind(`%${search}%`)
      .first<any>();
    total = Number(tot?.cnt || 0);
  } else {
    const res = await c.env.roleplay_db
      .prepare(`
        SELECT w.user_id, w.coins, w.plan, w.plan_expires_at,
               w.last_daily_claim_key, w.created_at, w.updated_at,
               (SELECT COUNT(*) FROM conversations cv WHERE cv.user_id = w.user_id) as convo_count,
               (SELECT COUNT(*) FROM messages m 
                JOIN conversations cv2 ON cv2.id = m.conversation_id 
                WHERE cv2.user_id = w.user_id AND m.role='assistant') as msg_count
        FROM wallets w
        ORDER BY w.created_at DESC
        LIMIT ? OFFSET ?
      `)
      .bind(limit, offset)
      .all<any>();
    rows = res.results || [];

    const tot = await c.env.roleplay_db
      .prepare(`SELECT COUNT(*) as cnt FROM wallets`)
      .first<any>();
    total = Number(tot?.cnt || 0);
  }

  return c.json({ ok: true, users: rows, total, page, limit });
});

// ================== ADMIN: USER DETAIL ==================
app.get("/admin/users/detail", async (c) => {
  const uid = await requireAuthUid(c);
  if (!isAdminRequest(c, uid)) return c.json({ ok: false, error: "admin_only" }, 403);

  const userId = (c.req.query("userId") || "").trim();
  if (!userId) return c.json({ ok: false, error: "missing_userId" }, 400);

  // Wallet
  const wallet = await c.env.roleplay_db
    .prepare(`SELECT * FROM wallets WHERE user_id=? LIMIT 1`)
    .bind(userId)
    .first<any>();

  if (!wallet) return c.json({ ok: false, error: "user_not_found" }, 404);

  // Conversations
  const convos = await c.env.roleplay_db
    .prepare(`
      SELECT cv.id, cv.character_id, cv.created_at, cv.updated_at, cv.model_mode,
             ch.name as character_name,
             (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = cv.id) as msg_count
      FROM conversations cv
      LEFT JOIN characters ch ON ch.id = cv.character_id
      WHERE cv.user_id = ?
      ORDER BY cv.updated_at DESC
      LIMIT 30
    `)
    .bind(userId)
    .all<any>();

  // Ledger (last 20 transactions)
  const ledger = await c.env.roleplay_db
    .prepare(`
      SELECT id, amount, type, meta_json, ts
      FROM wallet_ledger
      WHERE user_id = ?
      ORDER BY ts DESC
      LIMIT 20
    `)
    .bind(userId)
    .all<any>();

  // Payments
  const payments = await c.env.roleplay_db
    .prepare(`
      SELECT order_id, rupees, coins, status, created_at, paid_at, payment_id
      FROM payment_orders
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 20
    `)
    .bind(userId)
    .all<any>();

  // Stats
  const stats = await c.env.roleplay_db
    .prepare(`
      SELECT 
        COUNT(DISTINCT cv.id) as total_convos,
        COUNT(CASE WHEN m.role='assistant' THEN 1 END) as total_ai_msgs,
        COUNT(CASE WHEN m.role='user' THEN 1 END) as total_user_msgs
      FROM conversations cv
      LEFT JOIN messages m ON m.conversation_id = cv.id
      WHERE cv.user_id = ?
    `)
    .bind(userId)
    .first<any>();

  return c.json({
    ok: true,
    wallet,
    conversations: convos.results || [],
    ledger: ledger.results || [],
    payments: payments.results || [],
    stats,
  });
});

// ================== ADMIN: CONVERSATION CHAT HISTORY ==================
app.get("/admin/convo/history", async (c) => {
  const uid = await requireAuthUid(c);
  if (!isAdminRequest(c, uid)) return c.json({ ok: false, error: "admin_only" }, 403);

  const convoId = (c.req.query("convoId") || "").trim();
  if (!convoId) return c.json({ ok: false, error: "missing_convoId" }, 400);

  const convo = await c.env.roleplay_db
    .prepare(`SELECT * FROM conversations WHERE id=? LIMIT 1`)
    .bind(convoId)
    .first<any>();

  if (!convo) return c.json({ ok: false, error: "convo_not_found" }, 404);

  const msgs = await c.env.roleplay_db
    .prepare(`
      SELECT role, content, ts, control_json
      FROM messages
      WHERE conversation_id = ?
      ORDER BY ts ASC
      LIMIT 200
    `)
    .bind(convoId)
    .all<any>();

  return c.json({
    ok: true,
    conversation: convo,
    messages: msgs.results || [],
  });
});

// ================== ADMIN: OVERALL STATS ==================
app.get("/admin/stats/overview", async (c) => {
  const uid = await requireAuthUid(c);
  if (!isAdminRequest(c, uid)) return c.json({ ok: false, error: "admin_only" }, 403);

  const totalUsers = await c.env.roleplay_db
    .prepare(`SELECT COUNT(*) as cnt FROM wallets`)
    .first<any>();

  const totalConvos = await c.env.roleplay_db
    .prepare(`SELECT COUNT(*) as cnt FROM conversations`)
    .first<any>();

  const totalMsgs = await c.env.roleplay_db
    .prepare(`SELECT COUNT(*) as cnt FROM messages WHERE role='assistant'`)
    .first<any>();

  const totalCoinsInCirculation = await c.env.roleplay_db
    .prepare(`SELECT SUM(coins) as total FROM wallets`)
    .first<any>();

  const totalRevenue = await c.env.roleplay_db
    .prepare(`SELECT SUM(rupees) as total FROM payment_orders WHERE status='paid'`)
    .first<any>();

  const totalPayments = await c.env.roleplay_db
    .prepare(`SELECT COUNT(*) as cnt FROM payment_orders WHERE status='paid'`)
    .first<any>();

  // Today stats (IST)
  const nowMs = Date.now() + 330 * 60 * 1000;
  const todayStart = new Date(nowMs);
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayStartSec = Math.floor((todayStart.getTime() - 330 * 60 * 1000) / 1000);

  const todayUsers = await c.env.roleplay_db
    .prepare(`SELECT COUNT(*) as cnt FROM wallets WHERE created_at >= ?`)
    .bind(todayStartSec)
    .first<any>();

  const todayMsgs = await c.env.roleplay_db
    .prepare(`SELECT COUNT(*) as cnt FROM messages WHERE role='assistant' AND ts >= ?`)
    .bind(todayStartSec)
    .first<any>();

  const todayRevenue = await c.env.roleplay_db
    .prepare(`SELECT SUM(rupees) as total FROM payment_orders WHERE status='paid' AND paid_at >= ?`)
    .bind(todayStartSec)
    .first<any>();

  return c.json({
    ok: true,
    stats: {
      total_users: Number(totalUsers?.cnt || 0),
      total_convos: Number(totalConvos?.cnt || 0),
      total_ai_messages: Number(totalMsgs?.cnt || 0),
      total_coins_in_circulation: Number(totalCoinsInCirculation?.total || 0),
      total_revenue_inr: Number(totalRevenue?.total || 0),
      total_paid_orders: Number(totalPayments?.cnt || 0),
      today_new_users: Number(todayUsers?.cnt || 0),
      today_ai_messages: Number(todayMsgs?.cnt || 0),
      today_revenue_inr: Number(todayRevenue?.total || 0),
    },
  });
});

export default {
  fetch: (req: Request, env: Env, ctx: any) => app.fetch(req, env, ctx),
};
