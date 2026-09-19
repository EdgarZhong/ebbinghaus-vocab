/**
 * @ebbinghaus/persistence 统一出口。
 *
 * 分层边界（AGENTS.md）：本包是基础设施层——只做存储与传输，禁止实现任何业务
 * 规则（FSRS/调度/容量/词书/首过语义不得出现）；业务能力只经 @ebbinghaus/domain
 * 与 @ebbinghaus/application 表达，本包为其端口提供实现。
 *
 * 模块导航：
 * - sqlite/connection.ts：客户端工作库打开与 schema 迁移（WAL、幂等建表、append-only 触发器）；
 * - repositories/：application/ports.ts 全部存储端口的 SQLite 实现；
 * - outbox/：出站队列契约（SQLite + 内存共用）、指数退避；
 * - sync/：HTTP 网关（gzip + 统一错误翻译）、同步引擎（拉取游标/outbox 消费/settings 收敛）、拉取游标；
 * - adapters/：Node 运行时（SQLite 底座）、内存运行时（BrowserTestAdapter）、Tauri 适配器占位合同。
 */

export { openClientDatabase, CLIENT_MIGRATIONS } from "./sqlite/connection.ts";
export { SqliteUnitOfWork } from "./sqlite/unitOfWork.ts";
export { SqliteDeviceIdentityProvider, SqliteDeviceSeqAllocator } from "./sqlite/device.ts";
export { SystemClock } from "./clock.ts";
export { CryptoUuidV4IdGenerator, assertUuidV4Shape } from "./ids.ts";
export {
  DuplicateEventError,
  SyncError,
  SyncNetworkError,
  SyncHttpError,
} from "./errors.ts";

export {
  computeBackoffDelayMs,
  DEFAULT_OUTBOX_BACKOFF,
  type OutboxBackoffOptions,
  type OutboxEntry,
  type OutboxEntryType,
  type OutboxStore,
} from "./outbox/outboxStore.ts";
export { SqliteOutbox } from "./outbox/sqliteOutbox.ts";

export { SqliteLearningEventStore } from "./repositories/events.ts";
export {
  SqliteBookCatalogStore,
  SqliteSpaceStore,
  SqliteWordContentStore,
} from "./repositories/content.ts";
export {
  SqliteDailyPlanStore,
  SqliteFsrsCardStore,
  SqliteTestSessionStore,
} from "./repositories/execution.ts";
export {
  SqliteDeviceLocalStore,
  SqliteLlmConfigurationStore,
  SqliteSyncedSettingsStore,
  TransparentSecretCipher,
  type SecretCipher,
} from "./repositories/settings.ts";

export { buildHttpSyncGateway, type SyncGateway } from "./sync/httpGateway.ts";
export { SyncEngine, type SyncCycleResult, type SyncEngineDeps } from "./sync/syncEngine.ts";
export { SqlitePullCursorStore } from "./sync/syncState.ts";

export {
  createInMemoryRuntime,
  InMemoryBookCatalogStore,
  InMemoryDailyPlanStore,
  InMemoryDeviceLocalStore,
  InMemoryDeviceSeqAllocator,
  InMemoryEventStore,
  InMemoryFsrsCardStore,
  InMemoryLlmConfigurationStore,
  InMemoryOutbox,
  InMemorySpaceStore,
  InMemorySyncedSettingsStore,
  InMemoryTestSessionStore,
  InMemoryUnitOfWork,
  InMemoryWordContentStore,
  type CreateInMemoryRuntimeOptions,
  type InMemoryRuntime,
} from "./adapters/inMemoryRuntime.ts";
export {
  createNodeClientRuntime,
  type CreateNodeClientRuntimeOptions,
  type NodeClientRuntime,
} from "./adapters/nodeRuntime.ts";
export type { TauriHttpSyncGateway, TauriRuntimeFactory } from "./adapters/tauriProductionAdapter.ts";
