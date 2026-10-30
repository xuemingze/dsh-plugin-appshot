window.__ModuleLoader__.load({ id: 'dsh-plugin-appshot', factory: (require) => { var module = { exports: {} }; var exports = module.exports;
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.ts
var client_exports = {};
__export(client_exports, {
  AppshotSettingsSection: () => AppshotSettingsSection,
  ackBackoffDelay: () => ackBackoffDelay,
  apply: () => apply,
  applyMacosClient: () => applyMacosClient,
  applyWindowsClient: () => applyWindowsClient,
  createAppshotClient: () => createAppshotClient,
  inject: () => inject,
  isWindowsPlatform: () => isWindowsPlatform,
  runW0DraftVerify: () => runW0DraftVerify
});
module.exports = __toCommonJS(client_exports);

// src/client/context.ts
function mainSessionId(snapshot) {
  return Object.values(snapshot.byId).find((session) => (session.retainedBy?.mainView ?? 0) > 0)?.id;
}

// src/client/windows.ts
function appshotUrl(path) {
  const origin = globalThis.location?.origin;
  const base = origin !== void 0 && origin !== "null" ? origin : "http://dsh.internal";
  return new URL(path, base);
}
function ackBackoffDelay(attempt) {
  return Math.min(1e3 * Math.pow(2, attempt), 4e3);
}
function isWindowsPlatform() {
  if (typeof navigator !== "undefined") {
    if (navigator.platform && /win/i.test(navigator.platform)) return true;
    if (navigator.userAgent && /windows/i.test(navigator.userAgent)) return true;
  }
  if (typeof location !== "undefined" && location.search && location.search.includes("platform=win32")) {
    return true;
  }
  return false;
}
function getClientInstanceId() {
  if (typeof sessionStorage === "undefined") return "client-fallback-id";
  let id = sessionStorage.getItem("dsh-appshot-client-id");
  if (!id) {
    id = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `client-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem("dsh-appshot-client-id", id);
  }
  return id;
}
function getCachedDraft(captureId) {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(`dsh-appshot-draft-${captureId}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
var DRAFT_INDEX_KEY = "dsh-appshot-draft-index";
function setCachedDraft(captureId, record) {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(`dsh-appshot-draft-${captureId}`, JSON.stringify(record));
    const rawIndex = sessionStorage.getItem(DRAFT_INDEX_KEY);
    let index = [];
    try {
      const parsed = JSON.parse(rawIndex ?? "[]");
      if (Array.isArray(parsed)) index = parsed.filter((x) => typeof x === "string");
    } catch {
      index = [];
    }
    if (!index.includes(captureId)) index.push(captureId);
    if (index.length > 50) {
      const overflow = index.slice(0, index.length - 50);
      index = index.slice(index.length - 50);
      for (const old of overflow) sessionStorage.removeItem(`dsh-appshot-draft-${old}`);
    }
    sessionStorage.setItem(DRAFT_INDEX_KEY, JSON.stringify(index));
  } catch {
  }
}
function removeCachedDraft(captureId) {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(`dsh-appshot-draft-${captureId}`);
  } catch {
  }
}
function applyWindowsClient(ctx) {
  console.log("[dsh-plugin-appshot:client] applying windows client runtime (long polling + silent draft)...");
  const clientInstanceId = getClientInstanceId();
  let aborted = false;
  let currentSessionId = void 0;
  let retryTimer = null;
  const syncSession = async (claimPendingCaptureId) => {
    if (aborted) return null;
    const snapshot = ctx.sessions.list.getSnapshot();
    const sessionId = mainSessionId(snapshot);
    if (sessionId !== currentSessionId || claimPendingCaptureId) {
      currentSessionId = sessionId;
      if (sessionId) {
        try {
          const body = {
            sessionId,
            clientInstanceId
          };
          if (claimPendingCaptureId) body.claimPendingCaptureId = claimPendingCaptureId;
          const res = await fetch(appshotUrl("/plugins/appshot/session").toString(), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
          });
          if (res.status === 200 && claimPendingCaptureId) {
            const data = await res.json();
            if (typeof data.captureId === "string" && (typeof data.targetSessionId === "string" || data.targetSessionId === null)) {
              return { captureId: data.captureId, targetSessionId: data.targetSessionId };
            }
          }
        } catch {
        }
      }
    }
    return null;
  };
  const tryClaimPending = async () => {
    if (aborted || pendingClaims.size === 0) return;
    const snapshot = ctx.sessions.list.getSnapshot();
    const sessionId = mainSessionId(snapshot);
    if (!sessionId) return;
    for (const [captureId] of pendingClaims) {
      const claimResult = await syncSession(captureId);
      if (claimResult && claimResult.captureId === captureId) {
        pendingClaims.delete(captureId);
        console.log("[dsh-plugin-appshot:client] claim accepted for", captureId, "->", claimResult.targetSessionId);
      }
    }
  };
  const sessionCheckTimer = setInterval(() => {
    void syncSession();
    void tryClaimPending();
  }, 1e3);
  void syncSession();
  const sendDeliveryResult = async (captureId, targetSessionId, status) => {
    let delay = 1e3;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (aborted) return;
      try {
        const res = await fetch(appshotUrl("/plugins/appshot/delivery-result").toString(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ captureId, clientInstanceId, targetSessionId, status })
        });
        if (res.status === 200 || res.status === 409) return;
      } catch (err) {
        console.warn("[dsh-plugin-appshot:client] delivery result post failed (attempt " + attempt + "):", err);
      }
      await new Promise((r2) => setTimeout(r2, delay));
      delay = Math.min(delay * 2, 4e3);
    }
    console.warn("[dsh-plugin-appshot:client] delivery result not confirmed after retries:", captureId);
  };
  let pendingRetry = null;
  const pendingClaims = /* @__PURE__ */ new Map();
  const scheduleRetry = (captureId, targetSessionId, draftId, count) => {
    if (aborted) return;
    if (retryTimer) clearTimeout(retryTimer);
    const delay = count <= 5 ? 500 : 3e3;
    retryTimer = setTimeout(async () => {
      if (aborted || !pendingRetry || pendingRetry.captureId !== captureId) return;
      const scope = ctx.sessions.scope(targetSessionId);
      if (scope === void 0) {
        await sendDeliveryResult(captureId, targetSessionId, "SESSION_MISMATCH");
        return;
      }
      try {
        const input = ctx.conversation.input.for(scope);
        const accepted = input.addAttachments([draftId]);
        if (accepted) {
          setCachedDraft(captureId, { captureId, sessionId: targetSessionId, draftId, mountedAt: Date.now() });
          pendingRetry = null;
          await sendDeliveryResult(captureId, targetSessionId, "MOUNTED");
        } else {
          pendingRetry.retryCount++;
          await sendDeliveryResult(captureId, targetSessionId, "BUSY");
          scheduleRetry(captureId, targetSessionId, draftId, pendingRetry.retryCount);
        }
      } catch (err) {
        console.error("[dsh-plugin-appshot:client] retry mount failed:", err);
      }
    }, delay);
  };
  const handleReadyFrame = async (frame) => {
    if (frame.targetClientInstanceId !== clientInstanceId) return;
    const { captureId, targetSessionId, dataBase64 } = frame;
    if (!targetSessionId) {
      pendingClaims.set(captureId, { captureId, draftId: null });
      await sendDeliveryResult(captureId, "", "NO_SESSION");
      return;
    }
    const cached = getCachedDraft(captureId);
    if (cached && cached.sessionId === targetSessionId) {
      const scope2 = ctx.sessions.scope(targetSessionId);
      if (scope2 !== void 0) {
        const shell = ctx.conversation.input.for(scope2);
        const attachmentIds = shell.snapshot.attachmentIds;
        const activeDrafts = ctx.conversation.resolveDraftAttachments([cached.draftId]);
        if (attachmentIds.includes(cached.draftId) && activeDrafts.length === 1) {
          await sendDeliveryResult(captureId, targetSessionId, "MOUNTED");
          return;
        }
      }
      removeCachedDraft(captureId);
    }
    const scope = ctx.sessions.scope(targetSessionId);
    if (scope === void 0) {
      pendingClaims.set(captureId, { captureId, draftId: null });
      await sendDeliveryResult(captureId, targetSessionId, "SESSION_MISMATCH");
      return;
    }
    try {
      const bytes = Uint8Array.from(atob(dataBase64), (c) => c.charCodeAt(0));
      const fileName = `${frame.metadata?.appName ?? "appshot"}.png`;
      const file = new File([bytes], fileName, { type: "image/png" });
      const [draft] = ctx.conversation.createDrafts(targetSessionId, [file]);
      if (!draft) return;
      const input = ctx.conversation.input.for(scope);
      const accepted = input.addAttachments([draft.id]);
      if (accepted) {
        setCachedDraft(captureId, { captureId, sessionId: targetSessionId, draftId: draft.id, mountedAt: Date.now() });
        await sendDeliveryResult(captureId, targetSessionId, "MOUNTED");
      } else {
        pendingRetry = { captureId, targetSessionId, draftId: draft.id, retryCount: 1 };
        await sendDeliveryResult(captureId, targetSessionId, "BUSY");
        scheduleRetry(captureId, targetSessionId, draft.id, 1);
      }
    } catch (err) {
      console.error("[dsh-plugin-appshot:client] windows silent mount failed:", err);
    }
  };
  const handleCancelledFrame = (captureId) => {
    if (pendingRetry && pendingRetry.captureId === captureId) {
      if (retryTimer) clearTimeout(retryTimer);
      const { targetSessionId, draftId } = pendingRetry;
      pendingRetry = null;
      const scope = ctx.sessions.scope(targetSessionId);
      if (scope !== void 0) {
        try {
          const input = ctx.conversation.input.for(scope);
          input.removeAttachment(draftId);
          ctx.conversation.releaseDraftAttachment(draftId);
        } catch {
        }
      }
    }
    removeCachedDraft(captureId);
    pendingClaims.delete(captureId);
  };
  let knownCaptureId = null;
  let knownTargetSessionId = null;
  let backoffDelay = 1e3;
  const pollLoop = async () => {
    while (!aborted) {
      try {
        const url = appshotUrl("/plugins/appshot/pending");
        url.searchParams.set("clientInstanceId", clientInstanceId);
        if (knownCaptureId) url.searchParams.set("knownCaptureId", knownCaptureId);
        if (knownTargetSessionId) url.searchParams.set("knownTargetSessionId", knownTargetSessionId);
        const res = await fetch(url.toString(), { method: "GET" });
        backoffDelay = 1e3;
        if (res.status === 200) {
          const body = await res.json();
          if (body.type === "appshot/ready") {
            const readyFrame = body;
            knownCaptureId = readyFrame.captureId;
            knownTargetSessionId = readyFrame.targetSessionId;
            await handleReadyFrame(readyFrame);
          } else if (body.type === "appshot/cancelled") {
            const cancelledId = typeof body.captureId === "string" ? body.captureId : "";
            handleCancelledFrame(cancelledId);
            knownCaptureId = null;
            knownTargetSessionId = null;
          } else if (body.type === "appshot/completed") {
            knownCaptureId = null;
            knownTargetSessionId = null;
          }
        } else if (res.status === 204) {
        } else if (res.status === 409) {
          knownCaptureId = null;
          knownTargetSessionId = null;
        }
      } catch {
        if (aborted) break;
        await new Promise((r) => setTimeout(r, backoffDelay));
        backoffDelay = Math.min(backoffDelay * 2, 4e3);
      }
    }
  };
  void pollLoop();
  ctx.effect(() => () => {
    aborted = true;
    clearInterval(sessionCheckTimer);
    if (retryTimer) clearTimeout(retryTimer);
  });
}

