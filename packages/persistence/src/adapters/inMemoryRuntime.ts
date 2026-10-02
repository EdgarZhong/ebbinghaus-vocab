/**
 * 内存客户端运行时（BrowserTestAdapter 的 V2 产品形态）。
 *
 * 定位（技术决策第九章"浏览器模式一等公民"）：React UI 在 Vite 浏览器模式下经
 * 本运行时获得 application 全部端口的内存实现——同一套业务逻辑、不同持久化底座。
 * 它**不是**测试专用第二套逻辑：集成测试与真实服务器联调同样使用它（网关注入
 * HTTP 实现），保证"内存底座行为"与"SQLite 底座行为"始终有冒烟对照。
 *
 * Tauri 生产环境（TauriProductionAdapter）将在 app/src-tauri 阶段基于同一端口
 * 集合接入 Tauri SQLite 插件；本文件与 nodeRuntime.ts 的端口集合就是其实现合同。
 */

import {
  contentEntrySchema, isContentEntryNewer, mergeSettings, storedContentEntrySchema,
  type ContentEntry, type ContentEntityType, type StoredContentEntry, type SettingEntry,
} from "@ebbinghaus/protocol";
import type {
  ApplicationEvent,
  BookCatalogStore,
  Clock,
  DailyPlanRecord,
  DailyPlanStore,
  DeviceIdentityProvider,
  DeviceLocalStore,
  DeviceSeqAllocator,
  FirstPassDraftRecord,
  FirstPassDraftStore,
  FsrsCardRecord,
  FsrsCardStore,
  IdGenerator,
  LearningEventStore,
  ListCatalogRecord,
  LlmConfigurationRecord,
  LlmConfigurationStore,
  DictionaryCacheStore,
  OnlineDictionaryPort,
  Space,
  SpaceStore,
  StudyUnit,
  SyncedSettingsStore,
  TestSessionRecord,
  TestSessionStore,
  UnitOfWork,
  WordContentRecord,
  WordContentStore,
} from "@ebbinghaus/application";
import { DuplicateEventError } from "../errors.ts";
import {
  computeBackoffDelayMs,
  type OutboxBackoffOptions,
  type OutboxEntry,
  type OutboxStore,
} from "../outbox/outboxStore.ts";
import { DEFAULT_OUTBOX_BACKOFF } from "../outbox/outboxStore.ts";
import { SyncEngine } from "../sync/syncEngine.ts";
import type { SyncGateway } from "../sync/httpGateway.ts";
import type { SecretCipher } from "../repositories/settings.ts";
import type { ContentSyncStore, PendingContentEntry } from "../sync/contentStore.ts";
import { InMemoryDictionaryCacheStore } from "../repositories/dictionary.ts";
import { createConcurrentOnlineDictionary, createFetchDictionaryTransport } from "../dictionary/onlineDictionary.ts";

// ---------------------------------------------------------------------------
// outbox（内存）
// ---------------------------------------------------------------------------

interface MemoryOutboxRow {
  entryId: number;
  entryType: OutboxEntry["entryType"];
  payloadJson: string;
  eventId: string | null;
  createdAt: string;
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
}

/** 内存 outbox：退避算法与 SQLite 实现共用同一来源（outboxStore.ts），行为一致。 */
export class InMemoryOutbox implements OutboxStore {
  private readonly rows = new Map<number, MemoryOutboxRow>();
  private nextId = 0;

  constructor(
    private readonly clock: Clock,
    private readonly backoff: OutboxBackoffOptions = DEFAULT_OUTBOX_BACKOFF,
  ) {}

  private enqueue(entryType: OutboxEntry["entryType"], payloadJson: string, eventId: string | null): void {
    this.nextId += 1;
    this.rows.set(this.nextId, {
      entryId: this.nextId,
      entryType,
      payloadJson,
      eventId,
      createdAt: this.clock.now().toISOString(),
      attempts: 0,
      nextAttemptAt: this.clock.now().toISOString(),
      lastError: null,
    });
  }

  enqueueEvent(event: ApplicationEvent): void {
    this.enqueue("event", JSON.stringify(event), event.eventId);
  }

  enqueueSettingsEntry(entry: SettingEntry): void {
    this.enqueue("settings", JSON.stringify(entry), null);
  }

