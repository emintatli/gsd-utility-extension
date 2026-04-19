import { Key, truncateToWidth, visibleWidth } from "@gsd/pi-tui";

const REFRESH_MS = 5 * 60 * 1000;
const DEFAULT_WHAM_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const FIVE_HOURS_SECONDS = 18_000;
const WEEK_SECONDS = 604_800;

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

function providerDisplayName(provider) {
  const p = String(provider || "").toLowerCase();
  if (!p) return "unknown";
  if (p === "openai") return "OpenAI";
  if (p === "openai-codex") return "OpenAI Codex";
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
  return (
    process.env.CHATGPT_USER_AGENT ||
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );
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

function createState() {
  return {
    ctx: null,
    currentModel: null,
    requestRender: null,
    timer: null,
    inFlight: false,
    footerInstalled: false,
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

export default function registerExtension(pi) {
  const state = createState();

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

  const renderNow = () => {
    if (typeof state.requestRender === "function") state.requestRender();
  };

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
      const accountId = resolveAccountIdHeader({ model, authorization });
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

  const installFooter = (ctx) => {
    if (!ctx?.hasUI) return;

    state.ctx = ctx;
    state.currentModel = ctx.model;

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

  pi.on("session_start", (_event, ctx) => {
    installFooter(ctx);
    ensureTimer();
    refreshUsage().catch(() => {});
  });

  pi.on("turn_start", (_event, ctx) => {
    if (!state.footerInstalled) {
      installFooter(ctx);
    }
  });

  pi.on("model_select", (event, ctx) => {
    state.ctx = ctx;
    state.currentModel = event.model;
    installFooter(ctx);
    refreshUsage().catch(() => {});
  });

  pi.on("message_end", (_event, ctx) => {
    state.ctx = ctx;
    renderNow();
  });

  pi.on("turn_end", (_event, ctx) => {
    state.ctx = ctx;
    renderNow();
  });

  pi.on("session_shutdown", () => {
    clearTimer();
    state.footerInstalled = false;
  });
}
