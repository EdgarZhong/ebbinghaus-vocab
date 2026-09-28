/** 浏览器与 Tauri 的启动入口；桌面端经本机桥使用正式 SQLite 工作库。 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import { App } from "./App.tsx";
import { createAppServices, getRuntime, type AppServices } from "./composition.ts";
import "./theme/index.css";

/**
 * 仅本轮 Android 测试包使用的首次启动连接种子。值在构建时由 Vite 环境注入，
 * 不写入源码、测试夹具或仓库文档；普通构建没有这两个变量，条件分支被剪除。
 * 只在本机尚未配置对应服务时写入，随后记标记，避免升级或重启覆盖用户改动。
 * 测试包内含可提取的临时凭据，因此它不作为正式发布包使用。
 */
function seedAndroidTestConnections(services: AppServices): void {
  const cloudToken = import.meta.env["VITE_ANDROID_TEST_SEED_CLOUD_TOKEN"];
  const modelApiKey = import.meta.env["VITE_ANDROID_TEST_SEED_MODEL_API_KEY"];
  if (!navigator.userAgent.includes("Android") || !cloudToken || !modelApiKey) return;
  const seedMarker = "android_test_connections_seed_v1";
  if (services.deviceLocal.getString(seedMarker) === "done") return;
  if (services.cloudSync && !services.cloudSync.hasToken()) {
    services.cloudSync.configureToken(cloudToken);
  }
  if (!services.llm.configurationSnapshot().hasApiKey) {
    services.llm.saveConfiguration({
      baseUrl: "https://api.deepseek.com",
      modelName: "deepseek-flash",
      apiKey: modelApiKey,
      thinkingEnabled: true,
    });
  }
  services.deviceLocal.setString(seedMarker, "done");
}

// 仅开发/原生验收构建加载 WebDriver 前端桥；生产包由 Vite 剪除这一分支。
if (import.meta.env.DEV && isTauri()) {
  void import("@wdio/tauri-plugin");
}

const container = document.getElementById("root");
if (container === null) {
  throw new Error("找不到 #root 挂载点");
}

if (isTauri()) {
  container.textContent = "正在打开本地学习数据…";
  void import("./adapters/tauriSqliteBridge.ts")
    .then(async ({ openTauriBusinessDatabase, createTauriSecretCipher }) => ({
      db: await openTauriBusinessDatabase(), createTauriSecretCipher,
    }))
    .then(async ({ db, createTauriSecretCipher }) => {
      const [{ createTauriRuntime }, { SystemClock }, { CryptoUuidV4IdGenerator }, { createTauriOrganizer, tauriConnectivityProbe }, { createTauriCloudSync }] = await Promise.all([
        import("./adapters/tauriRuntime.ts"),
        import("@ebbinghaus/persistence/src/clock.ts"),
        import("@ebbinghaus/persistence/src/ids.ts"),
        import("./adapters/openAiCompatibleOrganizer.ts"),
        import("./adapters/tauriCloudSync.ts"),
      ]);
      const clock = new SystemClock();
      const idGenerator = new CryptoUuidV4IdGenerator();
      const cipher = createTauriSecretCipher(db);
      const runtime = createTauriRuntime(db, clock, idGenerator, cipher);
      let notifyAppChanged = (): void => {};
      let notifyingRemoteChange = false;
      const cloudSync = createTauriCloudSync(runtime, cipher, clock, () => {
        // 远端拉取后只刷新本地视图；不把这次刷新当作本机写入再次推送。
        notifyingRemoteChange = true;
        try { notifyAppChanged(); } finally { notifyingRemoteChange = false; }
      });
      const services = createAppServices({
        runtime, clock, idGenerator, deviceLocal: runtime.deviceLocalStore,
        llmOrganizerFactory: { build: createTauriOrganizer },
        llmConnectivityProbe: tauriConnectivityProbe,
        cloudSync,
      });
      notifyAppChanged = services.notifyChanged;
      // 页面用例已先提交 SQLite/outbox，再发变化通知；合并通知后主动同步，
      // 让桌面刚学完就打开手机时能取得最新数据，无需等待固定轮询。
      services.subscribeChanged(() => {
        if (!notifyingRemoteChange) cloudSync.requestSyncSoon();
      });
      seedAndroidTestConnections(services);
      // 本地服务和默认目录已初始化后再启动同步，避免远端内容拉取与首启写入竞态。
      cloudSync.start();
      createRoot(container).render(<StrictMode><App services={services} /></StrictMode>);
    })
    .catch((error: unknown) => {
      container.textContent = `本地数据库初始化失败：${error instanceof Error ? error.message : "未知错误"}`;
    });
} else {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

  // 浏览器验收种子钩子只暴露在浏览器模式，供 Playwright 对产品逻辑播种。
  (window as unknown as Record<string, unknown>)["__ebbinghaus"] = getRuntime();
}
