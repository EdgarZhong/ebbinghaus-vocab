/**
 * Tauri 双端云同步装配：本地 SQLite 始终是 UI 工作库；共享 SyncEngine 负责
 * outbox、幂等拉取与退避，此处只接本机加密令牌、固定 HTTPS 出口和触发时机。
 */
import { invoke } from "@tauri-apps/api/core";
import type { Clock } from "@ebbinghaus/application";
import type { InMemoryRuntime } from "@ebbinghaus/persistence/src/adapters/inMemoryRuntime.ts";
import type { SecretCipher } from "@ebbinghaus/persistence/src/repositories/settings.ts";
import { buildHttpSyncGateway } from "@ebbinghaus/persistence/src/sync/httpGateway.ts";
import { SyncEngine, type SyncCycleResult } from "@ebbinghaus/persistence/src/sync/syncEngine.ts";

export const CLOUD_SYNC_ENDPOINT = "https://eb-data.edgarzhong.fyi";
const TOKEN_STORE_KEY = "cloud_sync_auth_token_cipher_v1";
// 前台轮询遵循技术决策中的 5–10 秒窗口；本地写入仍由独立的短合并窗口优先触发。
const SYNC_INTERVAL_MS = 10_000;
const LOCAL_CHANGE_DEBOUNCE_MS = 350;

interface SyncHttpResponse { readonly status: number; readonly body: string }
interface PullCursor { read(): number; write(value: number): void }

/** 桌面运行时比浏览器端口集合多一个 SQLite 持久游标；类型收窄仅在组合边界。 */
type DesktopSyncRuntime = InMemoryRuntime & { readonly pullCursor: PullCursor };

export interface CloudSyncStatus {
  readonly configured: boolean;
  readonly running: boolean;
  readonly lastSuccessAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly lastError: string | null;
  readonly pendingOutboxCount: number;
}

export interface CloudSyncController {
  hasToken(): boolean;
  /** 空字符串清除本机令牌；非空令牌独立保存，不依赖设置页的统一保存按钮。 */
  configureToken(token: string): void;
  /** 用户显式重试：跳过出站退避；未配置时返回 null，网络失败收敛到结果。 */
  syncNow(): Promise<SyncCycleResult | null>;
  /** 幂等启动：立即执行一次，随后在回前台和定时器触发。 */
  start(): void;
  /** 本地学习数据已落盘后合并短时间内的通知，尽快异步推送。 */
  requestSyncSoon(): void;
  /** 只订阅同步运行状态，不触发学习页面重读。 */
  subscribeStatus(listener: () => void): () => void;
  getStatusVersion(): number;
  getStatus(): CloudSyncStatus;
  stop(): void;
}

/**
 * 只接受共享 HTTP 网关实际产生的字符串或 ArrayBuffer 载荷。Rust 再校验固定域名、
 * 方法和路径；传输层不得把网络错误、令牌或服务端原文写入日志。
 */
