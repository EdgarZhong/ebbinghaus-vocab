/**
 * TauriProductionAdapter（占位接口声明）。
 *
 * 生产装配形态（Phase 3/4 落地）：基于 Tauri plugin-sql 的 SQLite 底座实现与
 * NodeClientRuntime 相同的端口集合（见 nodeRuntime.ts 顶部注释），平台能力
 * （HTTP 经 plugin-http、密钥经 plugin-stronghold、时间经注入时钟）由 Tauri
 * 组合根注入。本轮（第一轮自主实现）不实现——保持端口合同的单一表达点，防止
 * 后续实现绕开 application 端口私接平台 API。
 */

import type { SyncGateway } from "../sync/httpGateway.ts";

/**
 * Tauri 环境的同步网关：经 plugin-http 发请求（浏览器 fetch 在 WebView 内受
 * CORS 限制，Tauri 需走原生 HTTP）。接口与 SyncGateway 完全一致。
 */
export type TauriHttpSyncGateway = SyncGateway;

/** Tauri 生产装配函数的签名约定（实现于 app/src-tauri 阶段）。 */
export interface TauriRuntimeFactory {
  create(): Promise<{
    /** 与 NodeClientRuntime 相同的端口集合（结构化类型，不重复声明）。 */
    ports: {
      eventStore: import("@ebbinghaus/application").LearningEventStore;
      wordContentStore: import("@ebbinghaus/application").WordContentStore;
      bookCatalogStore: import("@ebbinghaus/application").BookCatalogStore;
      spaceStore: import("@ebbinghaus/application").SpaceStore;
      testSessionStore: import("@ebbinghaus/application").TestSessionStore;
      fsrsCardStore: import("@ebbinghaus/application").FsrsCardStore;
      dailyPlanStore: import("@ebbinghaus/application").DailyPlanStore;
      syncedSettingsStore: import("@ebbinghaus/application").SyncedSettingsStore;
      deviceLocalStore: import("@ebbinghaus/application").DeviceLocalStore;
      llmConfigurationStore: import("@ebbinghaus/application").LlmConfigurationStore;
    };
    unitOfWork: import("@ebbinghaus/application").UnitOfWork;
    deviceIdentity: import("@ebbinghaus/application").DeviceIdentityProvider;
    deviceSeqAllocator: import("@ebbinghaus/application").DeviceSeqAllocator;
    syncEngine: import("../sync/syncEngine.ts").SyncEngine;
  }>;
}
