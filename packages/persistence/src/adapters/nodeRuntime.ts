/**
 * Node 客户端运行时（better-sqlite3 底座的完整装配）。
 *
 * 用途：
 * - M5/M6 集成测试与双端 localhost 联调（两个实例对接同一本地服务器）；
 * - 未来桌面壳（Tauri 侧进程外场景）与脚本工具复用同一套仓储。
 *
 * 与 createInMemoryRuntime（adapters/inMemoryRuntime.ts）共用同一 SyncEngine 与
 * SyncGateway——不同底座只有存储实现不同，同步语义零分叉。
 */

import type {
  Clock,
  IdGenerator,
  UnitOfWork,
  DeviceIdentityProvider,
  DeviceSeqAllocator,
} from "@ebbinghaus/application";

import { openClientDatabase } from "../sqlite/connection.ts";
import { SqliteDeviceIdentityProvider, SqliteDeviceSeqAllocator } from "../sqlite/device.ts";
import { SqliteUnitOfWork } from "../sqlite/unitOfWork.ts";
import { SystemClock } from "../clock.ts";
import { CryptoUuidV4IdGenerator } from "../ids.ts";
import { SqliteOutbox } from "../outbox/sqliteOutbox.ts";
import { DEFAULT_OUTBOX_BACKOFF, type OutboxBackoffOptions } from "../outbox/outboxStore.ts";
import { SqliteLearningEventStore } from "../repositories/events.ts";
import {
  SqliteBookCatalogStore,
  SqliteSpaceStore,
  SqliteWordContentStore,
} from "../repositories/content.ts";
import {
  SqliteDailyPlanStore,
  SqliteFsrsCardStore,
  SqliteTestSessionStore,
} from "../repositories/execution.ts";
import {
  SqliteDeviceLocalStore,
  SqliteLlmConfigurationStore,
  SqliteSyncedSettingsStore,
  type SecretCipher,
  TransparentSecretCipher,
} from "../repositories/settings.ts";
import { SqlitePullCursorStore } from "../sync/syncState.ts";
import { buildHttpSyncGateway } from "../sync/httpGateway.ts";
import { SyncEngine } from "../sync/syncEngine.ts";

/** Node 运行时端口集合（与 TauriProductionAdapter 的实现合同一致）。 */
export interface NodeClientRuntime {
  readonly db: ReturnType<typeof openClientDatabase>;
  readonly eventStore: SqliteLearningEventStore;
  readonly wordContentStore: SqliteWordContentStore;
  readonly bookCatalogStore: SqliteBookCatalogStore;
  readonly spaceStore: SqliteSpaceStore;
  readonly testSessionStore: SqliteTestSessionStore;
  readonly fsrsCardStore: SqliteFsrsCardStore;
  readonly dailyPlanStore: SqliteDailyPlanStore;
  readonly syncedSettingsStore: SqliteSyncedSettingsStore;
  readonly deviceLocalStore: SqliteDeviceLocalStore;
  readonly llmConfigurationStore: SqliteLlmConfigurationStore;
  readonly outbox: SqliteOutbox;
  readonly unitOfWork: UnitOfWork;
  readonly deviceIdentity: DeviceIdentityProvider;
  readonly deviceSeqAllocator: DeviceSeqAllocator;
  readonly pullCursor: SqlitePullCursorStore;
  readonly syncEngine: SyncEngine | null;
  /** 显式关闭底库（WAL checkpoint 后释放文件句柄；测试间隔离用）。 */
  close(): void;
}

export interface CreateNodeClientRuntimeOptions {
  /** SQLite 文件路径或 ":memory:"。 */
  readonly dbPath: string;
  /** 注入时钟：缺省 SystemClock（真实时间）；测试注入固定时钟。 */
  readonly clock?: Clock;
  readonly idGenerator?: IdGenerator;
  /** 密钥加密端口：缺省明文透传（开发/测试），生产必须注入真实实现（见 SecretCipher）。 */
  readonly secretCipher?: SecretCipher;
  /** 服务器接入：Base URL + Bearer token；缺省构造纯离线运行时（syncEngine 为 null）。 */
  readonly server?: { readonly baseUrl: string; readonly authToken: string };
  readonly backoff?: OutboxBackoffOptions;
  readonly onEventsApplied?: (appliedCount: number) => void;
}

export function createNodeClientRuntime(
  options: CreateNodeClientRuntimeOptions,
): NodeClientRuntime {
  const db = openClientDatabase(options.dbPath);
  const clock = options.clock ?? new SystemClock();
  const idGenerator = options.idGenerator ?? new CryptoUuidV4IdGenerator();
  const secretCipher = options.secretCipher ?? new TransparentSecretCipher();
  const backoff = options.backoff ?? DEFAULT_OUTBOX_BACKOFF;

  const outbox = new SqliteOutbox(db, backoff, clock);
  const eventStore = new SqliteLearningEventStore(db, clock);
  const syncedSettingsStore = new SqliteSyncedSettingsStore(db, outbox);
  const pullCursor = new SqlitePullCursorStore(db);

  const syncEngine =
    options.server === undefined
      ? null
      : new SyncEngine({
          gateway: buildHttpSyncGateway({
            baseUrl: options.server.baseUrl,
            authToken: options.server.authToken,
          }),
          eventStore,
          settingsStore: syncedSettingsStore,
          outbox,
          clock,
          pullCursor,
          onEventsApplied: options.onEventsApplied,
        });

  return {
    db,
    eventStore,
    wordContentStore: new SqliteWordContentStore(db),
    bookCatalogStore: new SqliteBookCatalogStore(db),
    spaceStore: new SqliteSpaceStore(db),
    testSessionStore: new SqliteTestSessionStore(db),
    fsrsCardStore: new SqliteFsrsCardStore(db),
    dailyPlanStore: new SqliteDailyPlanStore(db),
    syncedSettingsStore,
    deviceLocalStore: new SqliteDeviceLocalStore(db),
    llmConfigurationStore: new SqliteLlmConfigurationStore(db, secretCipher, clock),
    outbox,
    unitOfWork: new SqliteUnitOfWork(db),
    deviceIdentity: new SqliteDeviceIdentityProvider(db, idGenerator),
    deviceSeqAllocator: new SqliteDeviceSeqAllocator(db),
    pullCursor,
    syncEngine,
    close: () => {
      db.close();
    },
  };
}