// src/client/macos.ts
function createAppshotClient(deps) {
  let unsubscribe = null;
  const handleFrame = (frame) => {
    if (!frame || typeof frame !== "object") return;
    const candidate = frame;
    if (candidate.type !== "appshot/ready") return;
    if (!candidate.attachmentRef || typeof candidate.attachmentRef !== "object") return;
    const activeSessionId = deps.getActiveSessionId();
    if (!activeSessionId) {
      deps.onNeedSession?.();
      return;
    }
    deps.composer.appendDraft(activeSessionId, candidate.attachmentRef);
    deps.composer.focus();
  };
  return {
    start() {
      if (unsubscribe) return;
      unsubscribe = deps.subscribe(handleFrame);
    },
    dispose() {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    }
  };
}
function isReadyFrame(frame) {
  if (!frame || typeof frame !== "object") return false;
  const candidate = frame;
  return candidate.type === "appshot/ready" && !!candidate.attachmentRef && typeof candidate.attachmentRef.attachmentId === "string" && typeof candidate.attachmentRef.mediaType === "string";
}
function applyMacosClient(ctx) {
  if (typeof window === "undefined" || typeof EventSource === "undefined") {
    console.warn("[dsh-plugin-appshot:client] no browser EventSource; client half disabled");
    return;
  }
  const es = new EventSource("/plugins/appshot/events");
  es.addEventListener("open", () => {
    console.log("[dsh-plugin-appshot:client] SSE open", es.url);
  });
  const handleFrame = async (frame) => {
    if (!isReadyFrame(frame)) return;
    const sessionId = mainSessionId(ctx.sessions.list.getSnapshot());
    const scope = sessionId === void 0 ? void 0 : ctx.sessions.scope(sessionId);
    console.log("[dsh-plugin-appshot:client] ready frame", {
      sessionId: sessionId ?? null,
      dataBase64Chars: frame.dataBase64?.length ?? 0
    });
    if (sessionId === void 0 || scope === void 0) {
      console.warn("[dsh-plugin-appshot:client] no main session; attachment saved on host, not mounted");
      return;
    }
    const input = ctx.conversation.input.for(scope);
    if (!frame.dataBase64) {
      input.notify("error", "\u622A\u56FE\u5E27\u7F3A\u5C11\u56FE\u50CF\u5B57\u8282\uFF0C\u65E0\u6CD5\u6302\u8F7D\u8349\u7A3F");
      return;
    }
    try {
      const bytes = Uint8Array.from(atob(frame.dataBase64), (c) => c.charCodeAt(0));
      const file = new File([bytes], frame.attachmentRef.name ?? "\u7A97\u53E3\u622A\u56FE.png", {
        type: frame.attachmentRef.mediaType
      });
      const [draft] = ctx.conversation.createDrafts(sessionId, [file]);
      if (draft === void 0) return;
      const accepted = input.addAttachments([draft.id]);
      if (!accepted) {
        input.notify("info", "Composer \u7E41\u5FD9\uFF0C\u622A\u56FE\u5DF2\u4FDD\u5B58\u4E3A\u9644\u4EF6\uFF0C\u672A\u6302\u5165\u8349\u7A3F");
        return;
      }
      console.log("[dsh-plugin-appshot:client] draft image mounted:", draft.id);
      input.focus();
    } catch (err) {
      input.notify("error", `\u622A\u56FE\u6302\u8F7D\u5931\u8D25: ${String(err)}`);
    }
  };
  es.addEventListener("appshot/ready", (event) => {
    const msg = event;
    try {
      void handleFrame(JSON.parse(msg.data));
    } catch (err) {
      console.error("[dsh-plugin-appshot:client] failed to parse SSE event:", err);
    }
  });
  es.onerror = () => {
    console.warn("[dsh-plugin-appshot:client] SSE connection error (will auto-reconnect)");
  };
  ctx.effect(() => {
    return () => {
      es.close();
    };
  });
}

