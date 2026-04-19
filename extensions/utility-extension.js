import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

const DRAG_CACHE_STATUS_KEY = "drag-cache";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const DRAG_CACHE_ROOT = path.join(os.tmpdir(), "gsd-drag-cache");
const DROP_CAPTURE_STALE_MS = 2000;

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

function sanitizeStatusText(text) {
  return String(text).replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
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

  token = token.replace(/\\([\\\s'\"()\[\]{}])/g, "$1");

  if (token.startsWith("~/")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    if (home) token = path.join(home, token.slice(2));
  }

  return token;
}

function looksLikePathToken(decoded) {
  return decoded.startsWith("/") || decoded.startsWith("~/") || decoded.startsWith("./") || decoded.startsWith("../");
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
  }

  return state.dragCacheBySessionId.get(sessionId);
}

function copyDroppedPathToSessionCache(state, ctx, rawToken) {
  const decoded = decodePastedPathToken(rawToken);
  if (!decoded || !looksLikePathToken(decoded)) return null;

  const absolutePath = path.resolve(decoded);
  let stat;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    return null;
  }

  if (!stat.isFile()) return null;

  const cache = ensureSessionDragCache(state, ctx);
  if (!cache) return null;

  const existing = cache.entriesBySourcePath.get(absolutePath);
  if (existing) return existing;

  const mimeType = toImageMimeType(absolutePath);
  const kind = mimeType ? "image" : "file";
  const marker = kind === "image"
    ? `[Image #${cache.nextImageIndex++}]`
    : `[File #${cache.nextFileIndex++}]`;

  const sourceBase = path.basename(absolutePath);
  const safeBase = sanitizeFileName(sourceBase);
  const stampedName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeBase}`;
  const cachedPath = path.join(cache.dir, stampedName);

  try {
    fs.copyFileSync(absolutePath, cachedPath);
  } catch {
    return null;
  }

  const entry = {
    marker,
    kind,
    mimeType,
    sourcePath: absolutePath,
    cachedPath,
  };

  cache.entriesByMarker.set(marker, entry);
  cache.entriesBySourcePath.set(absolutePath, entry);
  return entry;
}

function transformDroppedPasteText(state, ctx, pastedText) {
  let transformedCount = 0;
  let attemptedPathCount = 0;
  const markers = [];

  const transformed = String(pastedText || "").replace(
    /'[^']+'|"[^"]+"|‘[^’]+’|“[^”]+”|(?:~|\/|\.\.?\/)(?:\\.|[^\s])+/g,
    (token) => {
      const decoded = decodePastedPathToken(token);
      if (decoded && looksLikePathToken(decoded)) {
        attemptedPathCount += 1;
      }

      const entry = copyDroppedPathToSessionCache(state, ctx, token);
      if (!entry) return token;
      transformedCount += 1;
      markers.push(entry.marker);
      return entry.marker;
    },
  );

  if (attemptedPathCount > 0 && transformedCount === 0 && /\/var\/folders\//.test(String(pastedText || "")) && ctx?.hasUI) {
    ctx.ui.setStatus(DRAG_CACHE_STATUS_KEY, "Drag path yakalandı ama dosya kopyalanamadı (muhtemelen silinmiş)");
  }

  return { transformed, transformedCount, markers };
}

function transformTerminalInputForDropCache(state, ctx, data) {
  if (typeof data !== "string" || data.length === 0) return undefined;

  const initiallyActive = !!state.dropPasteCapture.active;
  let output = "";
  let index = 0;
  const allMarkers = [];
  let transformedCount = 0;

  while (index < data.length) {
    if (!state.dropPasteCapture.active) {
      const startIdx = data.indexOf(BRACKETED_PASTE_START, index);
      if (startIdx === -1) {
        output += data.slice(index);
        break;
      }

      output += data.slice(index, startIdx);
      state.dropPasteCapture.active = true;
      state.dropPasteCapture.buffer = "";
      state.dropPasteCapture.startedAt = Date.now();
      index = startIdx + BRACKETED_PASTE_START.length;
      continue;
    }

    const endIdx = data.indexOf(BRACKETED_PASTE_END, index);
    if (endIdx === -1) {
      const chunk = data.slice(index);

      // Paste capture modundayken farklı bir escape geldi ise (örn Esc), yakalamayı bırak.
      if (chunk.includes("\x1b")) {
        output += state.dropPasteCapture.buffer + chunk;
        state.dropPasteCapture.active = false;
        state.dropPasteCapture.buffer = "";
        state.dropPasteCapture.startedAt = 0;
        index = data.length;
        break;
      }

      state.dropPasteCapture.buffer += chunk;

      const age = Date.now() - Number(state.dropPasteCapture.startedAt || Date.now());
      if (age > DROP_CAPTURE_STALE_MS) {
        // Bracketed paste kapanış marker'ı hiç gelmediyse input'u kilitleme.
        output += state.dropPasteCapture.buffer;
        state.dropPasteCapture.active = false;
        state.dropPasteCapture.buffer = "";
        state.dropPasteCapture.startedAt = 0;
      }

      index = data.length;
      break;
    }

    state.dropPasteCapture.buffer += data.slice(index, endIdx);
    const result = transformDroppedPasteText(state, ctx, state.dropPasteCapture.buffer);

    output += `${BRACKETED_PASTE_START}${result.transformed}${BRACKETED_PASTE_END}`;
    transformedCount += result.transformedCount;
    allMarkers.push(...result.markers);

    state.dropPasteCapture.active = false;
    state.dropPasteCapture.buffer = "";
    state.dropPasteCapture.startedAt = 0;
    index = endIdx + BRACKETED_PASTE_END.length;
  }

  // Bazı terminallerde bracketed paste kapalı olabilir; tek-chunk path paste için fallback.
  if (transformedCount === 0 && !state.dropPasteCapture.active && !data.includes("\x1b")) {
    const fallback = transformDroppedPasteText(state, ctx, data);
    if (fallback.transformedCount > 0) {
      output = fallback.transformed;
      transformedCount = fallback.transformedCount;
      allMarkers.push(...fallback.markers);
    }
  }

  if (transformedCount > 0 && ctx?.hasUI) {
    const preview = allMarkers.slice(0, 3).join(" ");
    const suffix = allMarkers.length > 3 ? " …" : "";
    ctx.ui.notify(`Drag cache: ${allMarkers.length} dosya yakalandı ${preview}${suffix}`, "info");
    ctx.ui.setStatus(DRAG_CACHE_STATUS_KEY, `Drag cache active · ${allMarkers.length} marker`);
  }

  const changed = output !== data;
  if (!changed && !initiallyActive && !state.dropPasteCapture.active) {
    return undefined;
  }

  return { data: output };
}

function materializeDragMarkersInPrompt(state, ctx, text, images) {
  const cache = ensureSessionDragCache(state, ctx);
  if (!cache) return { changed: false, text, images };

  let nextText = String(text || "");
  const nextImages = Array.isArray(images) ? [...images] : [];
  let changed = false;

  for (const [marker, entry] of cache.entriesByMarker.entries()) {
    if (!nextText.includes(marker)) continue;

    if (entry.kind === "image") {
      try {
        const data = fs.readFileSync(entry.cachedPath).toString("base64");
        nextImages.push({
          type: "image",
          data,
          mimeType: entry.mimeType || "image/png",
        });
        changed = true;
      } catch {
        // If image materialization fails, keep marker text unchanged.
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
    openaiAccounts: [],
    activeOpenAIAccountId: null,
    swapPicker: {
      active: false,
      selectedId: null,
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

    if (matchesKey(data, Key.escape) || matchesKey(data, Key.esc)) {
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
      const swapResult = handleSwapTerminalInput(data, ctx);
      if (swapResult?.consume) return swapResult;

      return transformTerminalInputForDropCache(state, ctx, data);
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

  // Double-Escape normally arrives as ctrl+alt+[ in terminal key parsing.
  pi.registerShortcut(Key.ctrlAlt("["), {
    description: "Stop auto mode (double Esc)",
    handler: async (ctx) => {
      if (ctx?.hasUI) {
        ctx.ui.notify("Double Esc detected: sending /gsd stop", "info");
      }
      pi.sendUserMessage("/gsd stop", { deliverAs: "steer" });
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
      const transformed = transformDroppedPasteText(state, ctx, workingText);
      if (transformed.transformedCount > 0) {
        workingText = transformed.transformed;
        changed = true;
      }
    }

    if (workingText.includes("[Image #") || workingText.includes("[File #")) {
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
    refreshUsage().catch(() => {});
  });

  pi.on("session_switch", (_event, ctx) => {
    state.ctx = ctx;
    state.currentModel = ctx.model;
    installFooter(ctx);
    ensureSessionDragCache(state, ctx);
    syncOpenAIAccountsFromAuth(ctx);
    refreshUsage().catch(() => {});
  });

  pi.on("turn_start", (_event, ctx) => {
    if (!state.footerInstalled) {
      installFooter(ctx);
    }
    ensureSessionDragCache(state, ctx);
    syncOpenAIAccountsFromAuth(ctx);
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
    syncOpenAIAccountsFromAuth(ctx);
    renderNow();
  });

  pi.on("turn_end", (_event, ctx) => {
    state.ctx = ctx;
    syncOpenAIAccountsFromAuth(ctx);
    renderNow();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearTimer();
    closeSwapPicker();
    if (typeof state.terminalInputUnsub === "function") {
      state.terminalInputUnsub();
      state.terminalInputUnsub = null;
    }
    clearAllDragCaches(state);
    ctx?.ui?.setStatus?.(DRAG_CACHE_STATUS_KEY, undefined);
    state.footerInstalled = false;
  });
}