  dueEntries(nowIso: string, limit: number): OutboxEntry[] {
    return [...this.rows.values()]
      .filter((row) => row.nextAttemptAt <= nowIso)
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }

  markSucceeded(entryId: number): void {
    this.rows.delete(entryId);
  }

  markFailed(entryId: number, message: string, nowIso: string): void {
    const row = this.rows.get(entryId);
    if (row === undefined) {
      return;
    }
    row.attempts += 1;
    row.lastError = message;
    const delayMs = computeBackoffDelayMs(row.attempts, this.backoff);
    row.nextAttemptAt = new Date(new Date(nowIso).getTime() + delayMs).toISOString();
  }

  pendingCount(): number {
    return this.rows.size;
  }

  listPending(): OutboxEntry[] {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }
}

// ---------------------------------------------------------------------------
// 事件与内容目录（内存）
// ---------------------------------------------------------------------------

export class InMemoryEventStore implements LearningEventStore {
  private readonly events = new Map<string, ApplicationEvent>();

  constructor(private readonly outbox?: OutboxStore) {}

  appendEvents(events: readonly ApplicationEvent[]): void {
    for (const event of events) {
      if (this.events.has(event.eventId)) {
        throw new DuplicateEventError(event.eventId);
      }
      this.events.set(event.eventId, event);
      this.outbox?.enqueueEvent(event);
    }
  }

  listAllEvents(): ApplicationEvent[] {
    return [...this.events.values()];
  }

  /** 拉取侧幂等落地：重复回声忽略，返回新入库数（与 SQLite 实现同语义）。 */
  applyPulledEvents(events: readonly ApplicationEvent[]): number {
    let inserted = 0;
    for (const event of events) {
      if (!this.events.has(event.eventId)) {
        this.events.set(event.eventId, event);
        inserted += 1;
      }
    }
    return inserted;
  }
}

export class InMemoryWordContentStore implements WordContentStore {
  private readonly entries = new Map<string, WordContentRecord>();

  constructor(private readonly contentSync?: ContentSyncStore) {}

  upsertEntries(entries: readonly WordContentRecord[]): void {
    for (const entry of entries) {
      this.entries.set(entry.wordId, { ...entry });
      this.contentSync?.recordLocal("word", entry.wordId, entry);
    }
  }

  getEntry(wordId: string): WordContentRecord | null {
    const entry = this.entries.get(wordId);
    return entry === undefined ? null : { ...entry };
  }

  listEntriesForSpace(spaceId: string): WordContentRecord[] {
    return [...this.entries.values()]
      .filter((entry) => entry.spaceId === spaceId && !entry.removed)
      .map((entry) => ({ ...entry }));
  }

  listEntriesForList(listId: string): WordContentRecord[] {
    return [...this.entries.values()]
      .filter((entry) => entry.listId === listId && !entry.removed)
      .map((entry) => ({ ...entry }));
  }

  markRemoved(wordId: string, _removedAt: string): void {
    // 内存底座无审计列可写；SQLite 实现记录 removed_at（口径见该实现注释）。
    const entry = this.entries.get(wordId);
    if (entry === undefined) {
      throw new Error(`词内容不存在：${wordId}`);
    }
    this.entries.set(wordId, { ...entry, removed: true });
    this.contentSync?.recordLocal("word", wordId, { ...entry, removed: true });
  }

  listCatalogEntries(): WordContentRecord[] {
    return [...this.entries.values()].map((entry) => ({ ...entry }));
  }

  hasEntriesForSpace(spaceId: string): boolean {
    return [...this.entries.values()].some((entry) => entry.spaceId === spaceId);
  }

  removeEntryForSync(wordId: string): void { this.entries.delete(wordId); }
}

/** 浏览器草稿仓储；仅供当前运行时恢复未提交输入，确认状态也只在本机保留。 */
export class InMemoryFirstPassDraftStore implements FirstPassDraftStore {
  private readonly drafts = new Map<string, FirstPassDraftRecord>();

  upsertDraft(draft: FirstPassDraftRecord): void {
    // 原文和模型候选都可能含未提交内容，不能借内容同步通道发往服务器。
    this.drafts.set(draft.id, { ...draft });
  }

  getDraft(id: string): FirstPassDraftRecord | null {
    const record = this.drafts.get(id);
    return record === undefined ? null : { ...record };
  }

