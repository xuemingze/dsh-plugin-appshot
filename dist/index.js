// src/macos/index.ts
import { existsSync } from "node:fs";
import { dirname, join as join2 } from "node:path";
import { fileURLToPath } from "node:url";

// src/macos/staging.ts
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
async function cleanOrphanStagingFiles(dir = "/tmp") {
  try {
    const entries = await readdir(dir);
    let count = 0;
    for (const entry of entries) {
      if (entry.startsWith("dsh-appshot-") && entry.endsWith(".png")) {
        try {
          await unlink(join(dir, entry));
          count++;
        } catch {
        }
      }
    }
    return count;
  } catch {
    return 0;
  }
}

// src/macos/sse.ts
function createAppshotSSEHub(ctx) {
  const clients = /* @__PURE__ */ new Set();
  let unregister;
  if (typeof ctx.webServer?.register === "function") {
    unregister = ctx.webServer.register({
      kind: "exact",
      path: "/plugins/appshot/events",
      handler(req, res) {
        if (typeof res.writeHead === "function") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive"
          });
        }
        if (typeof res.write === "function") {
          res.write(": connected\n\n");
        }
        clients.add(res);
        req.on?.("close", () => {
          clients.delete(res);
        });
        res.on?.("error", () => {
          clients.delete(res);
        });
        res.on?.("close", () => {
          clients.delete(res);
        });
      }
    });
  } else if (typeof ctx.webServer?.registerUpgrade === "function") {
    ctx.webServer.registerUpgrade("/plugins/appshot/events", (socket) => {
      clients.add(socket);
      socket.on?.("close", () => {
        clients.delete(socket);
      });
      socket.on?.("error", () => {
        clients.delete(socket);
      });
    });
  }
  return {
    broadcast(frame) {
      const payload = `event: appshot/ready
data: ${JSON.stringify(frame)}

`;
      console.log("[dsh-plugin-appshot] sse broadcast", {
        subscribers: clients.size,
        attachmentId: frame.attachmentRef.attachmentId,
        dataBase64Chars: frame.dataBase64?.length ?? 0
      });
      for (const client of clients) {
        try {
          client.write(payload);
        } catch {
          clients.delete(client);
        }
      }
    },
    dispose() {
      for (const client of clients) {
        try {
          client.end();
        } catch {
        }
      }
      clients.clear();
      try {
        unregister?.();
      } catch {
      }
    }
  };
}

// src/macos/ingest.ts
import { readFile, unlink as unlink2 } from "node:fs/promises";
async function ingestScreenshot(ctx, imagePath, appName) {
  try {
    const data = await readFile(imagePath);
    const input = {
      data,
      mediaType: "image/png",
      name: `${appName} \u7A97\u53E3\u622A\u56FE.png`
    };
    return await ctx.attachments.saveImage(input);
  } finally {
    await unlink2(imagePath).catch(() => {
    });
  }
}

// src/macos/agent.ts
import { spawn } from "node:child_process";
import { chmodSync, statSync } from "node:fs";

// src/macos/ipc.ts
function createNdjsonParser(options) {
  let buffer = "";
  const processLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed);
      options.onEvent(parsed);
    } catch (err) {
      if (options.onError) {
        options.onError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  };
  return {
    feed(chunk) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        processLine(line);
      }
    },
    end() {
      if (buffer) {
        processLine(buffer);
        buffer = "";
      }
    }
  };
}