// src/client/settings.ts
var import_react = __toESM(require("react"), 1);
var h = import_react.default.createElement;
var MODIFIER_LABELS = {
  lctrl: "\u5DE6 Ctrl",
  rctrl: "\u53F3 Ctrl",
  lalt: "\u5DE6 Alt",
  ralt: "\u53F3 Alt",
  lshift: "\u5DE6 Shift",
  rshift: "\u53F3 Shift"
};
var MODIFIER_CODES = {
  ControlLeft: "lctrl",
  ControlRight: "rctrl",
  AltLeft: "lalt",
  AltRight: "ralt",
  ShiftLeft: "lshift",
  ShiftRight: "rshift"
};
var selectStyle = {
  background: "var(--dsw-alias-bg-layer-3, #27272a)",
  color: "var(--dsw-alias-label-primary, #fafafa)",
  border: "1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.12))",
  borderRadius: "8px",
  padding: "6px 12px",
  fontSize: "13px",
  outline: "none",
  cursor: "pointer"
};
function AppshotSettingsSection() {
  const isWinClient = typeof navigator !== "undefined" && /Win/i.test(navigator.userAgent || "");
  const [config, setConfig] = (0, import_react.useState)({
    platform: isWinClient ? "win32" : "darwin",
    shortcutMode: isWinClient ? "double-ctrl" : "dual-cmd",
    windowsHotkeys: { left: "lctrl", right: "rctrl" },
    soundEnabled: true,
    animationEnabled: true
  });
  const [loading, setLoading] = (0, import_react.useState)(true);
  const [saving, setSaving] = (0, import_react.useState)(false);
  const [savedBadge, setSavedBadge] = (0, import_react.useState)(false);
  (0, import_react.useEffect)(() => {
    let unmounted = false;
    fetch("/plugins/appshot/config").then((res) => res.json()).then((data) => {
      if (!unmounted && data && typeof data === "object") {
        const isWin2 = data.platform === "win32" || isWinClient;
        setConfig({
          platform: isWin2 ? "win32" : "darwin",
          shortcutMode: data.shortcutMode ?? (isWin2 ? "double-ctrl" : "dual-cmd"),
          windowsHotkeys: data.windowsHotkeys ?? { left: "lctrl", right: "rctrl" },
          soundEnabled: data.soundEnabled ?? true,
          animationEnabled: data.animationEnabled ?? true
        });
        setLoading(false);
      }
    }).catch((err) => {
      console.warn("[dsh-plugin-appshot:client] failed to fetch config:", err);
      if (!unmounted) setLoading(false);
    });
    return () => {
      unmounted = true;
    };
  }, []);
  const handleUpdate = async (patch) => {
    const next = { ...config, ...patch };
    setConfig(next);
    setSaving(true);
    try {
      const res = await fetch("/plugins/appshot/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch)
      });
      if (res.ok) {
        setSavedBadge(true);
        setTimeout(() => setSavedBadge(false), 2e3);
      }
    } catch (err) {
      console.error("[dsh-plugin-appshot:client] failed to save config:", err);
    } finally {
      setSaving(false);
    }
  };
  const isWin = config.platform === "win32" || isWinClient;
  const hotkeys = config.windowsHotkeys ?? { left: "lctrl", right: "rctrl" };
  const [recording, setRecording] = (0, import_react.useState)(false);
  const [pendingKey, setPendingKey] = (0, import_react.useState)(null);
  const cancelRecording = () => {
    setRecording(false);
    setPendingKey(null);
  };
  (0, import_react.useEffect)(() => {
    if (!recording) return;
    const onKeyDown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") {
        cancelRecording();
        return;
      }
      const mod = MODIFIER_CODES[e.code];
      if (!mod) return;
      if (pendingKey === null) {
        setPendingKey(mod);
        return;
      }
      if (pendingKey === mod) return;
      void handleUpdate({ windowsHotkeys: { left: pendingKey, right: mod } });
      cancelRecording();
    };
    const onKeyUp = (e) => {
      if (pendingKey !== null && MODIFIER_CODES[e.code] === pendingKey) {
        setPendingKey(null);
      }
    };
    const onBlur = () => cancelRecording();
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [recording, pendingKey]);
  return h(
    "div",
    {
      style: {
        padding: "24px",
        maxWidth: "680px",
        color: "var(--dsw-alias-label-primary, #e4e4e7)",
        fontFamily: 'var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif)',
        fontSize: "14px",
        lineHeight: 1.5
      }
    },
    // 头部区域
    h(
      "div",
      { style: { marginBottom: "24px" } },
      h(
        "div",
        { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px" } },
        h("h2", { style: { margin: 0, fontSize: "18px", fontWeight: 600, color: "var(--dsw-alias-label-primary, #fafafa)" } }, "\u622A\u56FE\u6355\u83B7 (Appshot)"),
        savedBadge ? h("span", {
          style: {
            fontSize: "12px",
            padding: "2px 8px",
            borderRadius: "9999px",
            background: "color-mix(in srgb, var(--dsw-alias-state-success-primary, rgb(34, 197, 94)) 15%, transparent)",
            color: "var(--dsw-alias-state-success-secondary, #4ade80)",
            border: "1px solid color-mix(in srgb, var(--dsw-alias-state-success-primary, rgb(34, 197, 94)) 30%, transparent)",
            transition: "all 0.2s"
          }
        }, "\u2713 \u5DF2\u5373\u65F6\u751F\u6548") : null
      ),
      h(
        "p",
        { style: { margin: 0, color: "var(--dsw-alias-label-secondary, #a1a1aa)", fontSize: "13px" } },
        isWin ? "\u6309\u4E0B\u5FEB\u6377\u952E\uFF0C\u622A\u53D6\u9F20\u6807\u6240\u5728\u5C4F\u5E55\u6700\u524D\u9762\u7684\u7A97\u53E3\uFF0C\u622A\u56FE\u4F1A\u81EA\u52A8\u51FA\u73B0\u5728 DSH \u7684\u8F93\u5165\u6846\u91CC\uFF0C\u968F\u4E0B\u4E00\u6761\u6D88\u606F\u4E00\u8D77\u53D1\u9001\u3002\u6700\u524D\u9762\u662F DSH \u81EA\u5DF1\u7684\u7A97\u53E3\u65F6\u4E0D\u4F1A\u622A\u56FE\u3002" : "\u6309\u4E0B\u5FEB\u6377\u952E\uFF0C\u622A\u53D6\u5F53\u524D\u6700\u524D\u9762\u7684\u7A97\u53E3\uFF0C\u622A\u56FE\u4F1A\u81EA\u52A8\u51FA\u73B0\u5728 DSH \u7684\u8F93\u5165\u6846\u91CC\uFF0C\u968F\u4E0B\u4E00\u6761\u6D88\u606F\u4E00\u8D77\u53D1\u9001\u3002"
      )
    ),
    // 主配置卡片
    h(
      "div",
      {
        style: {
          background: "var(--dsw-alias-bg-layer-2, #18181b)",
          border: "1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.08))",
          borderRadius: "12px",
          overflow: "hidden",
          boxShadow: "0 4px 12px rgba(0, 0, 0, 0.2)"
        }
      },
      // 项 1: 触发快捷键
      h(
        "div",
        {
          style: {
            padding: "16px 20px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.06))"
          }
        },
        h(
          "div",
          null,
          h("div", { style: { fontWeight: 500, color: "var(--dsw-alias-label-primary, #f4f4f5)", marginBottom: "2px" } }, "\u89E6\u53D1\u5FEB\u6377\u952E"),
          h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary, #71717a)" } }, "\u5728\u4EFB\u4F55\u5E94\u7528\u91CC\u6309\u4E0B\u5373\u53EF\u622A\u56FE\u7684\u5168\u5C40\u5FEB\u6377\u952E"),
          // 录键控件（仅 Windows 且选择自定义时展开）
          isWin && config.shortcutMode === "custom" ? h(
            "div",
            { style: { marginTop: "10px" } },
            h(
              "button",
              {
                onClick: () => recording ? cancelRecording() : (setPendingKey(null), setRecording(true)),
                style: {
                  background: recording ? "var(--dsw-alias-button-primary-fill, #3b82f6)" : "var(--dsw-alias-bg-layer-3, #27272a)",
                  color: recording ? "var(--dsw-alias-label-primary-foreground, #ffffff)" : "var(--dsw-alias-label-primary, #fafafa)",
                  border: "1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.12))",
                  borderRadius: "8px",
                  padding: "6px 14px",
                  fontSize: "13px",
                  cursor: "pointer",
                  outline: "none"
                }
              },
              recording ? pendingKey ? `\u5DF2\u5F55\u5165\u300C${MODIFIER_LABELS[pendingKey]}\u300D\uFF0C\u8BF7\u6309\u7B2C\u4E8C\u4E2A\u4FEE\u9970\u952E\u2026` : "\u8BF7\u540C\u65F6\u6309\u4F4F\u4E24\u4E2A\u4FEE\u9970\u952E\u2026\uFF08ESC \u53D6\u6D88\uFF09" : `${MODIFIER_LABELS[hotkeys.left]} + ${MODIFIER_LABELS[hotkeys.right]}\u3000\u70B9\u51FB\u4FEE\u6539`
            ),
            h(
              "div",
              { style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary, #71717a)", marginTop: "6px" } },
              "\u652F\u6301 Ctrl / Alt / Shift \u5DE6\u53F3\u952E\u4EFB\u610F\u7EC4\u5408\uFF1B\u4E0D\u542B Win \u952E\u3002\u542B Shift \u7684\u7EC4\u5408\u53EF\u80FD\u4E0E\u8F93\u5165\u6CD5\u5207\u6362\u51B2\u7A81\uFF0C\u8BF7\u81EA\u884C\u53D6\u820D\u3002"
            )
          ) : null
        ),
        h(
          "select",
          {
            value: config.shortcutMode,
            disabled: loading || saving,
            onChange: (e) => handleUpdate({ shortcutMode: e.target.value }),
            style: selectStyle
          },
          ...isWin ? [
            h("option", { key: "ctrl", value: "double-ctrl" }, "\u53CC Ctrl \u540C\u65F6\u6309\uFF08\u9ED8\u8BA4\uFF09"),
            h("option", { key: "custom", value: "custom" }, "\u81EA\u5B9A\u4E49\u4FEE\u9970\u952E\u7EC4\u5408")
          ] : [
            h("option", { key: "dual-cmd", value: "dual-cmd" }, "\u5DE6\u53F3 \u2318 Command \u540C\u65F6\u6309\uFF08\u9ED8\u8BA4\uFF09"),
            h("option", { key: "double-cmd", value: "double-cmd" }, "\u53CC\u51FB \u2318 Command"),
            h("option", { key: "dual-opt", value: "dual-option" }, "\u5DE6\u53F3 \u2325 Option \u540C\u65F6\u6309"),
            h("option", { key: "double-opt", value: "double-option" }, "\u53CC\u51FB \u2325 Option"),
            h("option", { key: "double-ctrl", value: "double-control" }, "\u53CC\u51FB \u2303 Control"),
            h("option", { key: "combo", value: "cmd-option" }, "\u2318 Command + \u2325 Option \u7EC4\u5408\u952E")
          ]
        )
      ),
      // 项 2: 快门音效
      h(
        "div",
        {
          style: {
            padding: "16px 20px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.06))"
          }
        },
        h(
          "div",
          null,
          h("div", { style: { fontWeight: 500, color: "var(--dsw-alias-label-primary, #f4f4f5)", marginBottom: "2px" } }, "\u5FEB\u95E8\u63D0\u793A\u97F3"),
          h(
            "div",
            { style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary, #71717a)" } },
            "\u622A\u56FE\u6210\u529F\u540E\u64AD\u653E\u6E05\u8106\u7684\u5FEB\u95E8\u63D0\u793A\u97F3"
          )
        ),
        h(
          "label",
          { style: { position: "relative", display: "inline-block", width: "42px", height: "24px", cursor: "pointer" } },
          h("input", {
            type: "checkbox",
            checked: config.soundEnabled,
            disabled: loading || saving,
            onChange: (e) => handleUpdate({ soundEnabled: e.target.checked }),
            style: { opacity: 0, width: 0, height: 0, margin: 0 }
          }),
          h(
            "span",
            {
              style: {
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                background: config.soundEnabled ? "var(--dsw-alias-button-primary-fill, #3b82f6)" : "var(--dsw-alias-button-tool-bar-fill, #3f3f46)",
                borderRadius: "24px",
                transition: "all 0.2s"
              }
            },
            h("span", {
              style: {
                position: "absolute",
                content: '""',
                height: "18px",
                width: "18px",
                left: config.soundEnabled ? "21px" : "3px",
                bottom: "3px",
                background: "var(--dsw-alias-label-primary-foreground, #ffffff)",
                borderRadius: "50%",
                transition: "all 0.2s",
                boxShadow: "0 1px 3px rgba(0,0,0,0.3)"
              }
            })
          )
        )
      ),
      // 项 3: 闪光动画
      h(
        "div",
        {
          style: {
            padding: "16px 20px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between"
          }
        },
        h(
          "div",
          null,
          h("div", { style: { fontWeight: 500, color: "var(--dsw-alias-label-primary, #f4f4f5)", marginBottom: "2px" } }, "\u622A\u56FE\u52A8\u753B\u53CD\u9988"),
          h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary, #71717a)" } }, "\u622A\u56FE\u6210\u529F\u540E\u88AB\u622A\u7A97\u53E3\u8FB9\u6846\u95EA\u4E00\u4E0B\uFF0C\u7F29\u7565\u56FE\u98DE\u5411\u4EFB\u52A1\u680F\u7684 DSH \u56FE\u6807")
        ),
        h(
          "label",
          { style: { position: "relative", display: "inline-block", width: "42px", height: "24px", cursor: "pointer" } },
          h("input", {
            type: "checkbox",
            checked: config.animationEnabled,
            disabled: loading || saving,
            onChange: (e) => handleUpdate({ animationEnabled: e.target.checked }),
            style: { opacity: 0, width: 0, height: 0, margin: 0 }
          }),
          h(
            "span",
            {
              style: {
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                background: config.animationEnabled ? "var(--dsw-alias-button-primary-fill, #3b82f6)" : "var(--dsw-alias-button-tool-bar-fill, #3f3f46)",
                borderRadius: "24px",
                transition: "all 0.2s"
              }
            },
            h("span", {
              style: {
                position: "absolute",
                content: '""',
                height: "18px",
                width: "18px",
                left: config.animationEnabled ? "21px" : "3px",
                bottom: "3px",
                background: "var(--dsw-alias-label-primary-foreground, #ffffff)",
                borderRadius: "50%",
                transition: "all 0.2s",
                boxShadow: "0 1px 3px rgba(0,0,0,0.3)"
              }
            })
          )
        )
      )
    )
  );
}

// src/client/w0.ts
async function runW0DraftVerify(ctx) {
  const results = [];
  const record = (name, ok, detail) => results.push({ name, ok, detail });
  try {
    let snapshot = ctx.sessions.list.getSnapshot();
    let sessionId = mainSessionId(snapshot);
    const pollStart = Date.now();
    while (sessionId === void 0 && Date.now() - pollStart < 12e3) {
      await new Promise((r) => setTimeout(r, 500));
      snapshot = ctx.sessions.list.getSnapshot();
      sessionId = mainSessionId(snapshot);
    }
    record("mainSessionId(list)", typeof sessionId === "string", {
      sessionId,
      idsCount: Array.isArray(snapshot.ids) ? snapshot.ids.length : void 0,
      idsSample: Array.isArray(snapshot.ids) ? snapshot.ids.slice(0, 5) : void 0
    });
    if (sessionId === void 0) {
      record("W0 \u524D\u7F6E\uFF1A\u5B58\u5728\u6D3B\u8DC3 Session", false, { hint: "\u8BF7\u5728 DSH \u4E2D\u6253\u5F00\u4E00\u4E2A\u4F1A\u8BDD\u540E\u91CD\u8BD5", idsCount: Array.isArray(snapshot.ids) ? snapshot.ids.length : void 0 });
      await reportW0Results(results);
      return results;
    }
    const scope = ctx.sessions.scope(sessionId);
    record("sessions.scope(sessionId)", scope !== void 0, { sessionId });
    if (scope === void 0) {
      await reportW0Results(results);
      return results;
    }
    const pngBytes = Uint8Array.from([
      137,
      80,
      78,
      71,
      13,
      10,
      26,
      10,
      0,
      0,
      0,
      13,
      73,
      72,
      68,
      82,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      1,
      8,
      6,
      0,
      0,
      0,
      31,
      21,
      196,
      137,
      0,
      0,
      0,
      10,
      73,
      68,
      65,
      84,
      120,
      156,
      99,
      0,
      1,
      0,
      0,
      5,
      0,
      1,
      13,
      10,
      45,
      180,
      0,
      0,
      0,
      0,
      73,
      69,
      78,
      68,
      174,
      66,
      96,
      130
    ]);
    const file = new File([pngBytes], "w0-verify.png", { type: "image/png" });
    let drafts;
    try {
      drafts = ctx.conversation.createDrafts(sessionId, [file]);
      record("createDrafts(sessionId, files)", drafts.length === 1 && typeof drafts[0]?.id === "string", {
        count: drafts.length,
        id: drafts[0]?.id
      });
    } catch (err) {
      record("createDrafts(sessionId, files)", false, { error: String(err) });
      await reportW0Results(results);
      return results;
    }
    if (drafts.length !== 1 || drafts[0] === void 0) {
      await reportW0Results(results);
      return results;
    }
    const draftId = drafts[0].id;
    let accepted;
    try {
      const input = ctx.conversation.input.for(scope);
      accepted = input.addAttachments([draftId]);
      record("input.for(scope).addAttachments([draftId])", typeof accepted === "boolean", { accepted });
    } catch (err) {
      record("input.for(scope).addAttachments([draftId])", false, { error: String(err) });
      await reportW0Results(results);
      return results;
    }
    let attachmentIds;
    try {
      attachmentIds = ctx.conversation.input.for(scope).snapshot.attachmentIds;
      record("input.snapshot.attachmentIds \u5305\u542B draftId", attachmentIds.includes(draftId), { attachmentIds });
    } catch (err) {
      record("input.snapshot.attachmentIds \u5305\u542B draftId", false, { error: String(err) });
      await reportW0Results(results);
      return results;
    }
    let draftAlive = false;
    try {
      const resolved = ctx.conversation.resolveDraftAttachments([draftId]);
      draftAlive = resolved.length === 1;
      record("conversation.resolveDraftAttachments([draftId])", draftAlive, { resolved: resolved.length });
    } catch (err) {
      record("conversation.resolveDraftAttachments([draftId])", false, { error: String(err) });
    }
    try {
      const input = ctx.conversation.input.for(scope);
      const removed = input.removeAttachment(draftId);
      const afterRemove = input.snapshot.attachmentIds;
      record("input.removeAttachment(draftId)", removed && !afterRemove.includes(draftId), { afterRemove });
    } catch (err) {
      record("input.removeAttachment(draftId)", false, { error: String(err) });
    }
    try {
      ctx.conversation.releaseDraftAttachment(draftId);
      const afterRelease = ctx.conversation.resolveDraftAttachments([draftId]);
      record("conversation.releaseDraftAttachment(draftId)", afterRelease.length === 0, { afterRelease: afterRelease.length });
    } catch (err) {
      record("conversation.releaseDraftAttachment(draftId)", false, { error: String(err) });
    }
  } catch (err) {
    record("W0 \u9A8C\u8BC1\u6574\u4F53\u6267\u884C", false, { error: String(err) });
  }
  await reportW0Results(results);
  return results;
}
async function reportW0Results(results) {
  try {
    sessionStorage.setItem("w0-results", JSON.stringify({ results, ts: Date.now(), href: globalThis.location?.href }));
  } catch (err) {
    console.error("[dsh-plugin-appshot:client] W0 results sessionStorage write failed:", err);
  }
  try {
    const origin = globalThis.location?.origin;
    const base = origin !== void 0 && origin !== "null" ? origin : "http://dsh.internal";
    await fetch(new URL("/plugins/appshot/w0-report", base).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ results, ts: Date.now(), href: globalThis.location?.href })
    });
  } catch (err) {
    console.warn("[dsh-plugin-appshot:client] W0 verify POST report failed (results kept in sessionStorage):", err);
  }
  console.log("[dsh-plugin-appshot:client] W0 verify results:", JSON.stringify(results, null, 2));
}

// src/client.ts
var inject = ["sessions", "conversation", "slots"];
function apply(ctx) {
  console.log("[dsh-plugin-appshot:client] client plugin applying...");
  if (typeof window !== "undefined" && typeof sessionStorage !== "undefined" && sessionStorage.getItem("w0-verify") === "1") {
    void runW0DraftVerify(ctx).catch((err) => {
      console.error("[dsh-plugin-appshot:client] W0 verify failed:", err);
    });
  }
  if (ctx.slots?.inject) {
    try {
      ctx.slots.inject(
        "settings.section",
        () => ctx.slots.register(
          {
            name: "settings.section",
            id: "appshot",
            order: 120,
            label: () => "\u622A\u56FE (Appshot)",
            inject: () => ({})
          },
          AppshotSettingsSection
        )
      );
      console.log("[dsh-plugin-appshot:client] settings section registered into DSH Settings shell");
    } catch (err) {
      console.warn("[dsh-plugin-appshot:client] failed to register settings section:", err);
    }
  }
  if (isWindowsPlatform()) {
    applyWindowsClient(ctx);
  } else {
    applyMacosClient(ctx);
  }
  console.log("[dsh-plugin-appshot:client] client plugin applied successfully");
}
return module.exports; } });