function createTauriSyncFetch(authToken: string): typeof fetch {
  return async (input, init) => {
    const source = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(source);
    if (url.origin !== CLOUD_SYNC_ENDPOINT || url.username || url.password || url.hash) {
      throw new Error("云同步请求目的地无效");
    }
    const method = init?.method ?? "GET";
    const path = `${url.pathname}${url.search}`;
    let body: number[] | undefined;
    if (typeof init?.body === "string") {
      body = [...new TextEncoder().encode(init.body)];
    } else if (init?.body instanceof ArrayBuffer) {
      body = [...new Uint8Array(init.body)];
    } else if (init?.body !== undefined && init.body !== null) {
      throw new Error("云同步请求载荷类型无效");
    }
    const contentEncoding = new Headers(init?.headers).get("Content-Encoding");
    const response = await invoke<SyncHttpResponse>("sync_http_request", {
      method, path, authToken, body, contentEncoding,
    });
    return new Response(response.body, {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

/** 创建桌面同步控制器；只在 Tauri 组合根调用，浏览器演示环境不装配网络出口。 */
export function createTauriCloudSync(
  runtime: InMemoryRuntime,
  cipher: SecretCipher,
  clock: Clock,
  onChanged: () => void,
): CloudSyncController {
  const desktop = runtime as DesktopSyncRuntime;
  let token: string | null = null;
  let lastError: string | null = null;
  let lastSuccessAt: string | null = null;
  let lastAttemptAt: string | null = null;
  let inFlight: Promise<SyncCycleResult | null> | null = null;
  let manualQueued = false;
  let manualWaiters: Array<(result: SyncCycleResult | null) => void> = [];
  let interval: ReturnType<typeof setInterval> | null = null;
  let localChangeTimer: ReturnType<typeof setTimeout> | null = null;
  let localChangeQueued = false;
  let started = false;
  let statusVersion = 0;
  const statusListeners = new Set<() => void>();

  const notifyStatus = (): void => {
    statusVersion += 1;
    // 状态显示失败不能中断已经开始的同步或 outbox 清队。
    for (const listener of statusListeners) {
      try { listener(); } catch { /* 其余订阅者仍需收到状态。 */ }
    }
  };

  try {
    const stored = runtime.deviceLocalStore.getString(TOKEN_STORE_KEY);
    if (stored) token = cipher.decrypt(stored);
  } catch {
    // 无法解密时仍让本地学习库正常启动；设置页可重新配置，旧密文不发往云端。
    lastError = "本机云同步令牌无法解密，请重新配置";
  }

  const notifyChanged = (): void => {
    // 界面刷新是附属动作；回调异常不得让已落地的事件游标停在半途。
    try { onChanged(); } catch { /* 同步状态仍由本地库与下一轮同步恢复。 */ }
  };

  async function runCycle(forcePush: boolean): Promise<SyncCycleResult | null> {
    const currentToken = token;
    if (!currentToken) return null;
    lastAttemptAt = clock.now().toISOString();
    try {
      // 只有云端事实真正改变本机工作库时才通知学习页面重读。以前每轮同步
      // 开始/结束都广播，30 秒定时器和回前台会让今日/词汇在无变化时重算。
      const settingsBefore = JSON.stringify(runtime.syncedSettingsStore.getAll());
      const engine = new SyncEngine({
        gateway: buildHttpSyncGateway({
          baseUrl: CLOUD_SYNC_ENDPOINT,
          authToken: currentToken,
          fetchImpl: createTauriSyncFetch(currentToken),
        }),
        eventStore: runtime.eventStore,
        settingsStore: runtime.syncedSettingsStore,
        contentStore: runtime.contentSyncStore,
        outbox: runtime.outbox,
        clock,
        pullCursor: desktop.pullCursor,
      });
      const result = await engine.runCycle({ forcePush });
      const settingsChanged = settingsBefore !== JSON.stringify(runtime.syncedSettingsStore.getAll());
      // 同步引擎先拉目录再拉事件，按页写入；中途刷新会让界面读取到
      // 尚未齐备的学习状态。整轮结束后统一通知一次。
      lastError = result.errors.length > 0 ? result.errors.join("；") : null;
      if (result.errors.length === 0) lastSuccessAt = clock.now().toISOString();
      if (settingsChanged || result.pulledContentCount > 0 || result.pulledEventCount > 0) notifyChanged();
      return result;
    } catch {
      // 端口意外异常也不外抛：用户写入早已进入本地 SQLite/outbox，等待下轮重试。
      lastError = "本轮云同步未完成，本地数据已保留";
      return {
        pulledEventCount: 0, pulledContentCount: 0,
        pushedEntryCount: 0, pushedContentCount: 0,
        settingsReconciled: false, errors: [lastError],
      };
    }
  }

  function startCycle(forcePush: boolean): Promise<SyncCycleResult | null> {
    if (inFlight) return inFlight;
    inFlight = runCycle(forcePush).finally(() => {
      inFlight = null;
      // 错误与待同步数量在完整一轮结束后才确定；此通知只刷新设置页状态。
      notifyStatus();
      // 写入可能发生在一轮拉取或推送期间；该轮是否包含新条目并不确定，
      // 因此在结束后再补一轮，确保无需用户打开设置页手动同步。
      if (manualQueued) {
        // 用户点击发生在自动同步期间时，原循环可能已读过出站队列；必须
        // 再跑一次强制重试，并把这一轮的真实结果交还给点击者。
        manualQueued = false;
        localChangeQueued = false;
        const waiters = manualWaiters;
        manualWaiters = [];
        void startCycle(true).then((result) => {
          for (const resolve of waiters) resolve(result);
        });
      } else if (localChangeQueued && started && token) {
        localChangeQueued = false;
        void startCycle(false);
      }
    });
    notifyStatus();
    return inFlight;
  }

  function syncNow(): Promise<SyncCycleResult | null> {
    if (!inFlight) return startCycle(true);
    manualQueued = true;
    return new Promise((resolve) => { manualWaiters.push(resolve); });
  }

  const onWindowFocus = (): void => { void startCycle(false); };
  const flushLocalChange = (): void => {
    if (!started || !token || !localChangeTimer) return;
    clearTimeout(localChangeTimer);
    localChangeTimer = null;
    // 移动系统可能在 350 毫秒合并窗口内暂停 WebView；退后台前尽早发出。
    if (inFlight) localChangeQueued = true;
    else void startCycle(false);
  };
  const onVisible = (): void => {
    if (document.visibilityState === "visible") void startCycle(false);
    else flushLocalChange();
  };

  return {
    hasToken: () => Boolean(token),
    configureToken(value) {
      const next = value.trim();
      if (next && (next.length > 4096 || !/^[\x21-\x7e]+$/.test(next))) {
        throw new Error("云同步令牌包含无效字符或超过大小上限");
      }
      // 先成功加密并持久化，再切换内存中的活动令牌；写入失败时旧令牌仍可用。
      runtime.deviceLocalStore.setString(TOKEN_STORE_KEY, next ? cipher.encrypt(next) : "");
      token = next || null;
      lastError = null;
      notifyStatus();
      if (started && token) void startCycle(false);
    },
    syncNow,
    requestSyncSoon() {
      if (!started || !token) return;
      if (localChangeTimer) clearTimeout(localChangeTimer);
      // 一次业务操作可能先更新事件、再更新视图；合并通知以免重复请求。
      localChangeTimer = setTimeout(() => {
        localChangeTimer = null;
        if (inFlight) {
          localChangeQueued = true;
        } else {
          void startCycle(false);
        }
      }, LOCAL_CHANGE_DEBOUNCE_MS);
    },
    start() {
      if (started) return;
      started = true;
      window.addEventListener("focus", onWindowFocus);
      window.addEventListener("pagehide", flushLocalChange);
      document.addEventListener("visibilitychange", onVisible);
      interval = setInterval(() => { void startCycle(false); }, SYNC_INTERVAL_MS);
      void startCycle(false);
    },
    subscribeStatus(listener) {
      statusListeners.add(listener);
      return () => { statusListeners.delete(listener); };
    },
    getStatusVersion: () => statusVersion,
    getStatus() {
      return {
        configured: Boolean(token), running: inFlight !== null,
        lastSuccessAt, lastAttemptAt, lastError,
        // 内容目录使用独立 content_outbox；漏算会造成界面显示 0 但词条仍待上传。
        pendingOutboxCount: runtime.outbox.pendingCount() + runtime.contentSyncStore.pendingCount(),
      };
    },
    stop() {
      if (!started) return;
      started = false;
      window.removeEventListener("focus", onWindowFocus);
      window.removeEventListener("pagehide", flushLocalChange);
      document.removeEventListener("visibilitychange", onVisible);
      if (interval) clearInterval(interval);
      interval = null;
      if (localChangeTimer) clearTimeout(localChangeTimer);
      localChangeTimer = null;
      localChangeQueued = false;
    },
  };
}