// src/macos/agent.ts
function ensureExecutable(filePath) {
  try {
    const stats = statSync(filePath);
    if ((stats.mode & 73) === 0) {
      chmodSync(filePath, stats.mode & 511 | 493);
    }
  } catch {
  }
}
async function startAgent(options) {
  ensureExecutable(options.command);
  const readyTimeoutMs = options.readyTimeoutMs ?? 3e3;
  return new Promise((resolve2, reject) => {
    let child;
    let isSettled = false;
    let timer = null;
    let hasExited = false;
    let exitCode = null;
    const exitPromises = [];
    const cleanupTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const settleResolve = (agent) => {
      if (isSettled) return;
      isSettled = true;
      cleanupTimer();
      resolve2(agent);
    };
    const settleReject = (err) => {
      if (isSettled) return;
      isSettled = true;
      cleanupTimer();
      reject(err);
    };
    try {
      child = spawn(options.command, options.args ?? [], {
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (err) {
      return settleReject(err instanceof Error ? err : new Error(String(err)));
    }
    const createAgentHandle = () => ({
      pid: child.pid ?? 0,
      stop: async () => {
        if (hasExited) return;
        child.kill("SIGTERM");
        await new Promise((res) => {
          if (hasExited) return res();
          child.once("exit", () => res());
        });
      },
      wait: async () => {
        if (hasExited) return exitCode ?? 0;
        return new Promise((res) => {
          exitPromises.push(res);
        });
      },
      sendConfig: (config) => {
        if (hasExited || !child.stdin || !child.stdin.writable) return;
        const frame = JSON.stringify({
          type: "config/update",
          payload: config
        }) + "\n";
        child.stdin.write(frame);
      }
    });
    const parser = createNdjsonParser({
      onEvent: (event) => {
        options.onEvent?.(event);
        if (event.type === "ready") {
          settleResolve(createAgentHandle());
        }
      }
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      parser.feed(chunk);
    });
    child.on("error", (err) => {
      cleanupTimer();
      settleReject(err);
    });
    child.on("exit", (code, signal) => {
      hasExited = true;
      exitCode = code !== null ? code : 0;
      cleanupTimer();
      parser.end();
      for (const waiter of exitPromises) {
        waiter(exitCode);
      }
      options.onExit?.({ code, signal });
      if (!isSettled) {
        settleResolve(createAgentHandle());
      }
    });
    timer = setTimeout(() => {
      if (!isSettled) {
        child.kill("SIGTERM");
        settleReject(new Error(`Agent ready handshake timed out after ${readyTimeoutMs}ms`));
      }
    }, readyTimeoutMs);
  });
}

// src/macos/index.ts
var macosAgent;
var macosSseHub;
function resolveAgentBinaryPath() {
  const currentDir = typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // 优先：打包后的 App Bundle 可执行文件
    join2(currentDir, "../native/macos/.build/Appshot Agent.app/Contents/MacOS/appshot-macos"),
    // 次优：根目录或构建目录的可执行文件
    join2(currentDir, "../native/macos/appshot-macos"),
    join2(currentDir, "../native/macos/.build/debug/appshot-macos")
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}
function applyMacos(ctx) {
  console.log("[dsh-plugin-appshot] plugin applying...");
  cleanOrphanStagingFiles().catch((err) => {
    console.error("[dsh-plugin-appshot] failed to clean orphan files:", err);
  });
  const sseHub = createAppshotSSEHub(ctx);
  macosSseHub = sseHub;
  let initialConfig;
  const settings = ctx.settings;
  if (settings) {
    try {
      const appshotSchema = Object.assign(
        (val) => {
          const v = typeof val === "object" && val !== null ? val : {};
          return {
            shortcutMode: typeof v.shortcutMode === "string" ? v.shortcutMode : "dual-cmd",
            soundEnabled: typeof v.soundEnabled === "boolean" ? v.soundEnabled : true,
            animationEnabled: typeof v.animationEnabled === "boolean" ? v.animationEnabled : true
          };
        },
        {
          toJSON: () => ({
            type: "object",
            properties: {
              shortcutMode: { type: "string", default: "dual-cmd" },
              soundEnabled: { type: "boolean", default: true },
              animationEnabled: { type: "boolean", default: true }
            }
          })
        }
      );
      const scope = settings.register("appshot", appshotSchema, { applies: "live" });
      initialConfig = scope?.get();
    } catch (err) {
      console.warn("[dsh-plugin-appshot] settings registration skipped/warn:", err);
    }
  }
  if (process.env.DSH_DISABLE_AGENT_SPAWN !== "1") {
    const binaryPath = resolveAgentBinaryPath();
    if (existsSync(binaryPath)) {
      console.log("[dsh-plugin-appshot] starting native agent from:", binaryPath);
      const activatePid = process.ppid || process.pid;
      startAgent({
        command: binaryPath,
        args: [
          "--daemon",
          "--activate-pid",
          String(activatePid),
          "--activate-app",
          "com.deepseek-harness.desktop"
        ],
        onEvent: async (event) => {
          if (event.type === "ready") {
            console.log("[dsh-plugin-appshot] native agent ready, pid:", event.pid);
            if (initialConfig && macosAgent) {
              macosAgent.sendConfig(initialConfig);
            }
          } else if (event.type === "appshot") {
            const capture = event;
            console.log("[dsh-plugin-appshot] captured screenshot:", capture.appName, capture.imagePath);
            try {
              const attachmentRef = await ingestScreenshot(
                ctx,
                capture.imagePath,
                capture.appName
              );
              console.log("[dsh-plugin-appshot] attachment saved:", attachmentRef.attachmentId);
              let dataBase64;
              try {
                const stored = await ctx.attachments.readImage(attachmentRef);
                dataBase64 = Buffer.from(stored.data).toString("base64");
              } catch (err) {
                console.warn("[dsh-plugin-appshot] readImage failed, frame carries metadata only:", err);
              }
              sseHub.broadcast({
                type: "appshot/ready",
                attachmentRef,
                dataBase64,
                appName: capture.appName,
                windowTitle: capture.windowTitle,
                timestamp: capture.timestamp ?? Date.now()
              });
            } catch (err) {
              console.error("[dsh-plugin-appshot] failed to ingest screenshot:", err);
            }
          } else if (event.type === "error") {
            console.error("[dsh-plugin-appshot] native agent error:", event.code, event.message);
          }
        },
        onExit: (info) => {
          console.log("[dsh-plugin-appshot] native agent exited with code:", info.code, "signal:", info.signal);
        }
      }).then((agent) => {
        macosAgent = agent;
        if (initialConfig) {
          agent.sendConfig(initialConfig);
        }
      }).catch((err) => {
        console.error("[dsh-plugin-appshot] failed to start native agent:", err);
      });
    }
  }
  ctx.effect(() => {
    const off = ctx.on(
      "settings/updated",
      (ns, next) => {
        if (ns === "appshot" && macosAgent && next && typeof next === "object") {
          console.log("[dsh-plugin-appshot] settings updated, syncing to native agent:", next);
          macosAgent.sendConfig(next);
        }
      }
    );
    return () => {
      off?.();
    };
  });
  const webServer = ctx.webServer;
  if (typeof webServer?.register === "function") {
    const getConfig = () => {
      if (settings) {
        try {
          return settings.get?.("appshot") ?? initialConfig ?? { shortcutMode: "dual-cmd", soundEnabled: true, animationEnabled: true };
        } catch {
        }
      }
      return initialConfig ?? { shortcutMode: "dual-cmd", soundEnabled: true, animationEnabled: true };
    };
    webServer.register({
      kind: "exact",
      path: "/plugins/appshot/config",
      handler(req, res) {
        const httpReq = req;
        const httpRes = res;
        if (httpReq.method === "GET") {
          httpRes.writeHead(200, { "Content-Type": "application/json" });
          httpRes.end(JSON.stringify(getConfig()));
          return;
        }
        if (httpReq.method === "POST") {
          const chunks = [];
          const reqNode = req;
          reqNode.on("data", (chunk) => {
            if (chunk) chunks.push(chunk);
          });
          reqNode.on("end", () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
              const patch = {};
              if (typeof body.shortcutMode === "string") patch.shortcutMode = body.shortcutMode;
              if (typeof body.soundEnabled === "boolean") patch.soundEnabled = body.soundEnabled;
              if (typeof body.animationEnabled === "boolean") patch.animationEnabled = body.animationEnabled;
              const current = getConfig();
              const merged = { ...current, ...patch };
              if (macosAgent) {
                macosAgent.sendConfig(merged);
              }
              if (settings) {
                try {
                  const settingsAny = settings;
                  settingsAny.update?.("appshot", patch);
                } catch {
                }
              }
              initialConfig = merged;
              httpRes.writeHead(200, { "Content-Type": "application/json" });
              httpRes.end(JSON.stringify(merged));
            } catch (err) {
              httpRes.writeHead(400, { "Content-Type": "application/json" });
              httpRes.end(JSON.stringify({ error: "Invalid JSON", detail: String(err) }));
            }
          });
          return;
        }
        httpRes.writeHead(405, { "Content-Type": "application/json" });
        httpRes.end(JSON.stringify({ error: "Method not allowed" }));
      }
    });
  }
}
function disposeMacos() {
  if (macosAgent) {
    macosAgent.stop().catch(() => {
    });
    macosAgent = void 0;
  }
  if (macosSseHub) {
    macosSseHub.dispose();
    macosSseHub = void 0;
  }
}

// src/windows/index.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { existsSync as existsSync2 } from "node:fs";
import { tmpdir as tmpdir2 } from "node:os";
import { dirname as dirname3, join as join4 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/windows/state-machine.ts
var uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidCaptureId(value) {
  return uuidRe.test(value);
}
function isValidClientInstanceId(value) {
  return value.length >= 8 && value.length <= 128 && !/[\/:*?"<>|]/.test(value);
}
function isValidSessionId(value) {
  return value.length >= 1 && value.length <= 256;
}
var WindowsCaptureStateMachine = class {
  state = { type: "IDLE" };
  cancelledIds = /* @__PURE__ */ new Map();
  // captureId -> expiresAt
  completed = [];
  lastActiveClient = {
    clientInstanceId: null,
    sessionId: null
  };
  waiters = /* @__PURE__ */ new Map();
  disposed = false;
  nowFn;
  onNativeFrame;
  inflightTimeoutMs;
  pendingAckTimeoutMs;
  pollTimeoutMs;
  cancelledTtlMs;
  completedLimit;
  constructor(options = {}) {
    this.nowFn = options.now ?? Date.now;
    this.onNativeFrame = options.onNativeFrame;
    this.inflightTimeoutMs = options.inflightTimeoutMs ?? 15e3;
    this.pendingAckTimeoutMs = options.pendingAckTimeoutMs ?? 6e4;
    this.pollTimeoutMs = options.pollTimeoutMs ?? 2e4;
    this.cancelledTtlMs = options.cancelledTtlMs ?? 6e4;
    this.completedLimit = options.completedLimit ?? 50;
  }
  getState() {
    return this.state;
  }
  /** 最近上报的活跃 Client + Session（服务端接收时间语义由调用方保证）。 */
  getLastActiveClient() {
    return { ...this.lastActiveClient };
  }
  setLastActiveClient(clientInstanceId, sessionId) {
    this.lastActiveClient = { clientInstanceId, sessionId };
  }
  getCompletedCaptures() {
    return [...this.completed];
  }
  isCancelled(captureId) {
    this.sweepCancelled();
    return this.cancelledIds.has(captureId);
  }
  // ── 1. capture/request 接受 ────────────────────────────────────────────
  /** 返回与 W3 测试兼容的结构：{ accepted, error?, targetClientInstanceId, targetSessionId } */
  onCaptureStarted(captureId, now, clientInstanceId, sessionId) {
    this.sweepCancelled();
    const clientId = clientInstanceId !== void 0 ? clientInstanceId : this.lastActiveClient.clientInstanceId;
    const sessId = sessionId !== void 0 ? sessionId : this.lastActiveClient.sessionId;
    if (this.state.type !== "IDLE") {
      this.sendNative({ type: "status", captureId, state: "BUSY" });
      return { accepted: false, error: "BUSY" };
    }
    if (!clientId) {
      this.sendNative({ type: "status", captureId, state: "NO_CLIENT" });
      return { accepted: false, error: "NO_CLIENT" };
    }
    this.state = {
      type: "IN_FLIGHT",
      captureId,
      targetClientInstanceId: clientId,
      targetSessionId: sessId,
      startedAt: now
    };
    this.sendNative({ type: "status", captureId, state: "IN_FLIGHT" });
    return { accepted: true, targetClientInstanceId: clientId, targetSessionId: sessId };
  }
  // ── 2. appshot 落盘通知（IN_FLIGHT → PENDING_ACK） ─────────────────────
  /** 同步版（payload 已读入内存）。未知/迟到帧返回 { accepted: false, shouldUnlink: true }。 */
  onAppshotReceived(captureId, payload, metadata, isFallback = false, fallbackReason = null) {
    this.sweepCancelled();
    if (this.cancelledIds.has(captureId) || this.state.type !== "IN_FLIGHT" || this.state.captureId !== captureId) {
      return { accepted: false, shouldUnlink: true };
    }
    const inflight = this.state;
    const fullMetadata = {
      appName: metadata?.appName ?? "unknown",
      windowTitle: metadata?.windowTitle,
      mediaType: "image/png",
      width: metadata?.width ?? 0,
      height: metadata?.height ?? 0,
      bytes: payload.length,
      timestamp: metadata?.timestamp ?? this.nowFn()
    };
    this.state = {
      type: "PENDING_ACK",
      captureId,
      targetClientInstanceId: inflight.targetClientInstanceId,
      targetSessionId: inflight.targetSessionId,
      payload,
      metadata: fullMetadata,
      isFallback,
      fallbackReason,
      pendingSince: this.nowFn()
    };
    this.sendNative({ type: "status", captureId, state: "WAITING_DSH" });
    this.wakeWaiterFor(inflight.targetClientInstanceId);
    return {
      accepted: true,
      targetClientInstanceId: inflight.targetClientInstanceId,
      targetSessionId: inflight.targetSessionId
    };
  }
  // ── 3. IN_FLIGHT 错误/失败 ─────────────────────────────────────────────
  onCaptureError(captureId) {
    if (this.state.type === "IN_FLIGHT" && this.state.captureId === captureId) {
      this.state = { type: "IDLE" };
      this.sendNative({ type: "status", captureId, state: "RESET" });
    }
  }
  // ── 4. 超时守卫（IN_FLIGHT 15s / PENDING_ACK 60s）──────────────────────
  /** IN_FLIGHT 满 inflightTimeoutMs 或 PENDING_ACK 满 pendingAckTimeoutMs 时转移至 cancelled 并下发 cancel:TIMEOUT。 */
  onTimeoutTriggered(now) {
    if (this.state.type === "IN_FLIGHT" && now - this.state.startedAt >= this.inflightTimeoutMs) {
      const timedOutId = this.state.captureId;
      this.recordCancelled(timedOutId);
      this.state = { type: "IDLE" };
      this.sendNative({ type: "cancel", captureId: timedOutId, reason: "TIMEOUT" });
      return { timedOut: true, captureId: timedOutId, phase: "IN_FLIGHT" };
    }
    if (this.state.type === "PENDING_ACK" && now - this.state.pendingSince >= this.pendingAckTimeoutMs) {
      const pending = this.state;
      this.recordCancelled(pending.captureId);
      this.state = { type: "IDLE" };
      this.sendNative({ type: "cancel", captureId: pending.captureId, reason: "TIMEOUT" });
      const waiter = this.waiters.get(pending.targetClientInstanceId ?? "");
      if (waiter) this.settleWaiter(waiter, { outcome: "cancelled", captureId: pending.captureId });
      return { timedOut: true, captureId: pending.captureId, phase: "PENDING_ACK" };
    }
    return { timedOut: false };
  }
  // ── 5. 长轮询 ──────────────────────────────────────────────────────────
  /**
   * 立即判定。返回 'wait' 时由调用方通过 waitForChange 挂起。
   * 语义（technical-windows.md §4.1.4）：
   * - 先查有界终态集合：cancelled → cancelled；completed 完整元组 → completed；
   *   ID 同但 Client/Session 不同 → conflict；
   * - PENDING_ACK 且请求方为目标 Client：knownCaptureId 不匹配 → ready；
   *   匹配 → 等待状态变化（wait）；
   * - 非目标 / 无 Pending → wait（长轮询挂起后 20s 无变化返回 no-pending）。
   */
  poll(clientInstanceId, knownCaptureId, knownTargetSessionId) {
    this.sweepCancelled();
    if (knownCaptureId && this.cancelledIds.has(knownCaptureId)) {
      return { outcome: "cancelled", captureId: knownCaptureId };
    }
    if (knownCaptureId) {
      const completedEntry = this.completed.find((c) => c.captureId === knownCaptureId);
      if (completedEntry) {
        const tupleMatches = completedEntry.clientInstanceId === clientInstanceId && (knownTargetSessionId === null || completedEntry.sessionId === knownTargetSessionId);
        if (tupleMatches) return { outcome: "completed", captureId: knownCaptureId };
        return { outcome: "conflict" };
      }
    }
    if (this.state.type === "PENDING_ACK") {
      const pending = this.state;
      if (pending.targetClientInstanceId === clientInstanceId) {
        if (knownCaptureId === null || knownCaptureId !== pending.captureId) {
          return { outcome: "ready", payload: this.buildReadyPayload(pending) };
        }
        return { outcome: "wait" };
      }
      return { outcome: "not-target" };
    }
    return { outcome: "wait" };
  }
  /** 注册/替换该 Client 的 waiter；返回取消旧 waiter 的函数。 */
  waitForChange(clientInstanceId, knownCaptureId, knownTargetSessionId, onResult, onTimeout) {
    const existing = this.waiters.get(clientInstanceId);
    if (existing) {
      this.settleWaiter(existing, { outcome: "no-pending" });
    }
    const waiter = {
      clientInstanceId,
      knownCaptureId,
      knownTargetSessionId,
      resolve: onResult,
      timer: null,
      settled: false
    };
    waiter.timer = setTimeout(() => {
      if (waiter.settled) return;
      this.waiters.delete(clientInstanceId);
      waiter.settled = true;
      onTimeout();
    }, this.pollTimeoutMs);
    this.waiters.set(clientInstanceId, waiter);
    return () => {
      if (waiter.settled) return;
      this.settleWaiter(waiter, { outcome: "no-pending" });
    };
  }
  // ── 6. Session 注册 / 认领 ─────────────────────────────────────────────
  /**
   * 处理 POST /session 上报。claimPendingCaptureId 仅在 PENDING_ACK 且
   * rebindRequired 或 targetSessionId 为空、且上报方为目标 Client 时生效。
   * 返回 { claimed: boolean; captureId?: string; targetSessionId?: string | null }。
   */
  onSessionRegister(clientInstanceId, sessionId, claimPendingCaptureId) {
    this.setLastActiveClient(clientInstanceId, sessionId);
    if (this.state.type === "PENDING_ACK" && claimPendingCaptureId && this.state.captureId === claimPendingCaptureId) {
      const pending = this.state;
      if (pending.targetClientInstanceId === clientInstanceId && (pending.rebindRequired || pending.targetSessionId === null)) {
        this.state = {
          ...pending,
          targetSessionId: sessionId,
          rebindRequired: false
        };
        this.wakeWaiterFor(clientInstanceId);
        return { claimed: true, captureId: pending.captureId, targetSessionId: sessionId };
      }
    }
    return { claimed: false };
  }
  // ── 7. 交付结果（Delivery Result） ─────────────────────────────────────
  onDeliveryResult(req) {
    const { captureId, clientInstanceId, targetSessionId, status } = req;
    const completedEntry = this.completed.find((c) => c.captureId === captureId);
    if (completedEntry) {
      const tupleMatches = completedEntry.clientInstanceId === clientInstanceId && completedEntry.sessionId === targetSessionId;
      return tupleMatches ? { httpCode: 200, action: "IGNORED_DUPLICATE" } : { httpCode: 409, action: "CONFLICT_REJECTED" };
    }
    if (this.state.type !== "PENDING_ACK" || this.state.captureId !== captureId || this.state.targetClientInstanceId !== null && this.state.targetClientInstanceId !== clientInstanceId || this.state.targetSessionId !== null && this.state.targetSessionId !== targetSessionId) {
      return { httpCode: 409, action: "CONFLICT_REJECTED" };
    }
    const pending = this.state;
    if (status === "MOUNTED") {
      this.completed.push({
        captureId,
        clientInstanceId,
        sessionId: targetSessionId,
        finalNativeStatus: pending.isFallback ? "FALLBACK_SUCCESS" : "SUCCESS",
        notificationPresented: false,
        completedAt: this.nowFn()
      });
      if (this.completed.length > this.completedLimit) this.completed.splice(0, this.completed.length - this.completedLimit);
      this.state = { type: "IDLE" };
      this.sendNative({ type: "status", captureId, state: pending.isFallback ? "FALLBACK_SUCCESS" : "SUCCESS" });
      return { httpCode: 200, action: "CLEARED_SUCCESS" };
    }
    if (status === "SESSION_MISMATCH") {
      this.state = { ...pending, rebindRequired: true };
    }
    return { httpCode: 200, action: "HELD_PENDING" };
  }
  // ── 8. 二次快捷键取消（cancel/request） ────────────────────────────────
  onCancelRequest(captureId) {
    if (this.state.type === "PENDING_ACK" && this.state.captureId === captureId) {
      const pending = this.state;
      this.recordCancelled(captureId);
      this.state = { type: "IDLE" };
      this.sendNative({ type: "status", captureId, state: "CANCELLED_BY_USER" });
      const waiter = this.waiters.get(pending.targetClientInstanceId ?? "");
      if (waiter) this.settleWaiter(waiter, { outcome: "cancelled", captureId });
      return true;
    }
    return false;
  }
  // ── 9. Agent 退出 / status/presented ───────────────────────────────────
  onAgentExit() {
    if (this.state.type === "IN_FLIGHT") {
      this.state = { type: "IDLE" };
    }
  }
  onStatusPresented(captureId, state) {
    const entry = this.completed.find((c) => c.captureId === captureId && c.finalNativeStatus === state);
    if (entry) {
      entry.notificationPresented = true;
    }
  }
  // ── 10. dispose ────────────────────────────────────────────────────────
  dispose() {
    this.disposed = true;
    for (const waiter of this.waiters.values()) {
      this.settleWaiter(waiter, { outcome: "no-pending" });
    }
    this.waiters.clear();
    this.cancelledIds.clear();
    this.completed = [];
    this.state = { type: "IDLE" };
  }
  // ── 内部工具 ───────────────────────────────────────────────────────────
  sendNative(frame) {
    if (!this.disposed && this.onNativeFrame) this.onNativeFrame(frame);
  }
  recordCancelled(captureId) {
    this.sweepCancelled();
    this.cancelledIds.set(captureId, this.nowFn() + this.cancelledTtlMs);
  }
  sweepCancelled() {
    const now = this.nowFn();
    for (const [id, expiresAt] of this.cancelledIds) {
      if (expiresAt <= now) this.cancelledIds.delete(id);
    }
  }
  wakeWaiterFor(clientInstanceId) {
    if (clientInstanceId === null) return;
    const waiter = this.waiters.get(clientInstanceId);
    if (!waiter || waiter.settled) return;
    const result = this.poll(waiter.clientInstanceId, waiter.knownCaptureId, waiter.knownTargetSessionId);
    if (result.outcome !== "wait") this.settleWaiter(waiter, result);
  }
  settleWaiter(waiter, result) {
    if (waiter.settled) return;
    waiter.settled = true;
    if (waiter.timer !== null) clearTimeout(waiter.timer);
    if (this.waiters.get(waiter.clientInstanceId) === waiter) this.waiters.delete(waiter.clientInstanceId);
    waiter.resolve(result);
  }
  buildReadyPayload(pending) {
    const base64 = Buffer.from(pending.payload).toString("base64");
    return {
      type: "appshot/ready",
      captureId: pending.captureId,
      targetClientInstanceId: pending.targetClientInstanceId ?? "",
      targetSessionId: pending.targetSessionId,
      isFallback: pending.isFallback,
      fallbackReason: pending.fallbackReason,
      dataBase64: base64,
      metadata: pending.metadata
    };
  }
};

// src/shared/types.ts
var WINDOWS_MODIFIER_KEYS = [
  "lctrl",
  "rctrl",
  "lalt",
  "ralt",
  "lshift",
  "rshift"
];
function isWindowsModifierKey(value) {
  return typeof value === "string" && WINDOWS_MODIFIER_KEYS.includes(value);
}
function isValidWindowsHotkeys(value) {
  if (value === null || typeof value !== "object") return false;
  const hk = value;
  return isWindowsModifierKey(hk.left) && isWindowsModifierKey(hk.right) && hk.left !== hk.right;
}

// src/windows/http-routes.ts
var MAX_POST_BODY_BYTES = 64 * 1024;
function getHeader(req, name2) {
  const raw = req.headers?.[name2];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}
function isCrossSite(req) {
  return getHeader(req, "sec-fetch-site") === "cross-site";
}
function readJsonBody(req) {
  return new Promise((resolveBody) => {
    if (typeof req.on !== "function") {
      resolveBody(null);
      return;
    }
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (!chunk) return;
      size += chunk.length;
      if (size > MAX_POST_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        resolveBody(null);
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf-8");
      try {
        const parsed = JSON.parse(raw);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          resolveBody(parsed);
          return;
        }
        resolveBody(null);
      } catch {
        resolveBody(null);
      }
    });
  });
}
function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
function sendNoContent(res) {
  res.writeHead(204);
  res.end();
}
var deliveryStatuses = ["MOUNTED", "BUSY", "NO_SESSION", "SESSION_MISMATCH"];
function isDeliveryResultStatus(value) {
  return deliveryStatuses.includes(value);
}
function registerWindowsRoutes(ctx, options) {
  const { machine } = options;
  const webServer = ctx.webServer;
  if (!webServer || typeof webServer.register !== "function") {
    return () => {
    };
  }
  if (webServer.host !== "127.0.0.1") {
    return () => {
    };
  }
  const disposers = [];
  disposers.push(
    webServer.register({
      kind: "exact",
      path: "/plugins/appshot/session",
      handler: (req, res) => {
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        if (isCrossSite(req)) {
          res.writeHead(403);
          res.end();
          return;
        }
        void (async () => {
          const body = await readJsonBody(req);
          if (body === null) {
            sendJson(res, 400, { error: "INVALID_BODY" });
            return;
          }
          const raw = body;
          const clientInstanceId = typeof raw.clientInstanceId === "string" ? raw.clientInstanceId : "";
          const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : "";
          const claimPendingCaptureId = typeof raw.claimPendingCaptureId === "string" ? raw.claimPendingCaptureId : void 0;
          if (!isValidClientInstanceId(clientInstanceId) || !isValidSessionId(sessionId)) {
            sendJson(res, 400, { error: "INVALID_FIELDS" });
            return;
          }
          if (claimPendingCaptureId !== void 0 && !isValidCaptureId(claimPendingCaptureId)) {
            sendJson(res, 400, { error: "INVALID_CAPTURE_ID" });
            return;
          }
          const result = machine.onSessionRegister(clientInstanceId, sessionId, claimPendingCaptureId);
          if (result.claimed) {
            sendJson(res, 200, { captureId: result.captureId, targetSessionId: result.targetSessionId });
            return;
          }
          sendJson(res, 200, { ok: true });
        })();
      }
    })
  );
  disposers.push(
    webServer.register({
      kind: "exact",
      path: "/plugins/appshot/pending",
      handler: (req, res) => {
        if (req.method !== "GET") {
          res.writeHead(405);
          res.end();
          return;
        }
        if (isCrossSite(req)) {
          res.writeHead(403);
          res.end();
          return;
        }
        const url = new URL(req.url ?? "/", "http://dsh.internal");
        const clientInstanceId = url.searchParams.get("clientInstanceId") ?? "";
        const knownCaptureIdRaw = url.searchParams.get("knownCaptureId");
        const knownTargetSessionIdRaw = url.searchParams.get("knownTargetSessionId");
        const knownCaptureId = knownCaptureIdRaw && knownCaptureIdRaw !== "" ? knownCaptureIdRaw : null;
        const knownTargetSessionId = knownTargetSessionIdRaw && knownTargetSessionIdRaw !== "" ? knownTargetSessionIdRaw : null;
        if (!isValidClientInstanceId(clientInstanceId)) {
          sendJson(res, 400, { error: "INVALID_CLIENT_INSTANCE_ID" });
          return;
        }
        if (knownCaptureId !== null && !isValidCaptureId(knownCaptureId)) {
          sendJson(res, 400, { error: "INVALID_CAPTURE_ID" });
          return;
        }
        if (knownTargetSessionId !== null && !isValidSessionId(knownTargetSessionId)) {
          sendJson(res, 400, { error: "INVALID_SESSION_ID" });
          return;
        }
        const respond = (result) => {
          switch (result.outcome) {
            case "ready":
              sendJson(res, 200, result.payload);
              return;
            case "cancelled":
              sendJson(res, 200, { type: "appshot/cancelled", captureId: result.captureId });
              return;
            case "completed":
              sendJson(res, 200, { type: "appshot/completed", captureId: result.captureId });
              return;
            case "conflict":
              sendJson(res, 409, { error: "CONFLICT" });
              return;
            case "not-target":
            case "no-pending":
              sendNoContent(res);
              return;
          }
        };
        const immediate = machine.poll(clientInstanceId, knownCaptureId, knownTargetSessionId);
        if (immediate.outcome !== "wait") {
          respond(immediate);
          return;
        }
        const cancelWait = machine.waitForChange(
          clientInstanceId,
          knownCaptureId,
          knownTargetSessionId,
          (pollResult) => respond(pollResult),
          () => sendNoContent(res)
        );
        req.on?.("close", () => {
          cancelWait();
        });
      }
    })
  );
  disposers.push(
    webServer.register({
      kind: "exact",
      path: "/plugins/appshot/delivery-result",
      handler: (req, res) => {
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        if (isCrossSite(req)) {
          res.writeHead(403);
          res.end();
          return;
        }
        void (async () => {
          const body = await readJsonBody(req);
          if (body === null) {
            sendJson(res, 400, { error: "INVALID_BODY" });
            return;
          }
          const raw = body;
          const captureId = typeof raw.captureId === "string" ? raw.captureId : "";
          const clientInstanceId = typeof raw.clientInstanceId === "string" ? raw.clientInstanceId : "";
          const targetSessionId = typeof raw.targetSessionId === "string" ? raw.targetSessionId : "";
          const status = typeof raw.status === "string" ? raw.status : "";
          const targetSessionIdValid = status === "NO_SESSION" ? targetSessionId === "" : isValidSessionId(targetSessionId);
          if (!isValidCaptureId(captureId) || !isValidClientInstanceId(clientInstanceId) || !targetSessionIdValid || !isDeliveryResultStatus(status)) {
            sendJson(res, 400, { error: "INVALID_FIELDS" });
            return;
          }
          const result = machine.onDeliveryResult({ captureId, clientInstanceId, targetSessionId, status });
          if (result.action === "IGNORED_DUPLICATE" || result.action === "CLEARED_SUCCESS" || result.action === "HELD_PENDING") {
            sendJson(res, 200, { action: result.action });
            return;
          }
          sendJson(res, result.httpCode, { error: result.action });
        })();
      }
    })
  );
  disposers.push(
    webServer.register({
      kind: "exact",
      path: "/plugins/appshot/config",
      handler: (req, res) => {
        if (isCrossSite(req)) {
          res.writeHead(403);
          res.end();
          return;
        }
        if (req.method === "GET") {
          const current = options.getConfig?.() ?? {
            platform: "win32",
            shortcutMode: "double-ctrl",
            soundEnabled: true,
            animationEnabled: true
          };
          sendJson(res, 200, current);
          return;
        }
        if (req.method === "POST") {
          void (async () => {
            const body = await readJsonBody(req);
            if (body === null) {
              sendJson(res, 400, { error: "INVALID_BODY" });
              return;
            }
            const current = options.getConfig?.() ?? {
              platform: "win32",
              shortcutMode: "double-ctrl",
              soundEnabled: true,
              animationEnabled: true
            };
            const patch = {};
            if (typeof body.shortcutMode === "string") patch.shortcutMode = body.shortcutMode;
            if (typeof body.soundEnabled === "boolean") patch.soundEnabled = body.soundEnabled;
            if (typeof body.animationEnabled === "boolean") patch.animationEnabled = body.animationEnabled;
            if (body.windowsHotkeys !== null && typeof body.windowsHotkeys === "object") {
              if (isValidWindowsHotkeys(body.windowsHotkeys)) {
                patch.windowsHotkeys = { ...body.windowsHotkeys };
              } else {
                sendJson(res, 400, { error: "INVALID_HOTKEYS" });
                return;
              }
            }
            const merged = { ...current, ...patch, platform: "win32" };
            options.onConfigUpdate?.(merged);
            sendJson(res, 200, merged);
          })();
          return;
        }
        res.writeHead(405);
        res.end();
      }
    })
  );
  if (options.onW0Report) {
    disposers.push(
      webServer.register({
        kind: "exact",
        path: "/plugins/appshot/w0-report",
        handler: (req, res) => {
          if (req.method !== "POST") {
            res.writeHead(405);
            res.end();
            return;
          }
          void (async () => {
            const body = await readJsonBody(req);
            if (body === null) {
              sendJson(res, 400, { error: "INVALID_BODY" });
              return;
            }
            options.onW0Report?.(body);
            sendJson(res, 200, { ok: true });
          })();
        }
      })
    );
  }
  return () => {
    for (const dispose2 of disposers) dispose2();
  };
}

// src/windows/agent.ts
import { spawn as spawn2 } from "node:child_process";

// src/windows/ipc.ts
function createWindowsNdjsonParser(options) {
  let buffer = "";
  const processLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed);
      options.onEvent(parsed);
    } catch (err) {
      if (options.onError) {
        options.onError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  };
  return {
    feed(chunk) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    },
    end() {
      if (buffer) {
        processLine(buffer);
        buffer = "";
      }
    }
  };
}
function serializeWindowsCommand(frame) {
  return JSON.stringify(frame) + "\n";
}