  listOpenDrafts(spaceId: string): FirstPassDraftRecord[] {
    return [...this.drafts.values()]
      .filter((draft) => draft.spaceId === spaceId && draft.status !== "已确认")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
      .map((draft) => ({ ...draft }));
  }

  removeForSync(id: string): void { this.drafts.delete(id); }
}

export class InMemoryBookCatalogStore implements BookCatalogStore {
  private readonly units = new Map<string, StudyUnit>();
  private readonly lists = new Map<string, ListCatalogRecord>();

  constructor(private readonly contentSync?: ContentSyncStore) {}

  addUnit(unit: StudyUnit): void {
    this.units.set(unit.id, { ...unit });
    this.contentSync?.recordLocal("unit", unit.id, unit);
  }

  getUnit(unitId: string): StudyUnit | null {
    const unit = this.units.get(unitId);
    return unit === undefined ? null : { ...unit };
  }

  getUnitByNumber(spaceId: string, number: number): StudyUnit | null {
    for (const unit of this.units.values()) {
      if (unit.spaceId === spaceId && unit.number === number) {
        return { ...unit };
      }
    }
    return null;
  }

  addList(record: ListCatalogRecord): void {
    this.lists.set(record.listId, { ...record });
    this.contentSync?.recordLocal("list", record.listId, record);
  }

  getList(listId: string): ListCatalogRecord | null {
    const record = this.lists.get(listId);
    return record === undefined ? null : { ...record };
  }

  getListByNumber(unitId: string, number: number): ListCatalogRecord | null {
    for (const record of this.lists.values()) {
      if (record.unitId === unitId && record.listNumber === number) {
        return { ...record };
      }
    }
    return null;
  }

  listListsForSpace(spaceId: string): ListCatalogRecord[] {
    return [...this.lists.values()]
      .filter((record) => record.spaceId === spaceId)
      .map((record) => ({ ...record }));
  }

  hasListsForSpace(spaceId: string): boolean {
    return [...this.lists.values()].some((record) => record.spaceId === spaceId);
  }

  removeUnitForSync(unitId: string): void { this.units.delete(unitId); }
  removeListForSync(listId: string): void { this.lists.delete(listId); }
}

export class InMemorySpaceStore implements SpaceStore {
  private readonly spaces = new Map<string, Space>();

  constructor(private readonly contentSync?: ContentSyncStore) {}

  addSpace(space: Space): void {
    this.spaces.set(space.id, { ...space });
    this.contentSync?.recordLocal("space", space.id, space, space.createdAt ?? undefined);
  }

  updateSpace(space: Space): void {
    if (!this.spaces.has(space.id)) {
      throw new Error(`Space 不存在：${space.id}`);
    }
    this.spaces.set(space.id, { ...space });
    this.contentSync?.recordLocal("space", space.id, space);
  }

  deleteSpace(spaceId: string): void {
    this.spaces.delete(spaceId);
    this.contentSync?.recordLocal("space", spaceId, null);
  }

  listSpaces(): Space[] {
    return [...this.spaces.values()]
      .sort((a, b) => a.displayOrder - b.displayOrder)
      .map((space) => ({ ...space }));
  }

  getSpace(spaceId: string): Space | null {
    const space = this.spaces.get(spaceId);
    return space === undefined ? null : { ...space };
  }
}

/** 浏览器底座沿用与 SQLite 相同的内容版本顺序和退避规则。 */
export class InMemoryContentSyncStore implements ContentSyncStore {
  private readonly versions = new Map<string, ContentEntry>();
  private readonly pending = new Map<string, { payloadJson: string; attempts: number; nextAttemptAt: string; lastError: string | null }>();
  private cursor = 0;
  private suppressRecord = false;
  private stores: { space: InMemorySpaceStore; book: InMemoryBookCatalogStore; word: InMemoryWordContentStore } | null = null;

  constructor(
    private readonly clock: Clock,
    private readonly deviceIdentity: DeviceIdentityProvider,
    private readonly backoff: OutboxBackoffOptions = DEFAULT_OUTBOX_BACKOFF,
  ) {}

  attachStores(stores: { space: InMemorySpaceStore; book: InMemoryBookCatalogStore; word: InMemoryWordContentStore }): void {
    this.stores = stores;
  }

  private key(type: ContentEntityType, id: string): string { return `${type}\u0000${id}`; }

