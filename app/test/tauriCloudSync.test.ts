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
  afterEach(() => { vi.useRealTimers(); });

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

    const result = await controller.syncNow();
    expect(result?.errors.length).toBeGreaterThan(0);
    expect(controller.getStatus()).toMatchObject({ configured: true, running: false, lastSuccessAt: null });
    expect(controller.getStatus().lastError).toBeTruthy();
    expect(runtime.outbox.pendingCount()).toBe(0);
    // 重启控制器后仍能从密文恢复令牌；清空只作用于设备本地 KV。
    expect(createTauriCloudSync(runtime, cipher, clock, vi.fn()).hasToken()).toBe(true);
    controller.configureToken("");
    expect(controller.hasToken()).toBe(false);
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
    expect(invoke).toHaveBeenCalledTimes(3);
    window.dispatchEvent(new Event("focus"));
    expect((await controller.syncNow())?.errors).toEqual([]);
    expect(invoke).toHaveBeenCalledTimes(6);
    // 云端没有新增内容/事件/设置时，后台定时与回前台同步不能广播全页重读；
    // changed 只来自上方 configureToken 的一次本机配置变化。
    expect(changed).toHaveBeenCalledTimes(1);
    expect(controller.getStatus().lastSuccessAt).toBe(clock.now().toISOString());
    expect(vi.mocked(invoke).mock.calls.every(([command, args]) => {
      const request = args as { authToken: string; path: string };
      return command === "sync_http_request" && request.authToken === "test-only-secret"
        && (request.path === "/settings" || request.path.startsWith("/content?") || request.path.startsWith("/sync/pull?"));
    })).toBe(true);
    expect(CLOUD_SYNC_ENDPOINT).toBe("https://eb-data.edgarzhong.fyi");
    controller.stop();
  });
});
