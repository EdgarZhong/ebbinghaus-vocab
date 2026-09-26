/** 浏览器与 Tauri 的启动入口；桌面端经本机桥使用正式 SQLite 工作库。 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import { App } from "./App.tsx";
import { createAppServices, getRuntime } from "./composition.ts";
import "./theme/index.css";

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
      const cloudSync = createTauriCloudSync(runtime, cipher, clock, () => notifyAppChanged());
      const services = createAppServices({
        runtime, clock, idGenerator, deviceLocal: runtime.deviceLocalStore,
        llmOrganizerFactory: { build: createTauriOrganizer },
        llmConnectivityProbe: tauriConnectivityProbe,
        cloudSync,
      });
      notifyAppChanged = services.notifyChanged;
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