  recordLocal(entityType: ContentEntityType, entityId: string, value: unknown, initialVersionAt?: string): void {
    // 与 SQLite 底座保持同一隐私边界：旧协议类型仍可解析，但新草稿不能出站。
    if (entityType === "draft") return;
    if (this.suppressRecord) return;
    const key = this.key(entityType, entityId);
    const previous = this.versions.get(key);
    const initialMs = initialVersionAt === undefined ? this.clock.now().getTime() : Date.parse(initialVersionAt);
    const updatedAt = new Date(Math.max(initialMs, previous === undefined ? -Infinity : Date.parse(previous.updatedAt) + 1)).toISOString();
    const entry = contentEntrySchema.parse({
      entityType, entityId, value, deleted: value === null,
      updatedAt, deviceId: this.deviceIdentity.getDeviceId(),
    });
    const payloadJson = JSON.stringify(entry);
    this.versions.set(key, entry);
    this.pending.set(key, { payloadJson, attempts: 0, nextAttemptAt: this.clock.now().toISOString(), lastError: null });
  }

  readCursor(): number { return this.cursor; }
  writeCursor(cursor: number): void { this.cursor = cursor; }

  applyRemote(entries: readonly StoredContentEntry[]): number {
    if (this.stores === null) throw new Error("内容同步仓储尚未装配");
    let changed = 0;
    for (const stored of entries) {
      const { serverSeq: _serverSeq, ...entry } = storedContentEntrySchema.parse(stored);
      // 先按共享协议验证旧记录，再跳过整个草稿实体；远端更新与墓碑都不得
      // 改写当前设备尚未提交的表单。同步引擎仍按拉取响应推进内容游标。
      if (entry.entityType === "draft") continue;
      const key = this.key(entry.entityType, entry.entityId);
      const previous = this.versions.get(key);
      if (previous !== undefined && !isContentEntryNewer(entry, previous)) continue;
      this.suppressRecord = true;
      try {
        if (entry.deleted || entry.value === null) {
          if (entry.entityType === "space") this.stores.space.deleteSpace(entry.entityId);
          if (entry.entityType === "unit") this.stores.book.removeUnitForSync(entry.entityId);
          if (entry.entityType === "list") this.stores.book.removeListForSync(entry.entityId);
          if (entry.entityType === "word") this.stores.word.removeEntryForSync(entry.entityId);
        } else {
          switch (entry.entityType) {
            case "space":
              if (this.stores.space.getSpace(entry.entityId) === null) this.stores.space.addSpace(entry.value);
              else this.stores.space.updateSpace(entry.value);
              break;
            case "unit": this.stores.book.addUnit(entry.value); break;
            case "list": this.stores.book.addList(entry.value); break;
            case "word": this.stores.word.upsertEntries([entry.value as WordContentRecord]); break;
          }
        }
      } finally {
        this.suppressRecord = false;
      }
      this.versions.set(key, entry);
      this.pending.delete(key);
      changed += 1;
    }
    return changed;
  }

  dueEntries(nowIso: string, limit: number): PendingContentEntry[] {
    return [...this.pending.entries()]
      // 旧浏览器会话可能在升级前已排入草稿；只筛出站集合，保留本机正文。
      .filter(([key, row]) => !key.startsWith("draft\u0000") && row.nextAttemptAt <= nowIso)
      .slice(0, limit)
      .map(([, row]) => ({ entry: contentEntrySchema.parse(JSON.parse(row.payloadJson)), payloadJson: row.payloadJson }));
  }

  markSucceeded(item: PendingContentEntry): void {
    const key = this.key(item.entry.entityType, item.entry.entityId);
    if (this.pending.get(key)?.payloadJson === item.payloadJson) this.pending.delete(key);
  }

  markFailed(item: PendingContentEntry, message: string, nowIso: string): void {
    const row = this.pending.get(this.key(item.entry.entityType, item.entry.entityId));
    if (row === undefined || row.payloadJson !== item.payloadJson) return;
    row.attempts += 1;
    row.lastError = message;
    row.nextAttemptAt = new Date(Date.parse(nowIso) + computeBackoffDelayMs(row.attempts, this.backoff)).toISOString();
  }

  pendingCount(): number {
    return [...this.pending.keys()].filter((key) => !key.startsWith("draft\u0000")).length;
  }
}

// ---------------------------------------------------------------------------
// 执行状态与派生态（内存）
// ---------------------------------------------------------------------------

