import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loginOpenAICodex, refreshOpenAICodexToken } from "@gsd/pi-ai/oauth";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@gsd/pi-tui";

const REFRESH_MS = 5 * 60 * 1000;
const DEFAULT_WHAM_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const FIVE_HOURS_SECONDS = 18_000;
const WEEK_SECONDS = 604_800;

const OPENAI_CODEX_PROVIDER = "openai-codex";
const OPENAI_MULTI_ACCOUNTS_KEY = "__openaiMultiAccounts";
const OPENAI_ACTIVE_ACCOUNT_ID_KEY = "__openaiActiveAccountId";
const OPENAI_SWAP_STATUS_KEY = "openai-swap";
const STOP_STATUS_KEY = "force-stop";

const DRAG_CACHE_STATUS_KEY = "drag-cache";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const DRAG_CACHE_ROOT = path.join(os.tmpdir(), "gsd-drag-cache");
const DROP_CAPTURE_STALE_MS = 2000;
const MAX_DRAG_CACHES = 8;
const LEGACY_F4_SEQUENCES = new Set(["\x1bOS", "\x1b[14~", "\x1b[[D"]);
const STOP_REQUEST_COOLDOWN_MS = 400;
const STOP_STEER_RETRY_DELAY_MS = 120;
const DROP_PATH_RETRY_ATTEMPTS = 6;
const DROP_PATH_RETRY_ATTEMPTS_EPHEMERAL = 120;
const DROP_PATH_RETRY_DELAY_MS = 25;
const INLINE_PAYLOAD_CAPTURE_STALE_MS = 6000;
const INLINE_PAYLOAD_CAPTURE_MAX_CHARS = 4_000_000;
const DRAFT_RECONCILE_INTERVAL_MS = 250;
const DRAFT_RECONCILE_MIN_GAP_MS = 300;

// Clipboard image (Cmd/Ctrl+V) handling intentionally disabled.
// User requested to keep path/drag marker flow, but remove clipboard-image flow entirely.
const ENABLE_CLIPBOARD_IMAGE_FLOW = false;

const MARKER_PATTERN = /\[(?:Image|File) ?#\d+\]|\[Image-(?:ClipBoard|Clipboard)#\d+\]/g;
// Path token eşleşmesini whitespace/start boundary ile sınırla.
// Böylece base64 içindeki "/" parçaları yanlışlıkla dosya yolu sanılmaz.
const PASTED_TOKEN_PATTERN = /(^|[\s\r\n])('(?:[^'\\]|\\.)+'|"(?:[^"\\]|\\.)+"|‘[^’]+’|“[^”]+”|['"“”‘’]?(?:~|\/|\.\.?\/)(?:\\.|[^\s'"“”‘’])+['"“”‘’]?)/g;

const IMAGE_MIME_BY_EXT = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"],
  [".tif", "image/tiff"],
  [".tiff", "image/tiff"],
  [".heic", "image/heic"],
  [".heif", "image/heif"],
]);

const IMAGE_EXT_BY_MIME = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["image/bmp", "bmp"],
  ["image/tiff", "tiff"],
  ["image/heic", "heic"],
  ["image/heif", "heif"],
]);

function sanitizeStatusText(text) {
  return String(text).replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function isF4Input(data) {
  if (typeof data !== "string" || data.length === 0) return false;
  if (matchesKey(data, Key.f4)) return true;
  return LEGACY_F4_SEQUENCES.has(data);
}

function isEscapeInput(data) {
  // Escape shortcut'ı sadece tek ESC tuş vuruşunda çalışsın.
  // Bracketed paste başlangıcı (\x1b[200~) gibi ESC ile başlayan akışları stop'a çevirmemeliyiz.
  return typeof data === "string" && data === "\x1b";
}

function isForceStopInput(data) {
  return isEscapeInput(data) || isF4Input(data);
}

function formatTokens(count) {
  if (!Number.isFinite(count) || count <= 0) return "0";
  if (count < 1000) return String(Math.round(count));
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function formatUsd(v) {
  if (!Number.isFinite(v)) return "?";
  if (v < 1) return `$${v.toFixed(3)}`;
  if (v < 1000) return `$${v.toFixed(2)}`;
  return `$${Math.round(v).toLocaleString()}`;
}

function isOpenAIModel(model) {
  const provider = String(model?.provider || "").toLowerCase().trim();
  const modelId = String(model?.id || "").toLowerCase().trim();

  if (provider.includes("openai") || provider.includes("codex")) return true;

  // Some integrations omit provider but still use OpenAI model IDs.
  if (!provider) {
    if (modelId.startsWith("gpt-")) return true;
    if (/^o[1-9](?:$|-)/.test(modelId)) return true;
    if (modelId.startsWith("codex")) return true;
  }

  return false;
}

function isOpenAICodexModel(model) {
  return String(model?.provider || "").toLowerCase().trim() === OPENAI_CODEX_PROVIDER;
}

function providerDisplayName(provider) {
  const p = String(provider || "").toLowerCase();
  if (!p) return "unknown";
  if (p === "openai") return "OpenAI";
  if (p === OPENAI_CODEX_PROVIDER) return "OpenAI Codex";
  return provider;
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function makeBar(percent, size = 8) {
  const clamped = clampPercent(percent);
  const filled = Math.round((clamped / 100) * size);
  return `${"█".repeat(filled)}${"░".repeat(Math.max(0, size - filled))}`;
}

function normalizeAuthorizationHeader(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  return /^bearer\s+/i.test(value) ? value : `Bearer ${value}`;
}

async function resolveAuthorizationHeader(ctx, model) {
  const explicit =
    process.env.CHATGPT_WHAM_AUTHORIZATION ||
    process.env.CHATGPT_AUTHORIZATION ||
    process.env.OPENAI_WHAM_AUTHORIZATION ||
    "";

  if (explicit) return normalizeAuthorizationHeader(explicit);

  try {
    if (ctx?.modelRegistry && model) {
      const token = await ctx.modelRegistry.getApiKey(model);
      if (token) return normalizeAuthorizationHeader(token);
    }
  } catch {
    // ignore and fall through
  }

  return "";
}

function decodeJwtPayload(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length < 2) return null;

    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padLen = (4 - (b64.length % 4)) % 4;
    const padded = b64 + "=".repeat(padLen);
    const json = Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function extractAccountIdFromAuthorization(authorization) {
  const value = String(authorization || "").trim();
  if (!value) return "";

  const token = value.replace(/^bearer\s+/i, "").trim();
  if (!token) return "";

  const payload = decodeJwtPayload(token);
  const claim = payload?.["https://api.openai.com/auth"];
  const accountId = claim?.chatgpt_account_id;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : "";
}

function extractAccountIdFromModel(model) {
  if (!model) return "";

  const headers = model?.headers || {};
  const fromHeader =
    headers["chatgpt-account-id"] ||
    headers["ChatGPT-Account-Id"] ||
    headers["x-openai-account-id"] ||
    headers["X-OpenAI-Account-Id"];

  if (typeof fromHeader === "string" && fromHeader.trim()) return fromHeader.trim();

  const providerOptions = model?.providerOptions || {};
  const fromOptions =
    providerOptions.chatgpt_account_id ||
    providerOptions.chatgptAccountId ||
    providerOptions.account_id ||
    providerOptions.accountId;

  if (typeof fromOptions === "string" && fromOptions.trim()) return fromOptions.trim();

  return "";
}

function resolveAccountIdHeader({ model, authorization }) {
  const explicit = process.env.CHATGPT_ACCOUNT_ID || process.env.CHATGPT_WHAM_ACCOUNT_ID || "";
  if (explicit) return explicit;

  const fromModel = extractAccountIdFromModel(model);
  if (fromModel) return fromModel;

  return extractAccountIdFromAuthorization(authorization);
}

function resolveUserAgent() {
  if (process.env.CHATGPT_USER_AGENT) return process.env.CHATGPT_USER_AGENT;

  const osSegment = process.platform === "darwin"
    ? "Macintosh; Intel Mac OS X 10_15_7"
    : process.platform === "win32"
      ? "Windows NT 10.0; Win64; x64"
      : "X11; Linux x86_64";

  return `Mozilla/5.0 (${osSegment}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36`;
}

function toImageMimeType(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  return IMAGE_MIME_BY_EXT.get(ext) || "";
}

function normalizeImageMimeType(rawMimeType) {
  const mimeType = String(rawMimeType || "").trim().toLowerCase();
  return mimeType.startsWith("image/") ? mimeType : "";
}

function toImageExtFromMimeType(rawMimeType) {
  const mimeType = normalizeImageMimeType(rawMimeType);
  return IMAGE_EXT_BY_MIME.get(mimeType) || "";
}

function sniffImageMimeTypeFromBuffer(buffer) {
  if (!buffer || buffer.length < 4) return "";

  // PNG
  if (
    buffer.length >= 8
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
    && buffer[4] === 0x0d
    && buffer[5] === 0x0a
    && buffer[6] === 0x1a
    && buffer[7] === 0x0a
  ) return "image/png";

  // JPEG
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";

  // GIF
  if (
    buffer.length >= 6
    && buffer[0] === 0x47
    && buffer[1] === 0x49
    && buffer[2] === 0x46
    && buffer[3] === 0x38
  ) return "image/gif";

  // WEBP (RIFF....WEBP)
  if (
    buffer.length >= 12
    && buffer[0] === 0x52
    && buffer[1] === 0x49
    && buffer[2] === 0x46
    && buffer[3] === 0x46
    && buffer[8] === 0x57
    && buffer[9] === 0x45
    && buffer[10] === 0x42
    && buffer[11] === 0x50
  ) return "image/webp";

  // BMP
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return "image/bmp";

  // TIFF
  if (
    (buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00)
    || (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a)
  ) return "image/tiff";

  // HEIC/HEIF: ....ftypheic/heif
  if (
    buffer.length >= 12
    && buffer[4] === 0x66
    && buffer[5] === 0x74
    && buffer[6] === 0x79
    && buffer[7] === 0x70
  ) {
    const brand = buffer.toString("ascii", 8, 12).toLowerCase();
    if (brand.startsWith("hei")) return "image/heic";
    if (brand.startsWith("mif") || brand.startsWith("heif")) return "image/heif";
  }

  return "";
}

function decodeBase64ImagePayload(rawBase64, mimeHint = "") {
  const normalized = String(rawBase64 || "").replace(/\s+/g, "");
  if (!normalized || normalized.length < 128) return null;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(normalized)) return null;

  let buffer;
  try {
    buffer = Buffer.from(normalized, "base64");
  } catch {
    return null;
  }

  if (!buffer || buffer.length === 0) return null;

  const sniffedMimeType = sniffImageMimeTypeFromBuffer(buffer);
  const safeMimeHint = normalizeImageMimeType(mimeHint);
  const mimeType = safeMimeHint || sniffedMimeType;
  if (!mimeType) return null;

  const ext = toImageExtFromMimeType(mimeType) || "png";
  return { buffer, mimeType, ext };
}

function decodeInlineImageDataCandidate(rawValue, rawMimeHint) {
  const mimeHint = normalizeImageMimeType(rawMimeHint);

  if (rawValue && typeof rawValue === "object" && rawValue.type === "Buffer" && Array.isArray(rawValue.data)) {
    try {
      const buffer = Buffer.from(rawValue.data);
      if (buffer.length > 0) {
        const sniffed = sniffImageMimeTypeFromBuffer(buffer);
        const mimeType = mimeHint || sniffed;
        if (!mimeType) return null;
        const ext = toImageExtFromMimeType(mimeType) || "png";
        return { buffer, mimeType, ext };
      }
    } catch {
      return null;
    }
  }

  if (typeof rawValue !== "string") return null;

  const value = rawValue.trim();
  if (!value) return null;

  const dataUrlMatch = value.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=_-]+)$/i);
  if (dataUrlMatch) {
    const decoded = decodeBase64ImagePayload(dataUrlMatch[2], dataUrlMatch[1] || mimeHint);
    if (!decoded) return null;
    return decoded;
  }

  return decodeBase64ImagePayload(value, mimeHint);
}

