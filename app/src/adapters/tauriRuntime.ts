/**
 * Tauri 生产运行时：macOS 与 Android 复用 Node 侧经过集成测试的同步 SQLite 仓储实现，仅数据库
 * 连接由 Tauri 本机桥提供。页面与应用层用例完全不感知底层差异。
 */
import type Database from "better-sqlite3";
import type { Clock, IdGenerator } from "@ebbinghaus/application";
import { SqliteLearningEventStore } from "@ebbinghaus/persistence/src/repositories/events.ts";
import {
  SqliteBookCatalogStore, SqliteSpaceStore, SqliteWordContentStore,
} from "@ebbinghaus/persistence/src/repositories/content.ts";
import { SqliteFirstPassDraftStore } from "@ebbinghaus/persistence/src/repositories/drafts.ts";
import {
  SqliteDailyPlanStore, SqliteFsrsCardStore, SqliteTestSessionStore,
} from "@ebbinghaus/persistence/src/repositories/execution.ts";
import {
  SqliteDeviceLocalStore, SqliteLlmConfigurationStore, SqliteSyncedSettingsStore,
  type SecretCipher,
} from "@ebbinghaus/persistence/src/repositories/settings.ts";
import { SqliteContentSyncStore } from "@ebbinghaus/persistence/src/sync/contentStore.ts";
import { SqliteDictionaryCacheStore } from "@ebbinghaus/persistence/src/repositories/dictionary.ts";
import { createConcurrentOnlineDictionary } from "@ebbinghaus/persistence/src/dictionary/onlineDictionary.ts";
import { tauriDictionaryTransport } from "./tauriDictionaryTransport.ts";
import { SqlitePullCursorStore } from "@ebbinghaus/persistence/src/sync/syncState.ts";
import { SqliteDeviceIdentityProvider, SqliteDeviceSeqAllocator } from "@ebbinghaus/persistence/src/sqlite/device.ts";
import { SqliteUnitOfWork } from "@ebbinghaus/persistence/src/sqlite/unitOfWork.ts";
import { SqliteOutbox } from "@ebbinghaus/persistence/src/outbox/sqliteOutbox.ts";
import type { InMemoryRuntime } from "@ebbinghaus/persistence/src/adapters/inMemoryRuntime.ts";

/** 只在组合根调用。同步功能就绪后，syncEngine 将接入同一批端口。 */
export function createTauriRuntime(
  db: Database.Database, clock: Clock, idGenerator: IdGenerator, secretCipher: SecretCipher,
): InMemoryRuntime {
  const outbox = new SqliteOutbox(db, undefined, clock);
  const deviceIdentity = new SqliteDeviceIdentityProvider(db, idGenerator);
  const contentSyncStore = new SqliteContentSyncStore(db, clock, deviceIdentity);
  const runtime = {
    eventStore: new SqliteLearningEventStore(db, clock, outbox),
    wordContentStore: new SqliteWordContentStore(db, contentSyncStore),
    bookCatalogStore: new SqliteBookCatalogStore(db, contentSyncStore),
    spaceStore: new SqliteSpaceStore(db, contentSyncStore),
    firstPassDraftStore: new SqliteFirstPassDraftStore(db, contentSyncStore),
    testSessionStore: new SqliteTestSessionStore(db),
    fsrsCardStore: new SqliteFsrsCardStore(db),
    dailyPlanStore: new SqliteDailyPlanStore(db),
    syncedSettingsStore: new SqliteSyncedSettingsStore(db, outbox),
    deviceLocalStore: new SqliteDeviceLocalStore(db),
    llmConfigurationStore: new SqliteLlmConfigurationStore(db, secretCipher, clock),
    dictionaryCacheStore: new SqliteDictionaryCacheStore(db),
    onlineDictionary: createConcurrentOnlineDictionary(tauriDictionaryTransport),
    outbox,
    contentSyncStore,
    unitOfWork: new SqliteUnitOfWork(db),
    deviceIdentity,
    deviceSeqAllocator: new SqliteDeviceSeqAllocator(db),
    pullCursor: new SqlitePullCursorStore(db),
    syncEngine: null,
    deviceId: deviceIdentity.getDeviceId(),
  };
  // 两种运行时满足同一应用端口集合；当前 AppServices 的旧公开类型仍以
  // InMemoryRuntime 命名，待端口泛型清理后可移除此处窄范围类型转换。
  return runtime as unknown as InMemoryRuntime;
}