export class InMemoryTestSessionStore implements TestSessionStore {
  private readonly sessions = new Map<string, TestSessionRecord>();

  addSession(session: TestSessionRecord): void {
    if (this.sessions.has(session.sessionId)) {
      throw new Error(`测试会话已存在：${session.sessionId}`);
    }
    this.sessions.set(session.sessionId, { ...session });
  }

  updateSession(session: TestSessionRecord): void {
    if (!this.sessions.has(session.sessionId)) {
      throw new Error(`测试会话不存在：${session.sessionId}`);
    }
    this.sessions.set(session.sessionId, { ...session });
  }

  reorderSessionWords(session: TestSessionRecord): void {
    const existing = this.sessions.get(session.sessionId);
    if (existing === undefined) {
      throw new Error(`测试会话不存在：${session.sessionId}`);
    }
    this.sessions.set(session.sessionId, {
      ...existing,
      words: [...session.words],
      lastActiveAt: session.lastActiveAt,
    });
  }

  getSession(sessionId: string): TestSessionRecord | null {
    const session = this.sessions.get(sessionId);
    return session === undefined ? null : { ...session };
  }

  getOpenRegularSession(spaceId: string, learningDay: string): TestSessionRecord | null {
    for (const session of this.sessions.values()) {
      if (
        session.learningMode === "常规模式" &&
        session.spaceId === spaceId &&
        session.learningDay === learningDay &&
        (session.status === "进行中" || session.status === "已暂停")
      ) {
        return { ...session };
      }
    }
    return null;
  }

  getOpenListSession(listId: string): TestSessionRecord | null {
    for (const session of this.sessions.values()) {
      if (
        session.learningMode === "词书模式" &&
        session.listId === listId &&
        // 2026-10-02 起"等待纸质复习"状态随纸质复习概念整体删除：历史残留行视为
        // 已关闭（词书用例进入测试时会清理残留开放会话），不参与开放匹配。
        (session.status === "进行中" || session.status === "已暂停")
      ) {
        return { ...session };
      }
    }
    return null;
  }
}

export class InMemoryFsrsCardStore implements FsrsCardStore {
  private readonly cards = new Map<string, FsrsCardRecord>();

  upsert(record: FsrsCardRecord): void {
    this.cards.set(record.wordId, { ...record });
  }

  get(wordId: string): FsrsCardRecord | null {
    const card = this.cards.get(wordId);
    return card === undefined ? null : { ...card };
  }
}

export class InMemoryDailyPlanStore implements DailyPlanStore {
  private readonly plans = new Map<string, DailyPlanRecord>();

  private key(learningDay: string, spaceId: string): string {
    return `${spaceId}|${learningDay}`;
  }

  get(input: { readonly learningDay: string; readonly spaceId: string }): DailyPlanRecord | null {
    const plan = this.plans.get(this.key(input.learningDay, input.spaceId));
    return plan === undefined ? null : { ...plan };
  }

  upsert(plan: DailyPlanRecord): void {
    this.plans.set(this.key(plan.learningDay, plan.spaceId), { ...plan });
  }

  listRecent(input: {
    readonly spaceId: string;
    readonly beforeDay: string;
    readonly limit: number;
  }): DailyPlanRecord[] {
    return [...this.plans.values()]
      .filter((plan) => plan.spaceId === input.spaceId && plan.learningDay < input.beforeDay)
      .sort((a, b) => (a.learningDay < b.learningDay ? 1 : a.learningDay > b.learningDay ? -1 : 0))
      .slice(0, input.limit)
      .map((plan) => ({ ...plan }));
  }
}

// ---------------------------------------------------------------------------
// 设置通道（内存）
// ---------------------------------------------------------------------------

/** 内存同步 settings：save 与 SQLite 同语义（LWW 收敛 + outbox 入队），applyMerged 不入队。 */
export class InMemorySyncedSettingsStore implements SyncedSettingsStore {
  private readonly byKey = new Map<string, SettingEntry>();

  constructor(private readonly outbox: OutboxStore) {}

  private writeRows(entries: readonly SettingEntry[]): void {
    const merged = mergeSettings([...this.byKey.values()], entries);
    this.byKey.clear();
    for (const entry of merged) {
      this.byKey.set(entry.key, entry);
    }
  }