// src/windows/agent.ts
var MAX_RESTARTS = 3;
var RESTART_DELAYS = [1e3, 2e3, 4e3];
var STABLE_RESET_MS = 6e4;
var FORCE_KILL_TIMEOUT_MS = 3e3;
function startWindowsAgent(options) {
  const readyTimeoutMs = options.readyTimeoutMs ?? 15e3;
  const allowRestart = options.allowRestart ?? true;
  const nowFn = options.now ?? Date.now;
  let child = null;
  let currentPid = 0;
  let parser = createNoopParser();
  let hasExited = false;
  let exitCode = null;
  let stopped = false;
  let restartCount = 0;
  let stableSince = nowFn();
  let stopTimer = null;
  let readyTimer = null;
  const stderrLines = [];
  const exitWaiters = [];
  const onFrameCb = (frame) => {
    if (frame.type === "ready" && readyTimer) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
    options.onFrame?.(frame);
  };
  const spawnChild = () => {
    hasExited = false;
    try {
      child = spawn2(options.command, options.args ?? [], {
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
        env: { ...process.env }
      });
      currentPid = child.pid ?? 0;
    } catch (err) {
      options.onExit?.({
        code: null,
        signal: null,
        willRestart: false
      });
      void err;
      return;
    }
    parser = createWindowsNdjsonParser({
      onEvent: onFrameCb
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => parser.feed(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      const text = typeof chunk === "string" ? chunk : String(chunk ?? "");
      const trimmed = text.trim();
      if (trimmed && stderrLines.length < 50) stderrLines.push(trimmed);
    });
    if (readyTimer) clearTimeout(readyTimer);
    readyTimer = setTimeout(() => {
      if (child && !hasExited) {
        child.kill();
      }
    }, readyTimeoutMs);
    child.on("error", () => {
    });
    child.on("exit", (code, signal) => {
      if (readyTimer) {
        clearTimeout(readyTimer);
        readyTimer = null;
      }
      hasExited = true;
      exitCode = code !== null ? code : 0;
      parser.end();
      for (const waiter of exitWaiters) waiter(exitCode);
      if (stopped || !allowRestart) {
        options.onExit?.({ code, signal, willRestart: false });
        return;
      }
      if (nowFn() - stableSince >= STABLE_RESET_MS) {
        restartCount = 0;
      }
      if (restartCount >= MAX_RESTARTS) {
        options.onExit?.({ code, signal, willRestart: false });
        return;
      }
      const delay = RESTART_DELAYS[restartCount] ?? RESTART_DELAYS[RESTART_DELAYS.length - 1];
      restartCount++;
      options.onExit?.({ code, signal, willRestart: true });
      setTimeout(() => {
        if (!stopped) spawnChild();
      }, delay);
    });
  };
  spawnChild();
  const handle = {
    pid: currentPid,
    stderrLines: () => [...stderrLines],
    send(frame) {
      if (hasExited || !child?.stdin || !child.stdin.writable) return;
      child.stdin.write(serializeWindowsCommand(frame));
    },
    stop: async () => {
      stopped = true;
      if (!child || hasExited) return;
      handle.send({ type: "shutdown" });
      await new Promise((resolveStop) => {
        if (hasExited) {
          resolveStop();
          return;
        }
        stopTimer = setTimeout(() => {
          try {
            child?.kill();
          } catch {
          }
          resolveStop();
        }, FORCE_KILL_TIMEOUT_MS);
        child?.once("exit", () => {
          if (stopTimer) clearTimeout(stopTimer);
          resolveStop();
        });
      });
    },
    wait: async () => {
      if (hasExited) return exitCode;
      return new Promise((res) => {
        exitWaiters.push(res);
      });
    }
  };
  return handle;
}
function createNoopParser() {
  return {
    feed(_chunk) {
    },
    end() {
    }
  };
}

// src/windows/safe-ingest.ts
import { promises as fs } from "node:fs";
import { basename, relative, resolve } from "node:path";
var MAX_PNG_BYTES = 20 * 1024 * 1024;
var MAX_IMAGE_WIDTH = 7680;
var MAX_IMAGE_HEIGHT = 4320;
var PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
async function validateWindowsStagingPath(stagingDir, imagePath, expectedCaptureId) {
  if (!isValidCaptureId(expectedCaptureId)) {
    throw new Error(`Security Alert: Invalid captureId ${expectedCaptureId}`);
  }
  const realStaging = await fs.realpath(resolve(stagingDir));
  const realImage = await fs.realpath(resolve(imagePath));
  const rel = relative(realStaging, realImage);
  if (rel.startsWith("..") || rel.includes(":") || rel.includes("/") || rel.includes("\\")) {
    throw new Error(`Security Alert: Path traversal detected: ${imagePath}`);
  }
  const expectedName = `${expectedCaptureId}.png`;
  if (basename(realImage) !== expectedName) {
    throw new Error(`Security Alert: Filename mismatch. Expected ${expectedName}, got ${basename(realImage)}`);
  }
  return realImage;
}
function validatePngPayload(bytes, maxWidth = MAX_IMAGE_WIDTH, maxHeight = MAX_IMAGE_HEIGHT, maxBytes = MAX_PNG_BYTES) {
  if (bytes.length > maxBytes) {
    return { valid: false, error: "IMAGE_TOO_LARGE" };
  }
  if (bytes.length < 8) return { valid: false, error: "INVALID_PNG_HEADER" };
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) {
      return { valid: false, error: "INVALID_PNG_HEADER" };
    }
  }
  if (bytes.length >= 24) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    if (width > maxWidth || height > maxHeight) {
      return { valid: false, error: "IMAGE_DIMENSION_EXCEEDED" };
    }
    return { valid: true, width, height };
  }
  return { valid: true };
}
async function ingestWindowsScreenshot(stagingDir, imagePath, captureId, frame) {
  const realImage = await validateWindowsStagingPath(stagingDir, imagePath, captureId);
  let payload;
  try {
    const st = await fs.stat(realImage);
    if (st.size > MAX_PNG_BYTES) {
      throw new Error("IMAGE_TOO_LARGE");
    }
    payload = new Uint8Array(await fs.readFile(realImage));
  } catch (err) {
    throw err;
  }
  const pngCheck = validatePngPayload(payload);
  if (!pngCheck.valid) {
    await fs.unlink(realImage).catch(() => {
    });
    throw new Error(pngCheck.error ?? "INVALID_PNG");
  }
  if (pngCheck.width === void 0 || pngCheck.height === void 0) {
    await fs.unlink(realImage).catch(() => {
    });
    throw new Error("INVALID_PNG_HEADER");
  }
  const width = pngCheck.width;
  const height = pngCheck.height;
  const frameW = Math.max(frame.width, frame.height);
  const frameH = Math.min(frame.width, frame.height);
  if (width !== void 0 && height !== void 0) {
    const pngW = Math.max(width, height);
    const pngH = Math.min(width, height);
    if (pngW !== frameW || pngH !== frameH) {
      await fs.unlink(realImage).catch(() => {
      });
      throw new Error("IHDR_METADATA_MISMATCH");
    }
  }
  await fs.unlink(realImage);
  const metadata = {
    appName: frame.appName,
    windowTitle: frame.windowTitle,
    mediaType: "image/png",
    width,
    height,
    bytes: payload.length,
    timestamp: frame.timestamp
  };
  return {
    captureId,
    payload,
    metadata,
    isFallback: frame.isFallback,
    fallbackReason: frame.fallbackReason,
    realImage
  };
}
function shouldCleanInstanceDir(ownerPid, dirModifiedAgeHours, isProcessAlive) {
  if (isProcessAlive(ownerPid)) {
    return { shouldClean: false, reason: "OWNER_ALIVE" };
  }
  if (dirModifiedAgeHours <= 24) {
    return { shouldClean: false, reason: "TOO_RECENT" };
  }
  return { shouldClean: true, reason: "OWNER_DEAD_AND_OLD" };
}
async function cleanOrphanWindowsStagingDirs(rootDir, now = Date.now(), isProcessAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}) {
  let entries;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let cleaned = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = resolve(rootDir, entry.name);
    const match = /^(\d+)-(.+)$/.exec(entry.name);
    if (!match) continue;
    const ownerPid = Number(match[1]);
    const lockPath = resolve(dirPath, "instance.lock");
    let lockInfo = null;
    try {
      const raw = await fs.readFile(lockPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (typeof parsed.ownerPid === "number" && typeof parsed.instanceId === "string") {
        lockInfo = { ownerPid: parsed.ownerPid, instanceId: parsed.instanceId };
      }
    } catch {
    }
    const effectivePid = lockInfo?.ownerPid ?? ownerPid;
    try {
      const st = await fs.stat(dirPath);
      const ageHours = (now - st.mtimeMs) / 36e5;
      const decision = shouldCleanInstanceDir(effectivePid, ageHours, isProcessAlive);
      if (decision.shouldClean) {
        await fs.rm(dirPath, { recursive: true, force: true });
        cleaned++;
      }
    } catch {
    }
  }
  return cleaned;
}
async function writeInstanceLock(dirPath, info) {
  await fs.mkdir(dirPath, { recursive: true });
  await fs.writeFile(resolve(dirPath, "instance.lock"), JSON.stringify(info), "utf-8");
}