function normalizeMaybeEscapedJsonText(raw) {
  const text = String(raw || "");
  if (!text) return "";

  let normalized = text;

  // "{\"ok\":true,...}" gibi çift-escape edilmiş JSON payload'larını normalize et.
  if (/\\"(?:ok|b64|base64|mime(?:Type)?|data)\\"/i.test(normalized)) {
    normalized = normalized
      .replace(/\\"/g, '"')
      .replace(/\\\//g, "/")
      .replace(/\\n/g, "")
      .replace(/\\r/g, "");
  }

  return normalized;
}

function extractImagePayloadFromJsonLikeText(text) {
  const normalized = normalizeMaybeEscapedJsonText(text);

  const dataUrlMatch = normalized.match(/data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=_-]{128,})/i);
  if (dataUrlMatch) {
    return decodeBase64ImagePayload(dataUrlMatch[2], dataUrlMatch[1]);
  }

  const mimeMatch = normalized.match(/"(?:mime(?:Type)?|contentType)"\s*:\s*"([^"]+)"/i);
  const mimeHint = normalizeImageMimeType(mimeMatch?.[1] || "");

  const b64FieldRegex = /"(?:b64|base64|data|imageData|payload)"\s*:\s*"([^"]{128,})"/ig;
  let match;
  while ((match = b64FieldRegex.exec(normalized)) != null) {
    const candidate = String(match[1] || "")
      .replace(/\\\//g, "/")
      .replace(/\\n/g, "")
      .replace(/\\r/g, "")
      .trim();

    const decoded = decodeBase64ImagePayload(candidate, mimeHint);
    if (decoded) return decoded;
  }

  return null;
}

function extractInlineImagePayloadFromText(text) {
  const raw = String(text || "");
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const normalized = normalizeMaybeEscapedJsonText(trimmed);

  // JSON parse olmasa da alan bazlı regex fallback ile payload yakalamaya çalış.
  const byJsonLikeFields = extractImagePayloadFromJsonLikeText(normalized);
  if (byJsonLikeFields) return byJsonLikeFields;

  if (!(normalized.startsWith("{") || normalized.startsWith("["))) return null;
  if (!/("type"|"mimeType"|"mime"|"data"|"b64"|"base64")/i.test(normalized)) return null;

  let parsed;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    return null;
  }

  // JSON string içinde tekrar JSON gömülmüşse ikinci parse dene.
  if (typeof parsed === "string") {
    const nested = extractInlineImagePayloadFromText(parsed);
    if (nested) return nested;
    return decodeInlineImageDataCandidate(parsed, "");
  }

  const queue = [parsed];
  let visited = 0;

  while (queue.length > 0 && visited < 400) {
    const node = queue.shift();
    visited += 1;

    if (!node || typeof node !== "object") continue;

    if (Array.isArray(node)) {
      for (const item of node) queue.push(item);
      continue;
    }

    const typeHint = String(node.type || node.kind || "").toLowerCase();
    const mimeHint = normalizeImageMimeType(node.mimeType || node.mime || node.contentType || "");
    const isImageHint = typeHint.includes("image") || !!mimeHint;

    const dataCandidates = [node.data, node.b64, node.base64, node.imageData, node.payload];
    for (const candidate of dataCandidates) {
      const decoded = decodeInlineImageDataCandidate(candidate, mimeHint);
      if (!decoded) continue;

      const candidateString = typeof candidate === "string" ? candidate.trim() : "";
      const candidateIsDataUrl = /^data:image\//i.test(candidateString);
      if (!isImageHint && !candidateIsDataUrl) continue;

      return decoded;
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === "object") queue.push(value);
    }
  }

  return null;
}

function extractRawBase64ImagePayloadFromText(text) {
  const raw = String(text || "");
  let trimmed = raw.trim();
  if (!trimmed) return null;

  // Tek parça quote ile sarılmış base64 payload'larda quote'ları kaldır.
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  }

  if (!trimmed) return null;
  return decodeBase64ImagePayload(trimmed, "");
}

function containsLikelyInlineImagePayload(text) {
  if (!ENABLE_CLIPBOARD_IMAGE_FLOW) return false;

  const value = String(text || "");
  if (!value) return false;

  if (/data:image\/[a-z0-9.+-]+;base64,/i.test(value)) return true;
  if (/("type"\s*:\s*"image|"mime(?:Type)?"\s*:\s*"image\/|"(?:data|b64|base64)"\s*:)/i.test(value)) return true;
  if (/(\\"type\\"\s*:\s*\\"image|\\"mime(?:Type)?\\"\s*:\s*\\"image\/|\\"(?:data|b64|base64)\\"\s*:)/i.test(value)) return true;
  if (/[A-Za-z0-9+/=_-]{1024,}/.test(value)) return true;

  return false;
}