  getAll(): SettingEntry[] {
    return [...this.byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  save(entries: readonly SettingEntry[]): void {
    // 内存底座无事务概念；"写入 + 入队"按同序执行即可表达同生共死（无中间失败态）。
    this.writeRows(entries);
    for (const entry of entries) {
      this.outbox.enqueueSettingsEntry(entry);
    }
  }

  applyMerged(entries: readonly SettingEntry[]): void {
    this.writeRows(entries);
  }
}

export class InMemoryDeviceLocalStore implements DeviceLocalStore {
  private readonly values = new Map<string, string>();

  getString(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setString(key: string, value: string): void {
    this.values.set(key, value);
  }
}

/**
 * 内存 LLM 配置存储：密钥以密文字符串持有（经注入加密端口），load 时解密回明文。
 * null = 保留既有、空串 = 清空、非空 = 更新（ports.ts 合同，与 SQLite 实现同口径）。
 */
export class InMemoryLlmConfigurationStore implements LlmConfigurationStore {
  /** 密文形态持有：null 表示从未配置；空串表示已清空。 */
  private apiKeyCipher: string | null = null;
  private rest: Omit<LlmConfigurationRecord, "apiKey"> | null = null;

  constructor(private readonly cipher: SecretCipher) {}

  load(): LlmConfigurationRecord | null {
    if (this.rest === null) {
      return null;
    }
    return {
      ...this.rest,
      // 密钥三态：null=从未配置；空串=已清空；其余=解密回明文（与 SQLite 实现同口径）。
      apiKey:
        this.apiKeyCipher === null
          ? null
          : this.apiKeyCipher === ""
            ? ""
            : this.cipher.decrypt(this.apiKeyCipher),
    };
  }

  save(record: LlmConfigurationRecord): void {
    // 其他字段永远按本次输入更新；只有 apiKey 为 null 时才保留既有密文（V1 口径）。
    this.rest = {
      baseUrl: record.baseUrl,
      modelName: record.modelName,
      thinkingEnabled: record.thinkingEnabled,
    };
    if (record.apiKey === null) {
      // 保留既有密文原值（此前从未配置时保持 null）。
      return;
    }
    this.apiKeyCipher = record.apiKey === "" ? "" : this.cipher.encrypt(record.apiKey);
  }
}

// ---------------------------------------------------------------------------
// 设备身份（内存）
// ---------------------------------------------------------------------------

/**
 * 内存设备身份：deviceId 惰性生成并存入设备本地 KV（键 `deviceId`）——浏览器模式
 * 下换底层为 localStorage 即获得跨刷新稳定；内存运行时生命周期内稳定即可满足联调。
 */
export class InMemoryDeviceIdentity implements DeviceIdentityProvider {
  private static readonly KEY = "deviceId";

  constructor(
    private readonly deviceLocal: DeviceLocalStore,
    private readonly idGenerator: IdGenerator,
  ) {}

  getDeviceId(): string {
    const existing = this.deviceLocal.getString(InMemoryDeviceIdentity.KEY);
    if (existing !== null) {
      return existing;
    }
    const generated = this.idGenerator.nextId();
    this.deviceLocal.setString(InMemoryDeviceIdentity.KEY, generated);
    return generated;
  }
}

export class InMemoryDeviceSeqAllocator implements DeviceSeqAllocator {
  private last = 0;

  nextSeq(): number {
    this.last += 1;
    return this.last;
  }
}

/** 内存事务：直接执行回调（无中间失败态），计数供测试观测。 */
export class InMemoryUnitOfWork implements UnitOfWork {
  public runCount = 0;

  run(write: () => void): void {
    this.runCount += 1;
    write();
  }
}

// ---------------------------------------------------------------------------
// 运行时装配
// ---------------------------------------------------------------------------

/** 内存运行时（BrowserTestAdapter）的全部端口集合与同步能力。 */
export interface InMemoryRuntime {
  readonly eventStore: InMemoryEventStore;
  readonly wordContentStore: InMemoryWordContentStore;
  readonly firstPassDraftStore: InMemoryFirstPassDraftStore;
  readonly bookCatalogStore: InMemoryBookCatalogStore;
  readonly spaceStore: InMemorySpaceStore;
  readonly testSessionStore: InMemoryTestSessionStore;
  readonly fsrsCardStore: InMemoryFsrsCardStore;
  readonly dailyPlanStore: InMemoryDailyPlanStore;
  readonly syncedSettingsStore: InMemorySyncedSettingsStore;
  readonly deviceLocalStore: InMemoryDeviceLocalStore;
  readonly llmConfigurationStore: InMemoryLlmConfigurationStore;
  readonly dictionaryCacheStore: DictionaryCacheStore;
  readonly onlineDictionary: OnlineDictionaryPort;
  readonly outbox: InMemoryOutbox;
  readonly contentSyncStore: InMemoryContentSyncStore;
  readonly unitOfWork: InMemoryUnitOfWork;
  readonly deviceIdentity: InMemoryDeviceIdentity;
  readonly deviceSeqAllocator: InMemoryDeviceSeqAllocator;
  /** 网关注入时可用；未注入（纯离线演示）为 null。 */
  readonly syncEngine: SyncEngine | null;
  readonly deviceId: string;
}

export interface CreateInMemoryRuntimeOptions {
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  /** 密钥加密端口：开发/演示可传 TransparentSecretCipher（见 repositories/settings.ts）。 */
  readonly secretCipher: SecretCipher;
  /** 浏览器验收可注入确定性网络源，产品逻辑仍使用同一 DictionaryService。 */
  readonly onlineDictionary?: OnlineDictionaryPort;
  /** 注入后启用同步（HTTP 网关或测试假网关）；缺省纯离线。 */
  readonly gateway?: SyncGateway;
  readonly backoff?: OutboxBackoffOptions;
  readonly onEventsApplied?: (appliedCount: number) => void;
  readonly onContentApplied?: (appliedCount: number) => void;
}

export function createInMemoryRuntime(options: CreateInMemoryRuntimeOptions): InMemoryRuntime {
  const outbox = new InMemoryOutbox(options.clock, options.backoff);
  const syncedSettingsStore = new InMemorySyncedSettingsStore(outbox);
  const deviceLocalStore = new InMemoryDeviceLocalStore();
  const deviceIdentity = new InMemoryDeviceIdentity(deviceLocalStore, options.idGenerator);
  const eventStore = new InMemoryEventStore(outbox);
  const contentSyncStore = new InMemoryContentSyncStore(options.clock, deviceIdentity, options.backoff);
  const wordContentStore = new InMemoryWordContentStore(contentSyncStore);
  const firstPassDraftStore = new InMemoryFirstPassDraftStore();
  const bookCatalogStore = new InMemoryBookCatalogStore(contentSyncStore);
  const spaceStore = new InMemorySpaceStore(contentSyncStore);
  contentSyncStore.attachStores({ space: spaceStore, book: bookCatalogStore, word: wordContentStore });

  // 拉取游标：内存底座用闭包变量承载（同一 SyncEngine 只依赖 read/write 两个能力）。
  let pullCursorValue = 0;

  const deviceId = deviceIdentity.getDeviceId();

  const syncEngine =
    options.gateway === undefined
      ? null
      : new SyncEngine({
          gateway: options.gateway,
          eventStore,
          settingsStore: syncedSettingsStore,
          contentStore: contentSyncStore,
          outbox,
          clock: options.clock,
          pullCursor: {
            read: () => pullCursorValue,
            write: (value: number) => {
              pullCursorValue = value;
            },
          },
          onEventsApplied: options.onEventsApplied,
          onContentApplied: options.onContentApplied,
        });

  return {
    eventStore,
    wordContentStore,
    firstPassDraftStore,
    bookCatalogStore,
    spaceStore,
    testSessionStore: new InMemoryTestSessionStore(),
    fsrsCardStore: new InMemoryFsrsCardStore(),
    dailyPlanStore: new InMemoryDailyPlanStore(),
    syncedSettingsStore,
    deviceLocalStore,
    llmConfigurationStore: new InMemoryLlmConfigurationStore(options.secretCipher),
    dictionaryCacheStore: new InMemoryDictionaryCacheStore(),
    onlineDictionary: options.onlineDictionary ?? createConcurrentOnlineDictionary(createFetchDictionaryTransport()),
    outbox,
    contentSyncStore,
    unitOfWork: new InMemoryUnitOfWork(),
    deviceIdentity,
    deviceSeqAllocator: new InMemoryDeviceSeqAllocator(),
    syncEngine,
    deviceId,
  };
}
