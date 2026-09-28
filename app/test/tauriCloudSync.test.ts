/** 桌面同步边界测试：真实共享引擎 + 本机命令替身，覆盖令牌持久化与断网降级。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { createInMemoryRuntime } from "@ebbinghaus/persistence/src/adapters/inMemoryRuntime.ts";
import type { SecretCipher } from "@ebbinghaus/persistence/src/repositories/settings.ts";
import { createTauriCloudSync, CLOUD_SYNC_ENDPOINT } from "../src/adapters/tauriCloudSync.ts";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const cipher: SecretCipher = {
  encrypt: (plaintext) => `encrypted:${plaintext.split("").reverse().join("")}`,
  decrypt: (ciphertext) => ciphertext.slice("encrypted:".length).split("").reverse().join(""),
};
const clock = { now: () => new Date("2026-09-26T00:00:00.000Z") };

function fixture() {
  const runtime = createInMemoryRuntime({
    clock,
    idGenerator: { nextId: () => "12345678-1234-4234-8234-123456789abc" },
    secretCipher: cipher,
  });
  // 浏览器内存运行时没有持久游标；桌面生产运行时在同名端口上注入 SQLite 游标。
  let cursor = 0;
  return Object.assign(runtime, {
    pullCursor: { read: () => cursor, write: (value: number) => { cursor = value; } },
  });
}

describe("Tauri 云同步适配器", () => {
  beforeEach(() => { vi.mocked(invoke).mockReset(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("独立加密保存令牌，未配置与断网均不阻塞本地运行时", async () => {
    const runtime = fixture();
    const controller = createTauriCloudSync(runtime, cipher, clock, vi.fn());
    expect(await controller.syncNow()).toBeNull();
    expect(invoke).not.toHaveBeenCalled();

    controller.configureToken("test-only-secret");
    const stored = runtime.deviceLocalStore.getString("cloud_sync_auth_token_cipher_v1");
    expect(stored).not.toBe("test-only-secret");
    expect(stored).not.toContain("test-only-secret");
    vi.mocked(invoke).mockRejectedValue(new Error("offline"));

    vi.useFakeTimers();
    controller.start();
    const result = await controller.syncNow();
    expect(result?.errors.length).toBeGreaterThan(0);
    expect(controller.getStatus()).toMatchObject({ configured: true, running: false, lastSuccessAt: null });
    expect(controller.getStatus().lastError).toBeTruthy();
    const statusChanged = vi.fn();
    controller.subscribeStatus(statusChanged);
    // 连接恢复后，后台下一轮会清除错误并通知状态订阅者，无需打开设置页手动同步。
    vi.mocked(invoke).mockImplementation(async (_command, args) => {
      const path = (args as { path: string }).path;
      if (path === "/settings") return { status: 200, body: JSON.stringify({ settings: [] }) };
      if (path.startsWith("/content?")) return { status: 200, body: JSON.stringify({ contents: [], nextCursor: 0, hasMore: false }) };
      if (path.startsWith("/sync/pull?")) return { status: 200, body: JSON.stringify({ events: [], nextCursor: 0, hasMore: false }) };
      throw new Error(`未知路径：${path}`);
    });
    const beforeRecovery = controller.getStatusVersion();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(controller.getStatus()).toMatchObject({ running: false, lastError: null });
    expect(controller.getStatusVersion()).toBeGreaterThan(beforeRecovery);
    expect(statusChanged).toHaveBeenCalled();
    expect(runtime.outbox.pendingCount()).toBe(0);
    // 重启控制器后仍能从密文恢复令牌；清空只作用于设备本地 KV。
    expect(createTauriCloudSync(runtime, cipher, clock, vi.fn()).hasToken()).toBe(true);
    controller.configureToken("");
    expect(controller.hasToken()).toBe(false);
    controller.stop();
  });

  it("只走固定云端路径，启动、回前台和手动同步复用同一引擎", async () => {
    const runtime = fixture();
    const changed = vi.fn();
    const controller = createTauriCloudSync(runtime, cipher, clock, changed);
    controller.configureToken("test-only-secret");
    vi.mocked(invoke).mockImplementation(async (_command, args) => {
      const path = (args as { path: string }).path;
      if (path === "/settings") return { status: 200, body: JSON.stringify({ settings: [] }) };
      if (path.startsWith("/content?")) return { status: 200, body: JSON.stringify({ contents: [], nextCursor: 0, hasMore: false }) };
      if (path.startsWith("/sync/pull?")) return { status: 200, body: JSON.stringify({ events: [], nextCursor: 0, hasMore: false }) };
      throw new Error(`未知路径：${path}`);
    });

    controller.start();
    expect((await controller.syncNow())?.errors).toEqual([]);
    // 启动轮尚在运行时显式点击，控制器会补跑一轮并把补跑结果返回调用方。
    expect(invoke).toHaveBeenCalledTimes(6);
    window.dispatchEvent(new Event("focus"));
    expect((await controller.syncNow())?.errors).toEqual([]);
    expect(invoke).toHaveBeenCalledTimes(12);
    // 本机写入通知应合并并自动触发，不要求用户进入设置点“立即同步”。
    vi.useFakeTimers();
    controller.requestSyncSoon();
    controller.requestSyncSoon();
    await vi.advanceTimersByTimeAsync(349);
    expect(invoke).toHaveBeenCalledTimes(12);
    await vi.advanceTimersByTimeAsync(1);
    expect(invoke).toHaveBeenCalledTimes(15);
    // 云端没有新增内容/事件/设置时，后台定时与回前台同步不能广播全页重读；
    // 令牌配置和空同步仅通知状态，不广播全页业务刷新。
    expect(changed).not.toHaveBeenCalled();
    // 页面在合并窗口内退后台时，不能依赖可能被冻结的定时器才发送。
    controller.requestSyncSoon();
    window.dispatchEvent(new Event("pagehide"));
    expect((await controller.syncNow())?.errors).toEqual([]);
    expect(invoke).toHaveBeenCalledTimes(21);
    await vi.advanceTimersByTimeAsync(350);
    expect(invoke).toHaveBeenCalledTimes(21);
    expect(controller.getStatus().lastSuccessAt).toBe(clock.now().toISOString());
    expect(vi.mocked(invoke).mock.calls.every(([command, args]) => {
      const request = args as { authToken: string; path: string };
      return command === "sync_http_request" && request.authToken === "test-only-secret"
        && (request.path === "/settings" || request.path.startsWith("/content?") || request.path.startsWith("/sync/pull?"));
    })).toBe(true);
    expect(CLOUD_SYNC_ENDPOINT).toBe("https://eb-data.edgarzhong.fyi");
    controller.stop();
  });

  it("自动轮进行中点击立即同步会补跑强制轮并返回该轮结果，状态计入内容队列", async () => {
    // jsdom 的 Blob 没有 stream；网关在不支持压缩的环境会用明文 JSON 退化传输。
    vi.stubGlobal("CompressionStream", undefined);
    const runtime = fixture();
    const controller = createTauriCloudSync(runtime, cipher, clock, vi.fn());
    controller.configureToken("test-only-secret");
    let releaseFirstSettings: (() => void) | undefined;
    const firstSettings = new Promise<void>((resolve) => { releaseFirstSettings = resolve; });
    let settingsCalls = 0;
    let pushCalls = 0;
    const eventId = "11111111-1111-4111-8111-000000000903";
    vi.mocked(invoke).mockImplementation(async (_command, args) => {
      const path = (args as { path: string }).path;
      if (path === "/settings") {
        settingsCalls += 1;
        if (settingsCalls === 1) await firstSettings;
        return { status: 200, body: JSON.stringify({ settings: [] }) };
      }
      if (path === "/sync/push") {
        pushCalls += 1;
        return { status: 200, body: JSON.stringify({ accepted: [{ eventId, serverSeq: 1 }], duplicated: [] }) };
      }
      if (path.startsWith("/content?")) return { status: 200, body: JSON.stringify({ contents: [], nextCursor: 0, hasMore: false }) };
      if (path.startsWith("/sync/pull?")) return { status: 200, body: JSON.stringify({ events: [], nextCursor: 0, hasMore: false }) };
      throw new Error(`未知路径：${path}`);
    });

    controller.start();
    try {
      await vi.waitFor(() => { expect(settingsCalls).toBe(1); });
      // 自动轮已经读过出站队列；此时新事件必须由排队的手动轮发出。
      runtime.eventStore.appendEvents([{
        eventId, eventType: "firstPassRecorded", targetType: "List", targetId: "manual-queued",
        occurredAt: clock.now().toISOString(), learningDay: "2026-09-26",
        source: "首过预览保存", deviceId: runtime.deviceIdentity.getDeviceId(), deviceSeq: 1,
        metadata: { workload: 1, marker: "manual-queued" },
      }]);
      expect(controller.getStatus().pendingOutboxCount).toBe(1);
      const manual = controller.syncNow();
      releaseFirstSettings?.();
      const result = await manual;
      expect(result).toMatchObject({ pushedEntryCount: 1, errors: [] });
      expect(pushCalls).toBe(1);
      expect(controller.getStatus().pendingOutboxCount).toBe(0);

      runtime.contentSyncStore.recordLocal("space", "22222222-2222-4222-8222-222222222224", {
        id: "22222222-2222-4222-8222-222222222224", kind: null, displayOrder: 10,
        name: "待同步内容", archivedAt: null, createdAt: clock.now().toISOString(),
        updatedAt: clock.now().toISOString(), learningMode: "词书模式",
      });
      expect(controller.getStatus().pendingOutboxCount).toBe(1);
    } finally {
      controller.stop();
    }
  });
});