function looksLikeInlinePayloadCaptureStart(text) {
  if (!ENABLE_CLIPBOARD_IMAGE_FLOW) return false;

  const trimmed = String(text || "").trim();
  if (!trimmed) return false;

  // Tam payload veya escaped payload başlangıcı
  if (/^\{\s*"ok"\s*:\s*true\b/i.test(trimmed)) return true;
  if (/^\{\s*\\"ok\\"\s*:\s*true\b/i.test(trimmed)) return true;
  if (/^"\{\\"ok\\"\s*:\s*true/i.test(trimmed)) return true;

  if (trimmed === "{" || trimmed === "[" || trimmed === "{\"" || trimmed === "{\\\"") return true;

  // Chunk'lı paste başlangıcı: JSON objesi henüz tamamlanmamış olabilir.
  if (/^\{/.test(trimmed) || /^\{\\"/.test(trimmed)) {
    if (/("ok"|\\"ok\\"|"ext"|\\"ext\\"|"mime(?:Type)?"|\\"mime(?:Type)?\\"|"(?:b64|base64|data)"|\\"(?:b64|base64|data)\\")/i.test(trimmed)) {
      return true;
    }
  }

  // Ham base64 paste (JSON sarmalı yok)
  if (/^[A-Za-z0-9+/=_-]{256,}$/.test(trimmed)) return true;

  return false;
}

function resetInlinePayloadCapture(state) {
  state.inlinePayloadCapture.active = false;
  state.inlinePayloadCapture.buffer = "";
  state.inlinePayloadCapture.startedAt = 0;
  state.inlinePayloadCapture.drainUntil = 0;
}

function tryResolveInlinePayloadCapture(state, ctx, { allowClipboardImage = false } = {}) {
  if (!state.inlinePayloadCapture.active) return null;

  const transformed = transformPasteBody(state, ctx, state.inlinePayloadCapture.buffer, { allowClipboardImage });
  if (transformed?.data) {
    resetInlinePayloadCapture(state);
    return { data: transformed.data };
  }

  // Parse yakalayamadıysa, inline payload sinyali varken clipboard fallback ile marker üret.
  if (containsLikelyInlineImagePayload(state.inlinePayloadCapture.buffer)) {
    const fallback = copyClipboardImageToSessionCache(state, ctx);
    if (fallback) {
      resetInlinePayloadCapture(state);
      return { data: fallback.marker };
    }
  }

  return null;
}

function decodePastedPathToken(rawToken) {
  let token = String(rawToken || "").trim();
  if (!token) return "";

  const quotePairs = [
    ["'", "'"],
    ["\"", "\""],
    ["‘", "’"],
    ["“", "”"],
  ];
  for (const [start, end] of quotePairs) {
    if (token.startsWith(start) && token.endsWith(end) && token.length >= 2) {
      token = token.slice(start.length, token.length - end.length);
      break;
    }
  }

  // Bazı terminallerde token parçalanırken tek taraflı quote kalabiliyor.
  token = token.replace(/^['"‘“]+/, "").replace(/['"’”]+$/, "");

  token = token.replace(/\\([\\\s'\"()\[\]{}])/g, "$1");
  token = token.replace(/[;,]+$/, "");

  if (token.startsWith("~/")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    if (home) token = path.join(home, token.slice(2));
  }

  return token;
}

function looksLikePathToken(decoded) {
  return decoded.startsWith("/") || decoded.startsWith("~/") || decoded.startsWith("./") || decoded.startsWith("../");
}

function containsLikelyImagePath(text) {
  return /(?:^|\s)['"“”‘’]?(?:\/|~\/|\.\.?\/)[^\s'"“”‘’]+\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif)\b/i.test(String(text || ""));
}

function sleepMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  try {
    const sab = new SharedArrayBuffer(4);
    const arr = new Int32Array(sab);
    Atomics.wait(arr, 0, 0, ms);
  } catch {
    // ignore if Atomics.wait is unavailable
  }
}

function buildPathCandidates(decodedPath) {
  const primary = path.resolve(decodedPath);
  const candidates = [primary];

  if (primary.startsWith("/var/")) {
    candidates.push(`/private${primary}`);
  } else if (primary.startsWith("/private/var/")) {
    candidates.push(primary.replace("/private", ""));
  }

  return Array.from(new Set(candidates));
}

function getPathRetryAttempts(absolutePath) {
  const normalized = String(absolutePath || "");
  const isEphemeralTemp = normalized.startsWith("/var/folders/") || normalized.startsWith("/private/var/folders/");
  return isEphemeralTemp ? DROP_PATH_RETRY_ATTEMPTS_EPHEMERAL : DROP_PATH_RETRY_ATTEMPTS;
}

function statPathWithRetry(decodedPath) {
  const candidates = buildPathCandidates(decodedPath);

  const absolute = path.resolve(decodedPath);
  const maxAttempts = getPathRetryAttempts(absolute);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    for (const candidatePath of candidates) {
      try {
        const stat = fs.statSync(candidatePath);
        if (stat.isFile()) {
          return { absolutePath: candidatePath, stat };
        }
      } catch {
        // try next candidate / retry
      }
    }

    if (attempt < maxAttempts - 1) {
      sleepMs(DROP_PATH_RETRY_DELAY_MS);
    }
  }

  return null;
}

function getCurrentSessionId(ctx) {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    return typeof id === "string" && id.trim() ? id.trim() : "default";
  } catch {
    return "default";
  }
}

function sanitizeFileName(name) {
  const base = String(name || "file").replace(/[\n\r\t]/g, " ").trim();
  const collapsed = base.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return collapsed || "file";
}

function createSessionDragCache(sessionId) {
  const id = String(sessionId || "default");
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(DRAG_CACHE_ROOT, `${id}-${unique}`);
  fs.mkdirSync(dir, { recursive: true });

  return {
    sessionId: id,
    dir,
    nextImageIndex: 1,
    nextFileIndex: 1,
    entriesByMarker: new Map(),
    entriesBySourcePath: new Map(),
  };
}

function ensureSessionDragCache(state, ctx) {
  const sessionId = getCurrentSessionId(ctx);
  state.activeSessionId = sessionId;

  if (!state.dragCacheBySessionId.has(sessionId)) {
    const cache = createSessionDragCache(sessionId);
    state.dragCacheBySessionId.set(sessionId, cache);
    pruneOldDragCaches(state, sessionId);
  }

  return state.dragCacheBySessionId.get(sessionId);
}

function pruneOldDragCaches(state, keepSessionId) {
  if (state.dragCacheBySessionId.size <= MAX_DRAG_CACHES) return;

  for (const [sessionId, cache] of state.dragCacheBySessionId.entries()) {
    if (state.dragCacheBySessionId.size <= MAX_DRAG_CACHES) break;
    if (sessionId === keepSessionId) continue;

    try {
      fs.rmSync(cache.dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }

    state.dragCacheBySessionId.delete(sessionId);
  }
}

function getDragCachesInResolutionOrder(state, ctx) {
  const ordered = [];
  const active = ensureSessionDragCache(state, ctx);
  if (active) ordered.push(active);

  for (const cache of state.dragCacheBySessionId.values()) {
    if (cache !== active) ordered.push(cache);
  }

  return ordered;
}

function findDragEntryByMarker(state, ctx, marker) {
  for (const cache of getDragCachesInResolutionOrder(state, ctx)) {
    const entry = cache.entriesByMarker.get(marker);
    if (entry) return { cache, entry };
  }
  return null;
}

function resolveImageSourcePathWithRetry(sourcePath) {
  const decoded = decodePastedPathToken(sourcePath);
  if (!decoded || !looksLikePathToken(decoded)) return null;
  return statPathWithRetry(decoded);
}

function copyDroppedPathToSessionCache(state, ctx, rawToken) {
  const decoded = decodePastedPathToken(rawToken);
  if (!decoded || !looksLikePathToken(decoded)) return null;

  const cache = ensureSessionDragCache(state, ctx);
  if (!cache) return null;

  const normalizedSourcePath = path.resolve(decoded);
  const resolved = statPathWithRetry(decoded);
  if (!resolved) return null;

  const { absolutePath, stat } = resolved;
  const existing = cache.entriesBySourcePath.get(absolutePath) || cache.entriesBySourcePath.get(normalizedSourcePath);

  if (existing) {
    const sameFileSnapshot =
      Number(existing.sourceSize) === Number(stat.size)
      && Number(existing.sourceMtimeMs) === Number(stat.mtimeMs)
      && typeof existing.cachedPath === "string"
      && existing.cachedPath.length > 0
      && fs.existsSync(existing.cachedPath);

    if (sameFileSnapshot) return existing;
  }

  const mimeType = toImageMimeType(absolutePath);
  const kind = mimeType ? "image" : "file";
  const marker = existing?.marker
    || (kind === "image" ? `[Image#${cache.nextImageIndex++}]` : `[File#${cache.nextFileIndex++}]`);

  const sourceBase = path.basename(absolutePath);
  const safeBase = sanitizeFileName(sourceBase);
  const stampedName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeBase}`;
  const cachedPath = path.join(cache.dir, stampedName);

  const copyAttempts = getPathRetryAttempts(absolutePath);
  let copied = false;
  for (let attempt = 0; attempt < copyAttempts; attempt += 1) {
    try {
      fs.copyFileSync(absolutePath, cachedPath);
      copied = true;
      break;
    } catch {
      try {
        const buffer = fs.readFileSync(absolutePath);
        if (buffer?.length > 0) {
          fs.writeFileSync(cachedPath, buffer);
          copied = true;
          break;
        }
      } catch {
        // ignore read fallback failure
      }

      if (attempt < copyAttempts - 1) {
        sleepMs(DROP_PATH_RETRY_DELAY_MS);
      }
    }
  }

  if (!copied) return null;

  const entry = {
    marker,
    kind,
    mimeType,
    sourcePath: absolutePath,
    sourceSize: Number(stat.size) || 0,
    sourceMtimeMs: Number(stat.mtimeMs) || 0,
    cachedPath,
    deferred: false,
  };

  cache.entriesByMarker.set(marker, entry);
  cache.entriesBySourcePath.set(normalizedSourcePath, entry);
  cache.entriesBySourcePath.set(absolutePath, entry);
  return entry;
}

function transformDroppedPasteText(state, ctx, pastedText) {
  let transformedCount = 0;
  let attemptedPathCount = 0;
  const markers = [];

  const transformed = String(pastedText || "").replace(
    PASTED_TOKEN_PATTERN,
    (fullMatch, leadingSpace, token) => {
      const decoded = decodePastedPathToken(token);
      const isPathToken = !!decoded && looksLikePathToken(decoded);
      const hintedMimeType = isPathToken ? toImageMimeType(path.resolve(decoded)) : "";

      if (isPathToken) {
        attemptedPathCount += 1;
      }

      const entry = copyDroppedPathToSessionCache(state, ctx, token);
      if (!entry) {
        if (isPathToken && hintedMimeType) {
          // Image path'i promptta ham bırakma: görünür path yerine boşluk bırak.
          return leadingSpace || "";
        }
        return fullMatch;
      }
      transformedCount += 1;
      markers.push(entry.marker);
      return `${leadingSpace || ""}${entry.marker}`;
    },
  );

  if (attemptedPathCount > transformedCount && ctx?.hasUI) {
    if (transformedCount === 0 && /\/var\/folders\//.test(String(pastedText || ""))) {
      ctx.ui.setStatus(DRAG_CACHE_STATUS_KEY, "Drag path yakalandı ama dosya kopyalanamadı (muhtemelen silinmiş)");
    } else {
      ctx.ui.setStatus(
        DRAG_CACHE_STATUS_KEY,
        `Bazı dosyalar çevrilemedi (${transformedCount}/${attemptedPathCount}) · tekrar dene`,
      );
    }
  }

  return { transformed, transformedCount, attemptedPathCount, markers };
}

function readClipboardImageFromSystem() {
  if (process.platform !== "darwin") return null;

  const jxaScript = `ObjC.import('AppKit');
ObjC.import('Foundation');
const pb = $.NSPasteboard.generalPasteboard;
const image = $.NSImage.alloc.initWithPasteboard(pb);
if (!image) {
  console.log(JSON.stringify({ ok: false, reason: 'no-image' }));
} else {
  const tiffData = image.TIFFRepresentation;
  if (!tiffData || Number(tiffData.length) <= 0) {
    console.log(JSON.stringify({ ok: false, reason: 'no-image-data' }));
  } else {
    const rep = $.NSBitmapImageRep.imageRepWithData(tiffData);
    const props = $.NSDictionary.dictionary;
    const pngData = rep ? rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, props) : null;
    const finalData = pngData && Number(pngData.length) > 0 ? pngData : tiffData;
    const b64 = ObjC.unwrap(finalData.base64EncodedStringWithOptions(0));
    console.log(JSON.stringify({ ok: true, ext: 'png', mime: 'image/png', b64 }));
  }
}`;

  let stdout = "";
  try {
    stdout = execFileSync("osascript", ["-l", "JavaScript", "-e", jxaScript], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return null;
  }

  const payload = String(stdout || "")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .at(-1);

  if (!payload) return null;

  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }

  if (!parsed?.ok || !parsed?.b64) return null;

  const ext = String(parsed.ext || "png").replace(/[^a-z0-9]/gi, "").toLowerCase() || "png";
  const mimeType = String(parsed.mime || "image/png") || "image/png";

  let buffer;
  try {
    buffer = Buffer.from(String(parsed.b64), "base64");
  } catch {
    return null;
  }

  if (!buffer || buffer.length === 0) return null;
  return { buffer, ext, mimeType };
}

function writeImageBufferToCacheEntry(cache, entry, { buffer, mimeType, ext, sourcePrefix = "image" } = {}) {
  if (!cache || !entry || !buffer || buffer.length === 0) return false;

  const safeMimeType = normalizeImageMimeType(mimeType) || "image/png";
  const safeExt = String(ext || toImageExtFromMimeType(safeMimeType) || "png")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase() || "png";

  const stampedName = `${sourcePrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${safeExt}`;
  const cachedPath = path.join(cache.dir, stampedName);

  try {
    fs.writeFileSync(cachedPath, buffer);
  } catch {
    return false;
  }

  entry.kind = "image";
  entry.mimeType = safeMimeType;
  entry.sourcePath = "";
  entry.sourceSize = Number(buffer.length) || 0;
  entry.sourceMtimeMs = Date.now();
  entry.cachedPath = cachedPath;
  entry.deferred = false;
  if ("payloadText" in entry) {
    entry.payloadText = "";
  }

  return true;
}

function copyImageBufferToSessionCache(state, ctx, { buffer, mimeType, ext, sourcePrefix = "image" } = {}) {
  if (!buffer || buffer.length === 0) return null;

  const cache = ensureSessionDragCache(state, ctx);
  if (!cache) return null;

  const entry = {
    marker: `[Image#${cache.nextImageIndex++}]`,
    kind: "image",
    mimeType: normalizeImageMimeType(mimeType) || "image/png",
    sourcePath: "",
    sourceSize: 0,
    sourceMtimeMs: Date.now(),
    cachedPath: "",
    deferred: false,
  };

  const written = writeImageBufferToCacheEntry(cache, entry, { buffer, mimeType, ext, sourcePrefix });
  if (!written) return null;

  cache.entriesByMarker.set(entry.marker, entry);
  return entry;
}

function createDeferredInlineImageEntry(state, ctx, payloadText) {
  const cache = ensureSessionDragCache(state, ctx);
  if (!cache) return null;

  const entry = {
    marker: `[Image#${cache.nextImageIndex++}]`,
    kind: "image",
    mimeType: "image/png",
    sourcePath: "",
    sourceSize: 0,
    sourceMtimeMs: Date.now(),
    cachedPath: "",
    deferred: true,
    payloadText: String(payloadText || ""),
  };

  cache.entriesByMarker.set(entry.marker, entry);
  return entry;
}

function materializeDeferredInlineImageEntry(cache, entry) {
  if (!cache || !entry || !entry.deferred) return false;

  const payloadText = String(entry.payloadText || "");
  if (!payloadText) return false;

  const payload = extractInlineImagePayloadFromText(payloadText)
    || extractRawBase64ImagePayloadFromText(payloadText);
  if (!payload) return false;

  return writeImageBufferToCacheEntry(cache, entry, {
    buffer: payload.buffer,
    mimeType: payload.mimeType,
    ext: payload.ext,
    sourcePrefix: "deferred-inline",
  });
}

function copyInlineImageJsonToSessionCache(state, ctx, text) {
  const payload = extractInlineImagePayloadFromText(text);
  if (!payload) return null;

  return copyImageBufferToSessionCache(state, ctx, {
    buffer: payload.buffer,
    mimeType: payload.mimeType,
    ext: payload.ext,
    sourcePrefix: "inline-json",
  });
}

function copyRawBase64ImageToSessionCache(state, ctx, text) {
  const payload = extractRawBase64ImagePayloadFromText(text);
  if (!payload) return null;

  return copyImageBufferToSessionCache(state, ctx, {
    buffer: payload.buffer,
    mimeType: payload.mimeType,
    ext: payload.ext,
    sourcePrefix: "inline-b64",
  });
}

function copyInlineImagePayloadToSessionCache(state, ctx, text) {
  if (!ENABLE_CLIPBOARD_IMAGE_FLOW) return null;

  return copyInlineImageJsonToSessionCache(state, ctx, text)
    || copyRawBase64ImageToSessionCache(state, ctx, text);
}

function copyClipboardImageToSessionCache(state, ctx) {
  if (!ENABLE_CLIPBOARD_IMAGE_FLOW) return null;

  const clipboardImage = readClipboardImageFromSystem();
  if (!clipboardImage) return null;

  return copyImageBufferToSessionCache(state, ctx, {
    buffer: clipboardImage.buffer,
    mimeType: clipboardImage.mimeType,
    ext: clipboardImage.ext,
    sourcePrefix: "clipboard",
  });
}

function normalizeBracketedPasteData(data) {
  return String(data || "")
    .split(BRACKETED_PASTE_START).join("")
    .split(BRACKETED_PASTE_END).join("");
}

function resetDropPasteCapture(state) {
  state.dropPasteCapture.active = false;
  state.dropPasteCapture.buffer = "";
  state.dropPasteCapture.startedAt = 0;
}

function transformPasteBody(state, ctx, text, { allowClipboardImage = false } = {}) {
  const normalizedText = normalizeBracketedPasteData(text);

  const inlineImageEntry = copyInlineImagePayloadToSessionCache(state, ctx, normalizedText);
  if (inlineImageEntry) {
    if (ctx?.hasUI) {
      ctx.ui.notify(`Inline image payload yakalandı ${inlineImageEntry.marker}`, "info");
      ctx.ui.setStatus(DRAG_CACHE_STATUS_KEY, `Clipboard image ready · ${inlineImageEntry.marker}`);
    }
    return { data: inlineImageEntry.marker };
  }

  const looksInlinePayload = containsLikelyInlineImagePayload(normalizedText);
  if (looksInlinePayload) {
    const clipboardFallback = copyClipboardImageToSessionCache(state, ctx);
    if (clipboardFallback) {
      if (ctx?.hasUI) {
        ctx.ui.notify(`Inline payload clipboard fallback ${clipboardFallback.marker}`, "info");
        ctx.ui.setStatus(DRAG_CACHE_STATUS_KEY, `Clipboard image ready · ${clipboardFallback.marker}`);
      }
      return { data: clipboardFallback.marker };
    }

    const deferredEntry = createDeferredInlineImageEntry(state, ctx, normalizedText);
    if (deferredEntry) {
      if (ctx?.hasUI) {
        ctx.ui.notify(`Inline payload deferred ${deferredEntry.marker}`, "info");
        ctx.ui.setStatus(DRAG_CACHE_STATUS_KEY, `Inline payload deferred · ${deferredEntry.marker}`);
      }
      return { data: deferredEntry.marker };
    }
  }

  const result = transformDroppedPasteText(state, ctx, normalizedText);
  if (result.transformedCount > 0) {
    if (ctx?.hasUI) {
      const preview = result.markers.slice(0, 3).join(" ");
      const suffix = result.markers.length > 3 ? " …" : "";
      ctx.ui.notify(`Drag cache: ${result.markers.length} dosya yakalandı ${preview}${suffix}`, "info");
      ctx.ui.setStatus(DRAG_CACHE_STATUS_KEY, `Drag cache active · ${result.markers.length} marker`);
    }
    return { data: result.transformed };
  }

  // Normal path/drag akışında clipboard fallback devreye girmemeli.
  // Sadece path token yoksa (örn. Cmd+V image raw payload) clipboard image dene.
  if (allowClipboardImage && result.attemptedPathCount === 0) {
    const clipboardEntry = copyClipboardImageToSessionCache(state, ctx);
    if (clipboardEntry) {
      if (ctx?.hasUI) {
        ctx.ui.notify(`Clipboard image yakalandı ${clipboardEntry.marker}`, "info");
        ctx.ui.setStatus(DRAG_CACHE_STATUS_KEY, `Clipboard image ready · ${clipboardEntry.marker}`);
      }
      return { data: clipboardEntry.marker };
    }
  }

  return normalizedText !== text ? { data: normalizedText } : undefined;
}

function transformTerminalInputForDropCache(state, ctx, data) {
  if (typeof data !== "string" || data.length === 0) return undefined;

  const now = Date.now();
  if (state.dropPasteCapture.active && now - Number(state.dropPasteCapture.startedAt || 0) > DROP_CAPTURE_STALE_MS) {
    resetDropPasteCapture(state);
  }

  if (
    state.inlinePayloadCapture.active
    && now - Number(state.inlinePayloadCapture.startedAt || 0) > INLINE_PAYLOAD_CAPTURE_STALE_MS
  ) {
    resetInlinePayloadCapture(state);
  }

  const input = String(data);

  if (state.inlinePayloadCapture.active) {
    const drainUntil = Number(state.inlinePayloadCapture.drainUntil || 0);
    if (drainUntil > now) {
      // Marker basıldıktan sonra kalan paste chunk'larını kısa süre sessizce yut.
      return { consume: true };
    }

    state.inlinePayloadCapture.buffer += input;

    const resolved = tryResolveInlinePayloadCapture(state, ctx, { allowClipboardImage: false });
    if (resolved) return resolved;

    if (state.inlinePayloadCapture.buffer.length >= INLINE_PAYLOAD_CAPTURE_MAX_CHARS) {
      // Büyük payload parse edilemediyse text'i kaybetme: normalize edip geri bas.
      const fallback = normalizeBracketedPasteData(state.inlinePayloadCapture.buffer);
      resetInlinePayloadCapture(state);
      return fallback.length > 0 ? { data: fallback } : { consume: true };
    }

    return { consume: true };
  }

  if (state.dropPasteCapture.active) {
    state.dropPasteCapture.buffer += input;
    const endIndex = state.dropPasteCapture.buffer.indexOf(BRACKETED_PASTE_END);
    if (endIndex < 0) return { consume: true };

    const body = state.dropPasteCapture.buffer.slice(0, endIndex);
    const trailing = state.dropPasteCapture.buffer.slice(endIndex + BRACKETED_PASTE_END.length);
    resetDropPasteCapture(state);

    const transformedBody = transformPasteBody(state, ctx, body, { allowClipboardImage: true });
    const transformedTrailing = transformPasteBody(state, ctx, trailing, { allowClipboardImage: false });

    const bodyText = transformedBody?.data ?? normalizeBracketedPasteData(body);
    const trailingText = transformedTrailing?.data ?? normalizeBracketedPasteData(trailing);
    const merged = `${bodyText}${trailingText}`;
    return merged.length > 0 ? { data: merged } : { consume: true };
  }

  const startIndex = input.indexOf(BRACKETED_PASTE_START);
  if (startIndex >= 0) {
    const before = input.slice(0, startIndex);
    const afterStart = input.slice(startIndex + BRACKETED_PASTE_START.length);
    const endIndex = afterStart.indexOf(BRACKETED_PASTE_END);

    if (endIndex >= 0) {
      const body = afterStart.slice(0, endIndex);
      const trailing = afterStart.slice(endIndex + BRACKETED_PASTE_END.length);

      const transformedBefore = transformPasteBody(state, ctx, before, { allowClipboardImage: false });
      const transformedBody = transformPasteBody(state, ctx, body, { allowClipboardImage: true });
      const transformedTrailing = transformPasteBody(state, ctx, trailing, { allowClipboardImage: false });

      const beforeText = transformedBefore?.data ?? normalizeBracketedPasteData(before);
      const bodyText = transformedBody?.data ?? normalizeBracketedPasteData(body);
      const trailingText = transformedTrailing?.data ?? normalizeBracketedPasteData(trailing);

      return { data: `${beforeText}${bodyText}${trailingText}` };
    }

    state.dropPasteCapture.active = true;
    state.dropPasteCapture.buffer = afterStart;
    state.dropPasteCapture.startedAt = now;

    const transformedBefore = transformPasteBody(state, ctx, before, { allowClipboardImage: false });
    if (transformedBefore?.data != null) return { data: transformedBefore.data };
    return before.length > 0 ? { data: before } : { consume: true };
  }

  if (looksLikeInlinePayloadCaptureStart(input)) {
    // İlk chunk'ta mümkünse hemen marker üret; JSON/base64 ekranda görünmesin.
    const immediate = copyInlineImagePayloadToSessionCache(state, ctx, input)
      || copyClipboardImageToSessionCache(state, ctx);

    if (immediate) {
      state.inlinePayloadCapture.active = true;
      state.inlinePayloadCapture.buffer = "";
      state.inlinePayloadCapture.startedAt = now;
      state.inlinePayloadCapture.drainUntil = now + 900;
      return { data: immediate.marker };
    }

    state.inlinePayloadCapture.active = true;
    state.inlinePayloadCapture.buffer = input;
    state.inlinePayloadCapture.startedAt = now;
    state.inlinePayloadCapture.drainUntil = 0;

    const resolved = tryResolveInlinePayloadCapture(state, ctx, { allowClipboardImage: false });
    if (resolved) return resolved;
    return { consume: true };
  }

  return transformPasteBody(state, ctx, input, { allowClipboardImage: false });
}

function materializeDragMarkersInPrompt(state, ctx, text, images) {
  const activeCache = ensureSessionDragCache(state, ctx);
  if (!activeCache) return { changed: false, text, images };

  let nextText = String(text || "");
  const nextImages = Array.isArray(images) ? [...images] : [];
  let changed = false;

  const markersInPrompt = Array.from(new Set(nextText.match(MARKER_PATTERN) || []));

  for (const marker of markersInPrompt) {
    const located = findDragEntryByMarker(state, ctx, marker);
    if (!located) continue;

    const { cache, entry } = located;

    // Marker farklı bir session cache'inde kaldıysa aktif cache'e de bağla.
    if (cache !== activeCache) {
      activeCache.entriesByMarker.set(marker, entry);
      if (entry.sourcePath) {
        activeCache.entriesBySourcePath.set(entry.sourcePath, entry);
      }
    }

    if (entry.kind === "image") {
      if (entry.deferred) {
        // Editor'da marker gösterip payload decode'u send anına ertelediğimiz durum.
        materializeDeferredInlineImageEntry(activeCache, entry);
      }

      try {
        const data = fs.readFileSync(entry.cachedPath).toString("base64");
        nextImages.push({
          type: "image",
          data,
          mimeType: entry.mimeType || "image/png",
        });
        changed = true;
      } catch {
        // Cached kopya silinmişse/deferred entry ise source path'ten tekrar materialize etmeyi dene.
        try {
          const resolvedSource = entry.sourcePath ? resolveImageSourcePathWithRetry(entry.sourcePath) : null;
          if (resolvedSource?.absolutePath) {
            const sourcePath = resolvedSource.absolutePath;
            const fallbackName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${sanitizeFileName(path.basename(sourcePath))}`;
            const fallbackPath = path.join(activeCache.dir, fallbackName);
            fs.copyFileSync(sourcePath, fallbackPath);
            entry.cachedPath = fallbackPath;
            entry.sourcePath = sourcePath;
            entry.sourceSize = Number(resolvedSource.stat?.size) || entry.sourceSize || 0;
            entry.sourceMtimeMs = Number(resolvedSource.stat?.mtimeMs) || entry.sourceMtimeMs || 0;
            entry.deferred = false;

            const data = fs.readFileSync(entry.cachedPath).toString("base64");
            nextImages.push({
              type: "image",
              data,
              mimeType: entry.mimeType || "image/png",
            });
            changed = true;
          }
        } catch {
          // If image materialization fails, keep marker text unchanged.
        }
      }
      continue;
    }

    nextText = nextText.split(marker).join(entry.cachedPath);
    changed = true;
  }

  return { changed, text: nextText, images: nextImages };
}

function clearAllDragCaches(state) {
  for (const cache of state.dragCacheBySessionId.values()) {
    try {
      fs.rmSync(cache.dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }

  state.dragCacheBySessionId.clear();
  state.activeSessionId = null;
  state.dropPasteCapture.active = false;
  state.dropPasteCapture.buffer = "";
  state.dropPasteCapture.startedAt = 0;
  state.inlinePayloadCapture.active = false;
  state.inlinePayloadCapture.buffer = "";
  state.inlinePayloadCapture.startedAt = 0;
  state.inlinePayloadCapture.drainUntil = 0;
}

function emptyWindow(label) {
  return {
    label,
    status: "idle", // idle | loading | ok | no-auth | unavailable | error
    usedPercent: null,
    remainingPercent: null,
    limitWindowSeconds: null,
    resetAfterSeconds: null,
    resetAt: null,
    message: "",
  };
}

function inferDefaultAlias(id, accountId) {
  if (typeof accountId === "string" && accountId.trim()) {
    const trimmed = accountId.trim();
    const last4 = trimmed.slice(-4);
    return `acc-${last4 || id}`;
  }
  return `Account ${id}`;
}

function normalizeOpenAIAccount(raw, fallbackId) {
  const idCandidate = Number(raw?.id);
  const id = Number.isInteger(idCandidate) && idCandidate > 0 ? idCandidate : fallbackId;

  const access = typeof raw?.access === "string" ? raw.access.trim() : "";
  const refresh = typeof raw?.refresh === "string" ? raw.refresh.trim() : "";
  const expires = Number(raw?.expires);

  if (!access || !refresh || !Number.isFinite(expires) || expires <= 0) return null;

  const accountId = typeof raw?.accountId === "string" ? raw.accountId.trim() : "";
  const aliasRaw = typeof raw?.alias === "string" ? raw.alias.trim() : "";
  const alias = aliasRaw || inferDefaultAlias(id, accountId);

  const now = Date.now();
  const createdAt = Number(raw?.createdAt);
  const updatedAt = Number(raw?.updatedAt);

  return {
    id,
    alias,
    access,
    refresh,
    expires,
    accountId,
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : now,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : now,
  };
}

function parseOpenAICredential(rawCredential) {
  const credential = rawCredential && typeof rawCredential === "object" ? rawCredential : null;
  if (!credential) {
    return { accounts: [], activeId: null, hasStructuredAccounts: false };
  }

  const rawAccounts = Array.isArray(credential[OPENAI_MULTI_ACCOUNTS_KEY])
    ? credential[OPENAI_MULTI_ACCOUNTS_KEY]
    : null;

  const normalized = [];
  if (rawAccounts) {
    for (let i = 0; i < rawAccounts.length; i++) {
      const item = normalizeOpenAIAccount(rawAccounts[i], i + 1);
      if (item) normalized.push(item);
    }
  }

  // Legacy single-account credential fallback.
  if (normalized.length === 0) {
    const legacy = normalizeOpenAIAccount({ ...credential, id: 1 }, 1);
    if (legacy) normalized.push(legacy);
  }

  // Deduplicate by id and keep stable sort.
  const seen = new Set();
  const accounts = [];
  for (const account of normalized.sort((a, b) => a.id - b.id)) {
    if (seen.has(account.id)) continue;
    seen.add(account.id);
    accounts.push(account);
  }

  const activeCandidate = Number(credential[OPENAI_ACTIVE_ACCOUNT_ID_KEY]);
  let activeId = Number.isInteger(activeCandidate) && accounts.some((a) => a.id === activeCandidate)
    ? activeCandidate
    : accounts[0]?.id ?? null;

  if (!Number.isInteger(activeId) && accounts.length > 0) activeId = accounts[0].id;

  return {
    accounts,
    activeId,
    hasStructuredAccounts: Array.isArray(rawAccounts),
  };
}

function buildOpenAICredentialPayload(accounts, activeId) {
  const ordered = [...accounts].sort((a, b) => a.id - b.id);
  const active = ordered.find((a) => a.id === activeId) || ordered[0] || null;

  return {
    access: active?.access || "",
    refresh: active?.refresh || "",
    expires: active?.expires || 0,
    accountId: active?.accountId || "",
    [OPENAI_ACTIVE_ACCOUNT_ID_KEY]: active?.id ?? null,
    [OPENAI_MULTI_ACCOUNTS_KEY]: ordered.map((a) => ({
      id: a.id,
      alias: a.alias,
      access: a.access,
      refresh: a.refresh,
      expires: a.expires,
      accountId: a.accountId,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    })),
  };
}

function getOpenAIOAuthCredential(authStorage) {
  if (!authStorage) return null;

  try {
    if (typeof authStorage.getCredentialsForProvider === "function") {
      const creds = authStorage.getCredentialsForProvider(OPENAI_CODEX_PROVIDER);
      if (Array.isArray(creds)) {
        const oauth = creds.find((c) => c?.type === "oauth");
        if (oauth) return oauth;
      }
    }
  } catch {
    // ignore
  }

  try {
    const single = authStorage.get?.(OPENAI_CODEX_PROVIDER);
    if (single?.type === "oauth") return single;
  } catch {
    // ignore
  }

  return null;
}

function formatAccountList(accounts, activeId) {
  return accounts
    .slice()
    .sort((a, b) => a.id - b.id)
    .map((a) => `${a.id}:${a.alias}${a.id === activeId ? "*" : ""}`)
    .join(", ");
}

function getNextAccountId(accounts) {
  if (!accounts.length) return 1;
  return Math.max(...accounts.map((a) => a.id)) + 1;
}

function getActiveAccount(accounts, activeId) {
  return accounts.find((a) => a.id === activeId) || accounts[0] || null;
}

function createState() {
  return {
    ctx: null,
    currentModel: null,
    requestRender: null,
    timer: null,
    inFlight: false,
    footerInstalled: false,
    openaiCodexProviderInstalled: false,
    terminalInputUnsub: null,
    dragCacheBySessionId: new Map(),
    activeSessionId: null,
    dropPasteCapture: {
      active: false,
      buffer: "",
      startedAt: 0,
    },
    inlinePayloadCapture: {
      active: false,
      buffer: "",
      startedAt: 0,
      drainUntil: 0,
    },
    openaiAccounts: [],
    activeOpenAIAccountId: null,
    swapPicker: {
      active: false,
      selectedId: null,
    },
    stopControl: {
      lastRequestedAt: 0,
      retryTimer: null,
    },
    draftReconcile: {
      timer: null,
      inProgress: false,
      lastText: "",
      lastRunAt: 0,
    },
    usage: {
      updatedAt: null,
      fiveHour: emptyWindow("5h"),
      weekly: emptyWindow("7d"),
    },
  };
}

function resetUsage(state) {
  state.usage.fiveHour = emptyWindow("5h");
  state.usage.weekly = emptyWindow("7d");
  state.usage.updatedAt = null;
}

async function fetchWhamUsage({ authorization, accountId }) {
  if (!authorization) {
    const err = new Error("Authorization token bulunamadı");
    err.code = "NO_AUTH";
    throw err;
  }

  const endpoint = process.env.CHATGPT_WHAM_ENDPOINT || DEFAULT_WHAM_ENDPOINT;
  const headers = {
    authorization,
    accept: "*/*",
    "user-agent": resolveUserAgent(),
    host: "chatgpt.com",
  };

  if (accountId) headers["chatgpt-account-id"] = accountId;

  const res = await fetch(endpoint, { method: "GET", headers });
  const text = await res.text();

  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }

  if (!res.ok) {
    const msg = data?.error?.message || data?.message || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.code = res.status;
    throw err;
  }

  return data;
}

function pickWindow(rateLimit, targetSeconds, fallbackKey) {
  const primary = rateLimit?.primary_window;
  const secondary = rateLimit?.secondary_window;
  const windows = [primary, secondary].filter(Boolean);

  const exact = windows.find((w) => Number(w?.limit_window_seconds) === targetSeconds);
  if (exact) return exact;

  return fallbackKey === "primary" ? primary : secondary;
}

function applyWindow(target, raw) {
  if (!raw) {
    target.status = "unavailable";
    target.message = "window verisi yok";
    return;
  }

  const used = clampPercent(Number(raw.used_percent));
  const remaining = clampPercent(100 - used);

  target.status = "ok";
  target.usedPercent = used;
  target.remainingPercent = remaining;
  target.limitWindowSeconds = Number(raw.limit_window_seconds) || null;
  target.resetAfterSeconds = Number(raw.reset_after_seconds) || null;
  target.resetAt = Number(raw.reset_at) || null;
  target.message = "";
}

function renderWindow(win, theme) {
  if (!win) return "";

  if (win.status === "ok" && Number.isFinite(win.remainingPercent)) {
    const rp = win.remainingPercent;
    const bar = makeBar(rp, 8);
    const barColored = rp < 10
      ? theme.fg("error", bar)
      : rp < 30
        ? theme.fg("warning", bar)
        : theme.fg("success", bar);

    return `${win.label} ${barColored} ${rp.toFixed(0)}%`;
  }

  if (win.status === "loading") return `${win.label} …`;
  if (win.status === "no-auth") return theme.fg("warning", `${win.label} auth?`);
  if (win.status === "error") return theme.fg("error", `${win.label} !`);
  return theme.fg("warning", `${win.label} ?`);
}

function renderOpenAIAccountBadges(state, theme) {
  if (!Array.isArray(state.openaiAccounts) || state.openaiAccounts.length === 0) return "";

  const accounts = state.openaiAccounts.slice().sort((a, b) => a.id - b.id);
  const activeId = state.activeOpenAIAccountId;
  const selectedId = state.swapPicker.active ? state.swapPicker.selectedId : null;

  const chips = accounts.map((account) => {
    const label = `[${account.id}]`;
    if (account.id === activeId) return theme.fg("accent", label);
    if (state.swapPicker.active && account.id === selectedId) return theme.fg("warning", label);
    return theme.fg("dim", label);
  });

  let hint = "";
  if (accounts.length > 1) {
    hint = state.swapPicker.active
      ? ` ${theme.fg("dim", "(Enter to apply)")}`
      : ` ${theme.fg("dim", "(F2 to swap)")}`;
  }
  return `${chips.join(" ")}${hint}`;
}

export default function registerExtension(pi) {
  const state = createState();

  const renderNow = () => {
    if (typeof state.requestRender === "function") state.requestRender();
  };

  const clearPendingStopRetry = () => {
    if (state.stopControl.retryTimer) {
      clearTimeout(state.stopControl.retryTimer);
      state.stopControl.retryTimer = null;
    }
  };

  const clearDraftReconcileTimer = () => {
    if (state.draftReconcile.timer) {
      clearInterval(state.draftReconcile.timer);
      state.draftReconcile.timer = null;
    }
  };

  const reconcileEditorImagePaths = (ctx, reason = "poll") => {
    if (!ctx?.hasUI) return false;
    if (state.draftReconcile.inProgress) return false;
    if (typeof ctx.ui.getEditorText !== "function" || typeof ctx.ui.setEditorText !== "function") return false;

    const currentText = String(ctx.ui.getEditorText() || "");
    if (!currentText) return false;

    const hasLikelyImagePath = containsLikelyImagePath(currentText);
    const hasLikelyInlinePayload = containsLikelyInlineImagePayload(currentText);
    if (!hasLikelyImagePath && !hasLikelyInlinePayload) return false;

    const now = Date.now();
    if (
      currentText === state.draftReconcile.lastText
      && now - Number(state.draftReconcile.lastRunAt || 0) < DRAFT_RECONCILE_MIN_GAP_MS
    ) {
      return false;
    }

    state.draftReconcile.lastText = currentText;
    state.draftReconcile.lastRunAt = now;
    state.draftReconcile.inProgress = true;

    try {
      const inlineEntry = hasLikelyInlinePayload
        ? copyInlineImagePayloadToSessionCache(state, ctx, currentText)
        : null;

      if (inlineEntry) {
        ctx.ui.setEditorText(inlineEntry.marker);
        ctx.ui.notify(`Drag cache(${reason}): inline image -> ${inlineEntry.marker}`, "info");
        ctx.ui.setStatus(DRAG_CACHE_STATUS_KEY, `Clipboard image ready · ${inlineEntry.marker}`);
        return true;
      }

      if (hasLikelyInlinePayload) {
        const clipboardFallback = copyClipboardImageToSessionCache(state, ctx);
        if (clipboardFallback) {
          ctx.ui.setEditorText(clipboardFallback.marker);
          ctx.ui.notify(`Drag cache(${reason}): clipboard fallback -> ${clipboardFallback.marker}`, "info");
          ctx.ui.setStatus(DRAG_CACHE_STATUS_KEY, `Clipboard image ready · ${clipboardFallback.marker}`);
          return true;
        }

        const deferredEntry = createDeferredInlineImageEntry(state, ctx, currentText);
        if (deferredEntry) {
          ctx.ui.setEditorText(deferredEntry.marker);
          ctx.ui.notify(`Drag cache(${reason}): deferred inline -> ${deferredEntry.marker}`, "info");
          ctx.ui.setStatus(DRAG_CACHE_STATUS_KEY, `Inline payload deferred · ${deferredEntry.marker}`);
          return true;
        }
      }

      const result = transformDroppedPasteText(state, ctx, currentText);
      if (result.transformed !== currentText) {
        ctx.ui.setEditorText(result.transformed);
        if (result.transformedCount > 0) {
          const preview = result.markers.slice(0, 3).join(" ");
          const suffix = result.markers.length > 3 ? " …" : "";
          ctx.ui.notify(`Drag cache(${reason}): ${result.transformedCount} dosya ${preview}${suffix}`, "info");
          ctx.ui.setStatus(DRAG_CACHE_STATUS_KEY, `Drag cache active · ${result.transformedCount} marker`);
        }
        return true;
      }

      return false;
    } finally {
      state.draftReconcile.inProgress = false;
    }
  };

  const ensureDraftReconcileTimer = () => {
    if (state.draftReconcile.timer) return;

    state.draftReconcile.timer = setInterval(() => {
      const liveCtx = state.ctx;
      if (!liveCtx?.hasUI) return;
      reconcileEditorImagePaths(liveCtx, "timer");
    }, DRAFT_RECONCILE_INTERVAL_MS);
  };

  const requestImmediateStop = (ctx, sourceLabel = "shortcut") => {
    const now = Date.now();
    if (now - state.stopControl.lastRequestedAt < STOP_REQUEST_COOLDOWN_MS) {
      return;
    }
    state.stopControl.lastRequestedAt = now;
    clearPendingStopRetry();

    const tryAbort = () => {
      try {
        ctx?.abort?.();
      } catch {
        // ignore abort errors
      }
    };

    const sendStopIfBusy = () => {
      const idle = !!ctx?.isIdle?.();
      if (idle) return false;
      pi.sendUserMessage("/gsd stop", { deliverAs: "steer" });
      return true;
    };

    // İlk kesme denemesi + kısa aralıklı tekrarlar (tool call kilitlenmelerine karşı)
    tryAbort();
    let retries = 0;
    const retryTimer = setInterval(() => {
      retries += 1;
      const idle = !!ctx?.isIdle?.();
      if (idle || retries >= 6) {
        clearInterval(retryTimer);
        return;
      }
      tryAbort();
    }, 80);

    const stopSent = sendStopIfBusy();

    if (ctx?.hasUI) {
      const notifyText = stopSent
        ? `${sourceLabel}: aktif görev iptal ediliyor, /gsd stop gönderiliyor`
        : `${sourceLabel}: aktif görev iptal edildi`;
      ctx.ui.notify(notifyText, "warning");
      ctx.ui.setStatus(
        STOP_STATUS_KEY,
        stopSent ? `${sourceLabel}: force-stop requested` : `${sourceLabel}: abort requested`,
      );
    }

    // Streaming state yarışlarında gerekirse bir kez daha dene; idle ise hiç gönderme.
    state.stopControl.retryTimer = setTimeout(() => {
      state.stopControl.retryTimer = null;
      sendStopIfBusy();
    }, STOP_STEER_RETRY_DELAY_MS);
  };

  const clearSwapPickerStatus = () => {
    if (state.ctx?.hasUI) state.ctx.ui.setStatus(OPENAI_SWAP_STATUS_KEY, undefined);
  };

  const syncOpenAIAccountsFromAuth = (ctx, { upgradeLegacy = false } = {}) => {
    const authStorage = ctx?.modelRegistry?.authStorage;
    const oauthCred = getOpenAIOAuthCredential(authStorage);
    const parsed = parseOpenAICredential(oauthCred);

    state.openaiAccounts = parsed.accounts;
    state.activeOpenAIAccountId = parsed.activeId;

    if (state.swapPicker.active) {
      if (!parsed.accounts.some((a) => a.id === state.swapPicker.selectedId)) {
        state.swapPicker.selectedId = parsed.activeId;
      }
      if (parsed.accounts.length < 2) {
        state.swapPicker.active = false;
        state.swapPicker.selectedId = null;
        clearSwapPickerStatus();
      }
    }

    if (upgradeLegacy && oauthCred && parsed.accounts.length === 1 && !parsed.hasStructuredAccounts && ctx) {
      const payload = buildOpenAICredentialPayload(parsed.accounts, parsed.activeId);
      authStorage.set(OPENAI_CODEX_PROVIDER, { type: "oauth", ...payload });
      ctx.modelRegistry.refresh?.();
      state.openaiAccounts = parsed.accounts;
      state.activeOpenAIAccountId = parsed.activeId;
    }
  };

  const persistOpenAIAccounts = (ctx, accounts, activeId) => {
    const authStorage = ctx?.modelRegistry?.authStorage;
    if (!authStorage) return false;

    const payload = buildOpenAICredentialPayload(accounts, activeId);
    authStorage.set(OPENAI_CODEX_PROVIDER, { type: "oauth", ...payload });
    ctx.modelRegistry.refresh?.();

    state.openaiAccounts = payload[OPENAI_MULTI_ACCOUNTS_KEY] || [];
    state.activeOpenAIAccountId = payload[OPENAI_ACTIVE_ACCOUNT_ID_KEY] || null;
    return true;
  };

  const closeSwapPicker = () => {
    state.swapPicker.active = false;
    state.swapPicker.selectedId = null;
    clearSwapPickerStatus();
    renderNow();
  };

  const switchOpenAIAccount = async (ctx, targetId, source = "swap") => {
    syncOpenAIAccountsFromAuth(ctx);

    const accounts = state.openaiAccounts.slice().sort((a, b) => a.id - b.id);
    if (accounts.length < 2) {
      ctx?.ui?.notify("Tek OpenAI hesabı var. /swap kullanılamaz.", "warning");
      closeSwapPicker();
      return false;
    }

    const target = accounts.find((a) => a.id === targetId);
    if (!target) {
      ctx?.ui?.notify(`Geçersiz hesap: ${targetId}`, "error");
      return false;
    }

    if (!persistOpenAIAccounts(ctx, accounts, target.id)) {
      ctx?.ui?.notify("Hesap geçişi başarısız oldu.", "error");
      return false;
    }

    if (ctx?.hasUI) {
      ctx.ui.notify(`OpenAI hesap değişti: #${target.id} (${target.alias})`, "info");
    }

    closeSwapPicker();
    await refreshUsage();

    if (source === "command") {
      ctx?.ui?.notify(`Hesaplar: ${formatAccountList(accounts, target.id)}`, "info");
    }

    return true;
  };

  const moveSwapPickerSelection = (ctx, direction) => {
    const accounts = state.openaiAccounts.slice().sort((a, b) => a.id - b.id);
    if (accounts.length < 2) return;

    let index = accounts.findIndex((a) => a.id === state.swapPicker.selectedId);
    if (index < 0) index = accounts.findIndex((a) => a.id === state.activeOpenAIAccountId);
    if (index < 0) index = 0;

    const nextIndex = (index + direction + accounts.length) % accounts.length;
    state.swapPicker.selectedId = accounts[nextIndex].id;

    const selected = accounts[nextIndex];
    ctx?.ui?.setStatus(
      OPENAI_SWAP_STATUS_KEY,
      `Swap mode: F2 sıradaki hesap, ←/→ seç, Enter uygula, Esc iptal · seçili [${selected.id}] ${selected.alias}`,
    );
    renderNow();
  };

  const startSwapPicker = (ctx) => {
    syncOpenAIAccountsFromAuth(ctx);

    const accounts = state.openaiAccounts.slice().sort((a, b) => a.id - b.id);
    if (accounts.length < 2) {
      ctx?.ui?.notify("Tek OpenAI hesabı var. /swap kullanılamaz.", "warning");
      return;
    }

    state.swapPicker.active = true;
    state.swapPicker.selectedId = state.activeOpenAIAccountId || accounts[0].id;

    const selected = accounts.find((a) => a.id === state.swapPicker.selectedId) || accounts[0];
    ctx?.ui?.setStatus(
      OPENAI_SWAP_STATUS_KEY,
      `Swap mode: F2 sıradaki hesap, ←/→ seç, Enter uygula, Esc iptal, 1-9 direkt seç · seçili [${selected.id}] ${selected.alias}`,
    );
    renderNow();
  };

  const handleSwapTerminalInput = (data, ctx) => {
    if (!state.swapPicker.active) return undefined;

    if (matchesKey(data, Key.left) || matchesKey(data, Key.up)) {
      moveSwapPickerSelection(ctx, -1);
      return { consume: true };
    }

    if (matchesKey(data, Key.right) || matchesKey(data, Key.down)) {
      moveSwapPickerSelection(ctx, 1);
      return { consume: true };
    }

    if (matchesKey(data, Key.f2)) {
      // F2 pressed while picker is open -> cycle to next account
      moveSwapPickerSelection(ctx, 1);
      return { consume: true };
    }

    if (matchesKey(data, Key.enter)) {
      const selected = Number(state.swapPicker.selectedId);
      if (Number.isInteger(selected) && selected > 0) {
        void switchOpenAIAccount(ctx, selected, "f2");
      } else {
        closeSwapPicker();
      }
      return { consume: true };
    }

    if (isEscapeInput(data)) {
      closeSwapPicker();
      return { consume: true };
    }

    if (typeof data === "string" && /^[1-9]$/.test(data)) {
      const id = Number(data);
      const exists = state.openaiAccounts.some((a) => a.id === id);
      if (exists) {
        state.swapPicker.selectedId = id;
        void switchOpenAIAccount(ctx, id, "f2");
      }
      return { consume: true };
    }

    return { consume: true };
  };

  const installTerminalInputHandler = (ctx) => {
    if (!ctx?.hasUI) return;
    if (typeof ctx.ui.onTerminalInput !== "function") return;

    if (typeof state.terminalInputUnsub === "function") {
      state.terminalInputUnsub();
      state.terminalInputUnsub = null;
    }

    state.terminalInputUnsub = ctx.ui.onTerminalInput((data) => {
      const liveCtx = state.ctx || ctx;

      const swapResult = handleSwapTerminalInput(data, liveCtx);
      if (swapResult?.consume) return swapResult;

      if (isForceStopInput(data)) {
        const sourceLabel = isEscapeInput(data) ? "Esc" : "F4";
        requestImmediateStop(liveCtx, sourceLabel);
        return { consume: true };
      }

      const transformed = transformTerminalInputForDropCache(state, liveCtx, data);

      // Bazı terminal/paste akışlarında path doğrudan editöre düşebilir.
      // Aynı tick sonunda draft'i tarayıp image path'leri marker'a dönüştür.
      queueMicrotask(() => {
        reconcileEditorImagePaths(liveCtx, "terminal-input");
      });

      return transformed;
    });
  };

  const installOpenAICodexMultiProvider = () => {
    if (state.openaiCodexProviderInstalled) return;

    pi.registerProvider(OPENAI_CODEX_PROVIDER, {
      oauth: {
        name: "ChatGPT Plus/Pro (Codex Subscription)",
        usesCallbackServer: true,

        async login(callbacks) {
          const latestOAuthCredential = getOpenAIOAuthCredential(state.ctx?.modelRegistry?.authStorage);
          const latestParsed = parseOpenAICredential(latestOAuthCredential);
          const currentAccounts = (latestParsed.accounts.length > 0 ? latestParsed.accounts : state.openaiAccounts)
            .slice()
            .sort((a, b) => a.id - b.id);

          const interactiveUI = state.ctx?.hasUI ? state.ctx.ui : null;

          let mode = "additional";
          let overwriteId = null;

          if (currentAccounts.length > 0) {
            if (interactiveUI?.select) {
              const modeChoice = await interactiveUI.select(
                "OpenAI Hesap Modu",
                [
                  "Additional account (Recommended)",
                  "Overwrite existing account",
                ],
              );

              if (!modeChoice) throw new Error("Login cancelled");
              mode = String(modeChoice).toLowerCase().includes("overwrite") ? "overwrite" : "additional";
            } else {
              while (true) {
                const raw = await callbacks.onPrompt({
                  message:
                    "OpenAI hesap modu: A = additional account, O = overwrite existing\nSeçim (A/O):",
                  placeholder: "A veya O",
                });

                const value = String(raw || "").trim().toLowerCase();
                if (!value || value === "a" || value === "add" || value === "additional") {
                  mode = "additional";
                  break;
                }
                if (value === "o" || value === "overwrite" || value === "replace") {
                  mode = "overwrite";
                  break;
                }
                callbacks.onProgress?.("Geçersiz seçim. A (additional) veya O (overwrite) gir.");
              }
            }

            if (mode === "overwrite") {
              if (interactiveUI?.select) {
                const options = currentAccounts.map((a) => `[${a.id}] ${a.alias}`);
                const chosen = await interactiveUI.select("Üzerine Yazılacak Hesap", options);
                if (!chosen) throw new Error("Login cancelled");

                const picked = String(chosen);
                const idMatch = picked.match(/^\[(\d+)\]/);
                const parsedId = Number(idMatch?.[1]);
                if (Number.isInteger(parsedId) && currentAccounts.some((a) => a.id === parsedId)) {
                  overwriteId = parsedId;
                } else {
                  const fallback = currentAccounts.find((a) => `${a.id}` === picked.trim());
                  overwriteId = fallback?.id ?? null;
                }

                if (!overwriteId) throw new Error("Geçersiz hesap seçimi");
              } else {
                const listText = currentAccounts.map((a) => `${a.id}) ${a.alias}`).join("\n");
                while (true) {
                  const raw = await callbacks.onPrompt({
                    message: `Üzerine yazılacak hesabı seç:\n${listText}\nNumara:`,
                    placeholder: "örn: 2",
                  });
                  const id = Number(String(raw || "").trim());
                  if (Number.isInteger(id) && currentAccounts.some((a) => a.id === id)) {
                    overwriteId = id;
                    break;
                  }
                  callbacks.onProgress?.("Geçersiz numara. Listeden bir hesap numarası gir.");
                }
              }
            }
          }

          let alias = "";
          while (!alias) {
            if (interactiveUI?.input) {
              const aliasInput = await interactiveUI.input("Hesap Alias", "örn: iş / kişisel");
              if (aliasInput == null) throw new Error("Login cancelled");
              alias = String(aliasInput || "").trim();
            } else {
              const rawAlias = await callbacks.onPrompt({
                message: "Bu hesap için alias gir (zorunlu):",
                placeholder: "örn: iş / kişisel",
              });
              alias = String(rawAlias || "").trim();
            }

            if (!alias) callbacks.onProgress?.("Alias boş olamaz.");
          }

          const fresh = await loginOpenAICodex({
            onAuth: callbacks.onAuth,
            onPrompt: callbacks.onPrompt,
            onProgress: callbacks.onProgress,
            onManualCodeInput: callbacks.onManualCodeInput,
          });

          const now = Date.now();
          const baseAccount = {
            id: 1,
            alias,
            access: fresh.access,
            refresh: fresh.refresh,
            expires: fresh.expires,
            accountId: typeof fresh.accountId === "string" ? fresh.accountId : "",
            createdAt: now,
            updatedAt: now,
          };

          const merged = currentAccounts.map((a) => ({ ...a }));
          let activeId = null;

          if (mode === "overwrite" && overwriteId != null) {
            const idx = merged.findIndex((a) => a.id === overwriteId);
            if (idx >= 0) {
              const previous = merged[idx];
              merged[idx] = {
                ...baseAccount,
                id: previous.id,
                createdAt: previous.createdAt || now,
                updatedAt: now,
              };
              activeId = previous.id;
            }
          }

          if (activeId == null) {
            const newId = getNextAccountId(merged);
            merged.push({ ...baseAccount, id: newId });
            activeId = newId;
          }

          merged.sort((a, b) => a.id - b.id);

          state.openaiAccounts = merged;
          state.activeOpenAIAccountId = activeId;

          callbacks.onProgress?.(`OpenAI hesap kaydedildi: #${activeId} (${alias})`);

          // Login sonrası usage bar'ın yeni aktif hesapla hemen güncellenmesi için
          // optimistic fetch yapıyoruz; başarısız olursa normal refresh akışı devam eder.
          try {
            const activeAccount = getActiveAccount(merged, activeId);
            if (activeAccount?.access) {
              const wham = await fetchWhamUsage({
                authorization: normalizeAuthorizationHeader(activeAccount.access),
                accountId: activeAccount.accountId,
              });
              const rateLimit = wham?.rate_limit;
              const fiveHourRaw = pickWindow(rateLimit, FIVE_HOURS_SECONDS, "primary");
              const weeklyRaw = pickWindow(rateLimit, WEEK_SECONDS, "secondary");
              applyWindow(state.usage.fiveHour, fiveHourRaw);
              applyWindow(state.usage.weekly, weeklyRaw);
              state.usage.updatedAt = new Date();
              renderNow();
            }
          } catch {
            // ignore: credential set olduktan sonra refreshUsage tekrar deneyecek
          }

          queueMicrotask(() => {
            refreshUsage().catch(() => {});
          });

          return buildOpenAICredentialPayload(merged, activeId);
        },

        async refreshToken(credentials) {
          const parsed = parseOpenAICredential(credentials);
          const accounts = parsed.accounts.map((a) => ({ ...a }));

          if (accounts.length === 0) {
            return refreshOpenAICodexToken(String(credentials?.refresh || ""));
          }

          const active = getActiveAccount(accounts, parsed.activeId);
          if (!active) {
            return refreshOpenAICodexToken(String(credentials?.refresh || ""));
          }

          const refreshed = await refreshOpenAICodexToken(active.refresh);
          const now = Date.now();

          const updated = accounts.map((a) => {
            if (a.id !== active.id) return a;
            return {
              ...a,
              access: refreshed.access,
              refresh: refreshed.refresh,
              expires: refreshed.expires,
              accountId: typeof refreshed.accountId === "string" ? refreshed.accountId : a.accountId,
              updatedAt: now,
            };
          });

          state.openaiAccounts = updated;
          state.activeOpenAIAccountId = active.id;

          return buildOpenAICredentialPayload(updated, active.id);
        },

        getApiKey(credentials) {
          const parsed = parseOpenAICredential(credentials);
          const active = getActiveAccount(parsed.accounts, parsed.activeId);
          if (active?.access) return active.access;
          return typeof credentials?.access === "string" ? credentials.access : "";
        },
      },
    });

    state.openaiCodexProviderInstalled = true;
  };

  // Esc built-in shortcut ile çakıştığı için registerShortcut kullanmıyoruz.
  // Esc yakalama onTerminalInput içinden isForceStopInput ile devam eder.

  // F4 mevcut alışkanlıklar için fallback olarak bırakıldı.
  pi.registerShortcut(Key.f4, {
    description: "Fallback immediate stop (legacy F4)",
    handler: async (ctx) => {
      requestImmediateStop(ctx, "F4");
    },
  });

  // Bazı terminallerde/OS seviyesinde yakalanırsa, legacy kombinasyon fallback olarak dursun.
  pi.registerShortcut(Key.ctrlAlt("["), {
    description: "Fallback immediate stop (legacy double-Esc)",
    handler: async (ctx) => {
      requestImmediateStop(ctx, "Legacy stop");
    },
  });

  pi.registerShortcut(Key.f2, {
    description: "OpenAI account swap picker",
    handler: async (ctx) => {
      syncOpenAIAccountsFromAuth(ctx);

      const accounts = state.openaiAccounts.slice().sort((a, b) => a.id - b.id);
      if (accounts.length < 2) {
        ctx?.ui?.notify("Tek OpenAI hesabı var. /swap kullanılamaz.", "warning");
        return;
      }

      if (!state.swapPicker.active) {
        startSwapPicker(ctx);
      }

      // Her F2 basışında bir sonraki hesaba geçilecek şekilde seçimi döndür.
      moveSwapPickerSelection(ctx, 1);
    },
  });

  const clearTimer = () => {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
  };

  const ensureTimer = () => {
    if (state.timer) return;
    state.timer = setInterval(() => {
      refreshUsage().catch(() => {});
    }, REFRESH_MS);
  };

  const getActiveModel = () => state.currentModel || state.ctx?.model;

  const refreshUsage = async () => {
    const model = getActiveModel();
    if (!model || !isOpenAIModel(model)) {
      resetUsage(state);
      renderNow();
      return;
    }

    if (state.inFlight) return;
    state.inFlight = true;

    state.usage.fiveHour.status = "loading";
    state.usage.weekly.status = "loading";
    renderNow();

    try {
      const authorization = await resolveAuthorizationHeader(state.ctx, model);
      const activeAccount = getActiveAccount(state.openaiAccounts, state.activeOpenAIAccountId);
      const accountId = activeAccount?.accountId || resolveAccountIdHeader({ model, authorization });

      const data = await fetchWhamUsage({ authorization, accountId });
      const rateLimit = data?.rate_limit;

      const fiveHourRaw = pickWindow(rateLimit, FIVE_HOURS_SECONDS, "primary");
      const weeklyRaw = pickWindow(rateLimit, WEEK_SECONDS, "secondary");

      applyWindow(state.usage.fiveHour, fiveHourRaw);
      applyWindow(state.usage.weekly, weeklyRaw);
      state.usage.updatedAt = new Date();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isNoAuth = (err instanceof Error && err.code === "NO_AUTH") || /authorization/i.test(msg);

      state.usage.fiveHour = emptyWindow("5h");
      state.usage.weekly = emptyWindow("7d");
      state.usage.fiveHour.status = isNoAuth ? "no-auth" : "error";
      state.usage.weekly.status = isNoAuth ? "no-auth" : "error";
      state.usage.fiveHour.message = msg;
      state.usage.weekly.message = msg;
      state.usage.updatedAt = new Date();
    } finally {
      state.inFlight = false;
      renderNow();
    }
  };

  pi.registerCommand("panicstop", {
    description: "Aktif görevi anında kes + /gsd stop",
    handler: async (_args, ctx) => {
      requestImmediateStop(ctx, "/panicstop");
    },
  });

  pi.registerCommand("swap", {
    description: "OpenAI hesap değiştir: /swap <id>",
    getArgumentCompletions: (prefix) => {
      const trimmed = String(prefix || "").trim();
      const accounts = state.openaiAccounts.slice().sort((a, b) => a.id - b.id);
      if (accounts.length < 2) return null;

      const items = accounts
        .map((a) => ({ value: String(a.id), label: `${a.id} — ${a.alias}` }))
        .filter((item) => !trimmed || item.value.startsWith(trimmed));

      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      syncOpenAIAccountsFromAuth(ctx);

      const accounts = state.openaiAccounts.slice().sort((a, b) => a.id - b.id);
      if (accounts.length < 2) {
        ctx.ui.notify("Tek OpenAI hesabı var. /swap kullanılamaz.", "warning");
        return;
      }

      const raw = String(args || "").trim();
      if (!raw) {
        ctx.ui.notify(`Kullanım: /swap <id> · Hesaplar: ${formatAccountList(accounts, state.activeOpenAIAccountId)}`, "info");
        return;
      }

      const id = Number(raw);
      if (!Number.isInteger(id) || id <= 0) {
        ctx.ui.notify(`Geçersiz hesap numarası: ${raw}`, "error");
        return;
      }

      await switchOpenAIAccount(ctx, id, "command");
    },
  });

  pi.registerCommand("dragcache", {
    description: "Drag-drop cache listesini gösterir",
    handler: async (_args, ctx) => {
      const cache = ensureSessionDragCache(state, ctx);
      if (!cache || cache.entriesByMarker.size === 0) {
        ctx?.ui?.notify("Drag cache boş.", "info");
        return;
      }

      const rows = Array.from(cache.entriesByMarker.values())
        .map((entry) => `${entry.marker} -> ${entry.cachedPath}`)
        .join("\n");

      ctx?.ui?.pasteToEditor(`${rows}\n`);
      ctx?.ui?.notify(`Drag cache (${cache.entriesByMarker.size}) yolları editöre eklendi.`, "info");
    },
  });

  pi.on("input", (event, ctx) => {
    const originalText = typeof event?.text === "string" ? event.text : "";

    let workingText = originalText;
    let workingImages = Array.isArray(event?.images) ? [...event.images] : [];
    let changed = false;

    if (workingText) {
      const inlineImageEntry = copyInlineImagePayloadToSessionCache(state, ctx, workingText);
      if (inlineImageEntry) {
        workingText = inlineImageEntry.marker;
        changed = true;
      } else if (containsLikelyInlineImagePayload(workingText)) {
        const deferredEntry = createDeferredInlineImageEntry(state, ctx, workingText);
        if (deferredEntry) {
          workingText = deferredEntry.marker;
          changed = true;
        }
      }

      const transformed = transformDroppedPasteText(state, ctx, workingText);
      if (transformed.transformedCount > 0) {
        workingText = transformed.transformed;
        changed = true;
      }
    }

    if (
      workingText.includes("[Image#")
      || workingText.includes("[File#")
      || workingText.includes("[Image #")
      || workingText.includes("[File #")
      || workingText.includes("[Image-Clipboard#")
      || workingText.includes("[Image-ClipBoard#")
    ) {

      const materialized = materializeDragMarkersInPrompt(state, ctx, workingText, workingImages);
      if (materialized.changed) {
        workingText = materialized.text;
        workingImages = materialized.images;
        changed = true;
      }
    }

    if (!changed) {
      return { action: "continue" };
    }

    if (ctx?.hasUI) {
      ctx.ui.setStatus(DRAG_CACHE_STATUS_KEY, "Drag marker/path attach edildi");
    }

    return {
      action: "transform",
      text: workingText,
      images: workingImages,
    };
  });

  const installFooter = (ctx) => {
    if (!ctx?.hasUI) return;

    state.ctx = ctx;
    state.currentModel = ctx.model;

    installTerminalInputHandler(ctx);
    ensureDraftReconcileTimer();

    ctx.ui.setFooter((tui, theme, footerData) => {
      state.requestRender = () => tui.requestRender();
      const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

      return {
        render(width) {
          const activeCtx = state.ctx || ctx;
          const model = state.currentModel || activeCtx.model;
          const usageTotals = activeCtx.sessionManager.getUsageTotals();
          const contextUsage = activeCtx.getContextUsage();

          let pwd = process.cwd();
          const home = process.env.HOME || process.env.USERPROFILE;
          if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;

          const branch = footerData.getGitBranch();
          if (branch) pwd = `${pwd} (${branch})`;

          const sessionName = activeCtx.sessionManager.getSessionName?.();
          if (sessionName) pwd = `${pwd} • ${sessionName}`;

          const sep = ` ${theme.fg("dim", "·")} `;
          const groups = [];

          if (usageTotals.input) groups.push(`↑${formatTokens(usageTotals.input)}`);
          if (usageTotals.output) groups.push(`↓${formatTokens(usageTotals.output)}`);
          if (usageTotals.cacheRead) groups.push(`cr:${formatTokens(usageTotals.cacheRead)}`);
          if (usageTotals.cacheWrite) groups.push(`cw:${formatTokens(usageTotals.cacheWrite)}`);
          if (Number.isFinite(usageTotals.cost) && usageTotals.cost > 0) groups.push(formatUsd(usageTotals.cost));

          const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
          const contextPercent = contextUsage?.percent;
          const contextText = contextPercent == null
            ? `ctx ?/${formatTokens(contextWindow)}`
            : `ctx ${contextPercent.toFixed(1)}%/${formatTokens(contextWindow)}`;

          let coloredContext = contextText;
          if (Number.isFinite(contextPercent)) {
            if (contextPercent > 90) coloredContext = theme.fg("error", contextText);
            else if (contextPercent > 70) coloredContext = theme.fg("warning", contextText);
          }
          groups.push(coloredContext);

          if (model && isOpenAIModel(model)) {
            groups.push(renderWindow(state.usage.fiveHour, theme));
            groups.push(renderWindow(state.usage.weekly, theme));
          }

          if (model && isOpenAICodexModel(model)) {
            const accountBadges = renderOpenAIAccountBadges(state, theme);
            if (accountBadges) groups.push(accountBadges);
          }

          let left = groups.join(sep);
          let leftWidth = visibleWidth(left);

          const provider = providerDisplayName(model?.provider);
          const modelLabel = model?.id || "no-model";
          const right = `(${provider}) ${modelLabel}`;
          const rightWidth = visibleWidth(right);

          if (leftWidth > width) {
            left = truncateToWidth(left, width, "...");
            leftWidth = visibleWidth(left);
          }

          let statsLine;
          if (leftWidth + 2 + rightWidth <= width) {
            const padding = " ".repeat(Math.max(2, width - leftWidth - rightWidth));
            statsLine = left + padding + right;
          } else {
            statsLine = truncateToWidth(left, width, "...");
          }

          const lines = [
            truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")),
            theme.fg("dim", statsLine),
          ];

          const extensionStatuses = footerData.getExtensionStatuses();
          if (extensionStatuses.size > 0) {
            const sortedStatuses = Array.from(extensionStatuses.entries())
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([, text]) => sanitizeStatusText(text));
            const statusLine = sortedStatuses.join(" ");
            lines.push(truncateToWidth(theme.fg("dim", statusLine), width, theme.fg("dim", "...")));
          }

          return lines;
        },
        invalidate() {},
        dispose() {
          unsubBranch?.();
        },
      };
    });

    state.footerInstalled = true;
  };

  installOpenAICodexMultiProvider();

  pi.on("session_start", (_event, ctx) => {
    installFooter(ctx);
    ensureSessionDragCache(state, ctx);
    syncOpenAIAccountsFromAuth(ctx, { upgradeLegacy: true });
    ensureTimer();
    queueMicrotask(() => {
      reconcileEditorImagePaths(ctx, "session-start");
    });
    refreshUsage().catch(() => {});
  });

  pi.on("session_switch", (_event, ctx) => {
    state.ctx = ctx;
    state.currentModel = ctx.model;
    installFooter(ctx);
    ensureSessionDragCache(state, ctx);
    syncOpenAIAccountsFromAuth(ctx);
    queueMicrotask(() => {
      reconcileEditorImagePaths(ctx, "session-switch");
    });
    refreshUsage().catch(() => {});
  });

  pi.on("turn_start", (_event, ctx) => {
    state.ctx = ctx;
    state.currentModel = ctx.model;

    if (!state.footerInstalled) {
      installFooter(ctx);
    }

    // Bazı çalışma akışlarında terminal input subscription'ı task sonrası düşebiliyor.
    // Her turn başında yeniden doğrulayıp drop-cache'in canlı kalmasını sağla.
    installTerminalInputHandler(ctx);

    ensureSessionDragCache(state, ctx);
    syncOpenAIAccountsFromAuth(ctx);
    queueMicrotask(() => {
      reconcileEditorImagePaths(ctx, "turn-start");
    });
  });

  pi.on("model_select", (event, ctx) => {
    state.ctx = ctx;
    state.currentModel = event.model;
    installFooter(ctx);
    syncOpenAIAccountsFromAuth(ctx);
    refreshUsage().catch(() => {});
  });

  pi.on("message_end", (_event, ctx) => {
    state.ctx = ctx;
    clearPendingStopRetry();
    installTerminalInputHandler(ctx);
    ctx?.ui?.setStatus?.(STOP_STATUS_KEY, undefined);
    syncOpenAIAccountsFromAuth(ctx);
    renderNow();
  });

  pi.on("turn_end", (_event, ctx) => {
    state.ctx = ctx;
    clearPendingStopRetry();
    installTerminalInputHandler(ctx);
    ctx?.ui?.setStatus?.(STOP_STATUS_KEY, undefined);
    syncOpenAIAccountsFromAuth(ctx);
    renderNow();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearPendingStopRetry();
    clearDraftReconcileTimer();
    clearTimer();
    closeSwapPicker();

    if (typeof state.terminalInputUnsub === "function") {
      try {
        state.terminalInputUnsub();
      } catch {
        // ignore unsubscribe edge cases
      }
      state.terminalInputUnsub = null;
    }

    // Task sınırlarında session lifecycle resetlenebildiği için drag-cache'i burada silmiyoruz.
    // Böylece marker -> dosya çözümü aynı gsd çalışması boyunca stabil kalıyor.
    ctx?.ui?.setStatus?.(DRAG_CACHE_STATUS_KEY, undefined);
    ctx?.ui?.setStatus?.(STOP_STATUS_KEY, undefined);
    state.footerInstalled = false;
  });

  process.once("exit", () => {
    clearDraftReconcileTimer();
    clearAllDragCaches(state);
  });
}

