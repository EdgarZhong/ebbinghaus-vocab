/**
 * 云同步端点构建期配置测试：端点只能来自 VITE_CLOUD_SYNC_URL，未配置、非 HTTPS
 * 或带凭据的地址一律视为未配置（空字符串），同步层据此整体关闭云同步。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

/** 端点是模块级常量，每次用重置模块缓存后的动态导入重新求值。 */
async function loadEndpoint(): Promise<string> {
  vi.resetModules();
  const module = await import("../src/adapters/cloudSyncEndpoint.ts");
  return module.CLOUD_SYNC_ENDPOINT;
}

describe("云同步端点构建期配置", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("未配置构建变量时不存在任何默认端点", async () => {
    vi.stubEnv("VITE_CLOUD_SYNC_URL", "");
    expect(await loadEndpoint()).toBe("");
  });

  it("尾随路径与斜杠规整为裸源", async () => {
    vi.stubEnv("VITE_CLOUD_SYNC_URL", "https://sync.example.com/api/");
    expect(await loadEndpoint()).toBe("https://sync.example.com");
  });

  it("拒绝非 HTTPS 地址", async () => {
    vi.stubEnv("VITE_CLOUD_SYNC_URL", "http://sync.example.com");
    expect(await loadEndpoint()).toBe("");
  });

  it("拒绝带用户名密码的地址", async () => {
    vi.stubEnv("VITE_CLOUD_SYNC_URL", "https://user:pass@sync.example.com");
    expect(await loadEndpoint()).toBe("");
  });

  it("保留自托管的非默认端口", async () => {
    vi.stubEnv("VITE_CLOUD_SYNC_URL", "https://sync.example.com:8443");
    expect(await loadEndpoint()).toBe("https://sync.example.com:8443");
  });
});