// src/windows/config-store.ts
import { mkdir, readFile as readFile2, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname as dirname2, join as join3 } from "node:path";
import { randomUUID } from "node:crypto";
var SHORTCUT_MODES = [
  "double-cmd",
  "double-option",
  "double-control",
  "cmd-option",
  "double-ctrl",
  "custom"
];
var DEFAULT_WINDOWS_CONFIG = {
  platform: "win32",
  shortcutMode: "double-ctrl",
  windowsHotkeys: { left: "lctrl", right: "rctrl" },
  soundEnabled: true,
  animationEnabled: true
};
function resolveConfigStorePath() {
  const appdata = process.env.APPDATA;
  if (appdata) return join3(appdata, "dsh-plugin-appshot", "config.json");
  const home = process.env.HOME ?? tmpdir();
  return join3(home, ".dsh-plugin-appshot", "config.json");
}
function sanitizeWindowsConfig(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw;
  const config = {};
  if (typeof source.shortcutMode === "string" && SHORTCUT_MODES.includes(source.shortcutMode)) {
    config.shortcutMode = source.shortcutMode;
  }
  if (isValidWindowsHotkeys(source.windowsHotkeys)) {
    config.windowsHotkeys = { ...source.windowsHotkeys };
  }
  if (typeof source.soundEnabled === "boolean") config.soundEnabled = source.soundEnabled;
  if (typeof source.animationEnabled === "boolean") config.animationEnabled = source.animationEnabled;
  return Object.keys(config).length > 0 ? config : null;
}
async function loadWindowsConfig(path) {
  try {
    const raw = await readFile2(path, "utf-8");
    return sanitizeWindowsConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}
async function saveWindowsConfig(path, config) {
  try {
    await mkdir(dirname2(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(tmp, JSON.stringify(config, null, 2) + "\n", "utf-8");
    await rename(tmp, path);
    return true;
  } catch {
    return false;
  }
}

// src/windows/index.ts
function resolveWindowsAgentBinaryPath() {
  const currentDir = typeof __dirname !== "undefined" ? __dirname : dirname3(fileURLToPath2(import.meta.url));
  const candidates = [
    // 打包后：dist/index.js → ../native/windows/bin/win-x64/
    join4(currentDir, "../native/windows/bin/win-x64/appshot-win-x64.exe"),
    // 开发态：src/windows/index.ts → ../../native/windows/bin/win-x64/
    join4(currentDir, "../../native/windows/bin/win-x64/appshot-win-x64.exe")
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync2(candidate)) return candidate;
    } catch {
    }
  }
  return candidates[0];
}
async function applyWindows(ctx, options = {}) {
  const instanceId = randomUUID2();
  const stagingRoot = options.stagingRoot ?? join4(tmpdir2(), "dsh-appshot");
  const stagingDir = join4(stagingRoot, `${process.pid}-${instanceId}`);
  const configPath = options.configPath ?? resolveConfigStorePath();
  await writeInstanceLock(stagingDir, { ownerPid: process.pid, instanceId });
  void cleanOrphanWindowsStagingDirs(stagingRoot).catch((err) => {
    console.error("[dsh-plugin-appshot] windows orphan staging GC failed:", err);
  });
  let agent = null;
  const machine = new WindowsCaptureStateMachine({
    onNativeFrame: (frame) => {
      agent?.send(frame);
    }
  });
  const guardTimer = setInterval(() => {
    machine.onTimeoutTriggered(Date.now());
  }, 500);
  const handleAgentReady = () => {
    const state = machine.getState();
    if (state.type === "PENDING_ACK") {
      agent?.send({ type: "status", captureId: state.captureId, state: "WAITING_DSH" });
    }
    for (const completed of machine.getCompletedCaptures()) {
      if (!completed.notificationPresented) {
        agent?.send({
          type: "status",
          captureId: completed.captureId,
          state: completed.finalNativeStatus === "FALLBACK_SUCCESS" ? "FALLBACK_SUCCESS" : "SUCCESS"
        });
      }
    }
    sendConfigToAgent();
  };
  const onNativeFrame = async (frame) => {
    switch (frame.type) {
      case "ready": {
        console.log("[dsh-plugin-appshot] windows agent ready, pid:", frame.pid);
        handleAgentReady();
        return;
      }
      case "capture/request": {
        const result = machine.onCaptureStarted(frame.captureId, Date.now());
        if (!result.accepted) {
          console.log("[dsh-plugin-appshot] capture rejected:", result.error, frame.captureId);
        }
        return;
      }
      case "appshot": {
        try {
          const ingested = await ingestWindowsScreenshot(stagingDir, frame.imagePath, frame.captureId, {
            appName: frame.appName,
            windowTitle: frame.windowTitle,
            width: frame.width,
            height: frame.height,
            isFallback: frame.isFallback,
            fallbackReason: frame.fallbackReason,
            timestamp: frame.timestamp
          });
          const accepted = machine.onAppshotReceived(
            frame.captureId,
            ingested.payload,
            ingested.metadata,
            ingested.isFallback,
            ingested.fallbackReason
          );
          if (!accepted.accepted) {
            console.warn("[dsh-plugin-appshot] late/unknown appshot frame ignored:", frame.captureId);
          }
        } catch (err) {
          console.error("[dsh-plugin-appshot] windows ingest failed:", err);
          machine.onCaptureError(frame.captureId);
          agent?.send({ type: "status", captureId: frame.captureId, state: "ERROR" });
        }
        return;
      }
      case "error": {
        if (frame.captureId) {
          machine.onCaptureError(frame.captureId);
          agent?.send({ type: "status", captureId: frame.captureId, state: "ERROR" });
        } else {
          console.error("[dsh-plugin-appshot] windows agent error:", frame.code, frame.message);
        }
        return;
      }
      case "cancel/request": {
        machine.onCancelRequest(frame.captureId);
        return;
      }
      case "status/presented": {
        machine.onStatusPresented(frame.captureId, frame.state);
        return;
      }
      case "fatal": {
        console.error("[dsh-plugin-appshot] windows agent fatal:", frame.code, frame.message);
        return;
      }
      default: {
        const exhaustive = frame;
        console.warn("[dsh-plugin-appshot] unknown windows frame:", exhaustive);
      }
    }
  };
  const storedConfig = await loadWindowsConfig(configPath);
  let currentConfig = { ...DEFAULT_WINDOWS_CONFIG, ...storedConfig };
  const sendConfigToAgent = () => {
    const hotkeys = currentConfig.shortcutMode === "custom" && currentConfig.windowsHotkeys ? currentConfig.windowsHotkeys : { left: "lctrl", right: "rctrl" };
    agent?.send({
      type: "config/update",
      hotkeys,
      soundEnabled: currentConfig.soundEnabled ?? true,
      animationEnabled: currentConfig.animationEnabled ?? true
    });
  };
  const disposeRoutes = registerWindowsRoutes(ctx, {
    machine,
    getConfig: () => ({ ...currentConfig }),
    onConfigUpdate: (next) => {
      currentConfig = { ...next, platform: "win32" };
      console.log("[dsh-plugin-appshot] windows config updated:", currentConfig);
      void saveWindowsConfig(configPath, currentConfig).then((ok) => {
        if (!ok) console.warn("[dsh-plugin-appshot] windows config persist failed:", configPath);
      });
      sendConfigToAgent();
    },
    onW0Report: (report) => {
      const line = JSON.stringify({ ts: Date.now(), report });
      console.log("[dsh-plugin-appshot] W0 report received:", line);
      void import("node:fs/promises").then(
        (fs2) => fs2.appendFile(join4(stagingDir, "..", "..", "w0-reports.jsonl"), line + "\n").catch(() => {
        })
      );
    }
  });
  const spawnAgent = options.spawnAgent !== false && process.env.DSH_DISABLE_AGENT_SPAWN !== "1";
  const diagPath = join4(stagingDir, "diag.txt");
  const appendDiag = (line) => {
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    void import("node:fs/promises").then(
      (fs2) => fs2.appendFile(diagPath, `[${timestamp}] ${line}
`, "utf-8").catch(() => {
      })
    );
  };
  appendDiag(`init: spawnAgent=${spawnAgent} DSH_DISABLE_AGENT_SPAWN=${String(process.env.DSH_DISABLE_AGENT_SPAWN)}`);
  if (spawnAgent) {
    const binaryPath = resolveWindowsAgentBinaryPath();
    const binaryExists = existsSync2(binaryPath);
    appendDiag(`binaryPath=${binaryPath} binaryExists=${binaryExists} cwd=${process.cwd()} ppid=${String(process.ppid || process.pid)}`);
    if (binaryPath && binaryExists) {
      agent = startWindowsAgent({
        command: binaryPath,
        args: ["--mode", "daemon", "--staging-dir", stagingDir, "--dsh-pid", String(process.ppid || process.pid)],
        readyTimeoutMs: 15e3,
        onFrame: (frame) => {
          if (frame.type === "ready") {
            appendDiag(`agent ready received: pid=${frame.pid}`);
          } else if (frame.type === "fatal") {
            appendDiag(`agent fatal: code=${frame.code} message=${frame.message}`);
          }
          void onNativeFrame(frame);
        },
        onExit: (info) => {
          const stderr = agent?.stderrLines().join(" | ") ?? "";
          appendDiag(`agent exited: code=${String(info.code)} signal=${String(info.signal)} willRestart=${info.willRestart} stderr=${stderr}`);
          console.log("[dsh-plugin-appshot] windows agent exited:", info.code, "signal:", info.signal, "willRestart:", info.willRestart, "stderr:", stderr);
        }
      });
      appendDiag(`agent started: pid=${String(agent.pid)}`);
    } else {
      appendDiag(`agent spawn skipped: binary not found at ${binaryPath}`);
    }
  }
  const runtime = {
    machine,
    agent,
    stagingDir,
    dispose: async () => {
      clearInterval(guardTimer);
      disposeRoutes();
      machine.dispose();
      if (agent) {
        await agent.stop();
        agent = null;
      }
    }
  };
  if (typeof ctx.effect === "function") {
    ctx.effect(() => () => {
      void runtime.dispose();
    });
  }
  return runtime;
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

// src/client/settings.ts
import React, { useState, useEffect } from "react";
var h = React.createElement;
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
  const [config, setConfig] = useState({
    platform: isWinClient ? "win32" : "darwin",
    shortcutMode: isWinClient ? "double-ctrl" : "dual-cmd",
    windowsHotkeys: { left: "lctrl", right: "rctrl" },
    soundEnabled: true,
    animationEnabled: true
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedBadge, setSavedBadge] = useState(false);
  useEffect(() => {
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
  const [recording, setRecording] = useState(false);
  const [pendingKey, setPendingKey] = useState(null);
  const cancelRecording = () => {
    setRecording(false);
    setPendingKey(null);
  };
  useEffect(() => {
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

// src/index.ts
var name = "dsh-plugin-appshot";
var inject = ["attachments", "webServer", "sessions", "settings"];
var globalState = {};
function apply(ctx) {
  if (process.platform === "win32") {
    console.log("[dsh-plugin-appshot] windows platform detected, applying windows runtime...");
    applyWindows(ctx, {}).then((runtime) => {
      globalState.windows = runtime;
      console.log("[dsh-plugin-appshot] windows runtime applied, staging:", runtime.stagingDir);
    }).catch((err) => {
      console.error("[dsh-plugin-appshot] windows runtime apply failed:", err);
    });
    return;
  }
  applyMacos(ctx);
}
function dispose(ctx) {
  if (globalState.windows) {
    void globalState.windows.dispose();
    globalState.windows = void 0;
  }
  disposeMacos();
  console.log("[dsh-plugin-appshot] plugin disposed");
}
export {
  AppshotSettingsSection,
  WINDOWS_MODIFIER_KEYS,
  apply,
  applyWindows,
  cleanOrphanStagingFiles,
  createAppshotClient,
  createAppshotSSEHub,
  createNdjsonParser,
  dispose,
  ingestScreenshot,
  inject,
  isValidWindowsHotkeys,
  isWindowsModifierKey,
  name,
  startAgent
};
