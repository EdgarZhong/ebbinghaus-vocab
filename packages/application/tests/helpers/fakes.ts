/**
 * 应用层测试共享的内存假实现（全部端口）与确定性注入物。
 *
 * 编写原则（与任务约束一致）：
 * - 一切时间经 FixedClock（显式 setInstant 推进），禁止 Date.now；
 * - 一切标识经 SequentialIdGenerator（确定性 UUIDv4 形态，事件 eventId 与设置键
 *   spaceId 都要过协议 uuidV4Schema 校验，因此假实现必须产生合法 UUIDv4）；
 * - 一切写入落在内存 Map，绝不触达真实 IO；
 * - 带契约语义的假实现（LlmConfigurationStore 的 null=保留/空串=清空、
 *   SyncedSettingsStore 的 LWW 收敛、EventStore 的 eventId 去重）逐条注释所依据的
 *   ports.ts 合同原文，保证测试验证的是端口契约而非假实现自嗨。
 */

import { mergeSettings, type SettingEntry } from "@ebbinghaus/protocol";
import type {
  ApplicationEvent,
  BookCatalogStore,
  Clock,
  DailyPlanRecord,
  DailyPlanStore,
  DeviceIdentityProvider,
  DeviceLocalStore,
  DeviceSeqAllocator,
  FsrsCardRecord,
  FsrsCardStore,
  IdGenerator,
  LearningEventStore,
  ListCatalogRecord,
  LlmConfigurationRecord,
  LlmConfigurationStore,
  Space,
  SpaceStore,
  StudyUnit,
  SyncedSettingsStore,
  TestSessionRecord,
  TestSessionStore,
  UnitOfWork,
  WordContentRecord,
  WordContentStore,
} from "../../src/ports.ts";

// ---------------------------------------------------------------------------
// 身份、序号与时钟
// ---------------------------------------------------------------------------

/** 把整数计数器格式化为合法 UUIDv4（版本位 4、变体位 8，过协议 uuidV4Schema）。 */
function uuidFromCounter(counter: number): string {
  const hex = counter.toString(16).padStart(32, "0").slice(-32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** 确定性 ID 生成器：同计数序列必然得到同标识序列，断言可精确到具体值。 */
export class SequentialIdGenerator implements IdGenerator {
  private counter = 0;

  nextId(): string {
    this.counter += 1;
    return uuidFromCounter(this.counter);
  }
}

/** 固定设备身份：事件 deviceId 与设置条目 deviceId 全部来自它。 */
export class StaticDeviceIdentity implements DeviceIdentityProvider {
  constructor(private readonly deviceId = "b7e2f3a4-1c5d-4e8f-9a0b-2c3d4e5f6a7b") {}

  getDeviceId(): string {
    return this.deviceId;
  }
}

/** 确定性设备序号：从 1 起严格单调（ports.ts DeviceSeqAllocator 合同）。 */
export class SequentialDeviceSeqAllocator implements DeviceSeqAllocator {
  private last = 0;

  nextSeq(): number {
    this.last += 1;
    return this.last;
  }
}

/** 可编程固定时钟：测试用 setInstant 显式推进"现在"，绝不读取系统时间。 */
export class FixedClock implements Clock {
  private instant: Date;

  constructor(iso: string) {
    this.instant = new Date(iso);
  }

  now(): Date {
    // 返回副本，防止调用方原地改写测试锚点。
    return new Date(this.instant.getTime());
  }

  setInstant(iso: string): void {
    this.instant = new Date(iso);
  }
}

// ---------------------------------------------------------------------------
// 事件与内容存储
// ---------------------------------------------------------------------------

/** 内存事件存储：按 ports.ts 合同实现 append-only 与 eventId 重复拒绝。 */
export class InMemoryEventStore implements LearningEventStore {
  private readonly events = new Map<string, ApplicationEvent>();
  /** appendEvents 调用次数：作为"多笔事件是否同批（同一事务语义）写入"的观测探针。 */
  public appendCallCount = 0;

  appendEvents(events: readonly ApplicationEvent[]): void {
    this.appendCallCount += 1;
    for (const event of events) {
      if (this.events.has(event.eventId)) {
        // 合同原文：eventId 重复追加必须抛错（本地写入口径下重复属于编程错误）。
        throw new Error(`事件 ${event.eventId} 已存在，禁止重复追加`);
      }
      this.events.set(event.eventId, event);
    }
  }

  listAllEvents(): ApplicationEvent[] {
    return [...this.events.values()];
  }
}

/** 内存词内容目录：upsert 整体替换；软移除只置标记，绝不物理删除。 */
export class InMemoryWordContentStore implements WordContentStore {
  private readonly entries = new Map<string, WordContentRecord>();

  upsertEntries(entries: readonly WordContentRecord[]): void {
    for (const entry of entries) {
      this.entries.set(entry.wordId, entry);
    }
  }

  getEntry(wordId: string): WordContentRecord | null {
    return this.entries.get(wordId) ?? null;
  }

  listEntriesForSpace(spaceId: string): WordContentRecord[] {
    return [...this.entries.values()].filter((entry) => entry.spaceId === spaceId && !entry.removed);
  }

  listEntriesForList(listId: string): WordContentRecord[] {
    return [...this.entries.values()].filter((entry) => entry.listId === listId && !entry.removed);
  }

  markRemoved(wordId: string, _removedAt: string): void {
    const entry = this.entries.get(wordId);
    if (entry === undefined) {
      throw new Error(`词内容不存在：${wordId}`);
    }
    // 合同原文：markRemoved 只置标记，绝不物理删除；removedAt 仅作审计时间，
    // WordContentRecord 无对应字段，假实现不改动既有 recordedAt。
    this.entries.set(wordId, { ...entry, removed: true });
  }

  listCatalogEntries(): WordContentRecord[] {
    return [...this.entries.values()];
  }

  hasEntriesForSpace(spaceId: string): boolean {
    // 含已移除条目：只要登记过就视为有学习数据（"空 Space 才可删除"判定）。
    return [...this.entries.values()].some((entry) => entry.spaceId === spaceId);
  }
}

/** 内存词书目录：Unit/List 定位事实。 */
export class InMemoryBookCatalogStore implements BookCatalogStore {
  private readonly units = new Map<string, StudyUnit>();
  private readonly lists = new Map<string, ListCatalogRecord>();

  addUnit(unit: StudyUnit): void {
    this.units.set(unit.id, unit);
  }

  getUnit(unitId: string): StudyUnit | null {
    return this.units.get(unitId) ?? null;
  }

  getUnitByNumber(spaceId: string, number: number): StudyUnit | null {
    return [...this.units.values()].find((unit) => unit.spaceId === spaceId && unit.number === number) ?? null;
  }

  addList(record: ListCatalogRecord): void {
    this.lists.set(record.listId, record);
  }

  getList(listId: string): ListCatalogRecord | null {
    return this.lists.get(listId) ?? null;
  }

  getListByNumber(unitId: string, number: number): ListCatalogRecord | null {
    return [...this.lists.values()].find((record) => record.unitId === unitId && record.listNumber === number) ?? null;
  }

  listListsForSpace(spaceId: string): ListCatalogRecord[] {
    return [...this.lists.values()].filter((record) => record.spaceId === spaceId);
  }

  hasListsForSpace(spaceId: string): boolean {
    return [...this.lists.values()].some((record) => record.spaceId === spaceId);
  }
}

/** 内存 Space 元数据存储：listSpaces 按 displayOrder 升序稳定返回（端口合同）。 */
export class InMemorySpaceStore implements SpaceStore {
  private readonly spaces = new Map<string, Space>();

  addSpace(space: Space): void {
    this.spaces.set(space.id, space);
  }

  updateSpace(space: Space): void {
    if (!this.spaces.has(space.id)) {
      throw new Error(`Space 不存在：${space.id}`);
    }
    this.spaces.set(space.id, space);
  }

  deleteSpace(spaceId: string): void {
    this.spaces.delete(spaceId);
  }

  listSpaces(): Space[] {
    return [...this.spaces.values()].sort((a, b) => a.displayOrder - b.displayOrder);
  }

  getSpace(spaceId: string): Space | null {
    return this.spaces.get(spaceId) ?? null;
  }
}

// ---------------------------------------------------------------------------
// 执行状态与 FSRS 卡片（设备本地）
// ---------------------------------------------------------------------------

/** 内存测试会话存储（设备本地执行状态）。 */
export class InMemoryTestSessionStore implements TestSessionStore {
  private readonly sessions = new Map<string, TestSessionRecord>();

  addSession(session: TestSessionRecord): void {
    if (this.sessions.has(session.sessionId)) {
      throw new Error(`测试会话已存在：${session.sessionId}`);
    }
    this.sessions.set(session.sessionId, session);
  }

  updateSession(session: TestSessionRecord): void {
    if (!this.sessions.has(session.sessionId)) {
      throw new Error(`测试会话不存在：${session.sessionId}`);
    }
    this.sessions.set(session.sessionId, session);
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
    return this.sessions.get(sessionId) ?? null;
  }

  getOpenRegularSession(spaceId: string, learningDay: string): TestSessionRecord | null {
    return (
      [...this.sessions.values()].find(
        (session) =>
          session.learningMode === "常规模式" &&
          session.spaceId === spaceId &&
          session.learningDay === learningDay &&
          (session.status === "进行中" || session.status === "已暂停"),
      ) ?? null
    );
  }

  getOpenListSession(listId: string): TestSessionRecord | null {
    return (
      [...this.sessions.values()].find(
        (session) =>
          session.learningMode === "词书模式" &&
          session.listId === listId &&
          // 2026-10-02 起不存在"等待纸质复习"状态：开放会话只剩进行中/已暂停，
          // 最后一词确认后会话即完成。
          (session.status === "进行中" || session.status === "已暂停"),
      ) ?? null
    );
  }
}

/** 内存 FSRS 卡片存储：每词最多一行，upsert 整体覆盖。 */
export class InMemoryFsrsCardStore implements FsrsCardStore {
  private readonly cards = new Map<string, FsrsCardRecord>();

  upsert(record: FsrsCardRecord): void {
    this.cards.set(record.wordId, record);
  }

  get(wordId: string): FsrsCardRecord | null {
    return this.cards.get(wordId) ?? null;
  }
}

// ---------------------------------------------------------------------------
// 设置通道
// ---------------------------------------------------------------------------

/**
 * 内存同步设置存储。
 *
 * save 按 ports.ts 合同以协议 `mergeSettings`（isSettingEntryNewer LWW 全序）收敛，
 * 使测试能直接验证"写入条目参与 LWW 决胜"的语义，而不是另造一套合并规则。
 */
export class InMemorySyncedSettingsStore implements SyncedSettingsStore {
  private entries: SettingEntry[] = [];

  getAll(): SettingEntry[] {
    return [...this.entries];
  }

  save(incoming: readonly SettingEntry[]): void {
    this.entries = mergeSettings(this.entries, incoming);
  }
}

/** 内存设备本地 KV：单设备单写者，直接覆盖。 */
export class InMemoryDeviceLocalStore implements DeviceLocalStore {
  private readonly values = new Map<string, string>();

  getString(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setString(key: string, value: string): void {
    this.values.set(key, value);
  }
}

// ---------------------------------------------------------------------------
// LLM 配置（设备本地）
// ---------------------------------------------------------------------------

/**
 * 内存 LLM 配置存储，实现 ports.ts `LlmConfigurationRecord.apiKey` 的写入合同：
 * null = 保留既有密钥；空字符串 = 清空密钥；非空 = 更新密钥。
 * （M5 的 SQLite 实现必须遵守同一合同；此处按合同实现使服务用例可测。）
 */
export class InMemoryLlmConfigurationStore implements LlmConfigurationStore {
  private record: LlmConfigurationRecord | null = null;

  load(): LlmConfigurationRecord | null {
    return this.record === null ? null : { ...this.record };
  }

  save(incoming: LlmConfigurationRecord): void {
    const previousApiKey = this.record?.apiKey ?? null;
    let apiKey: string | null;
    if (incoming.apiKey === null) {
      apiKey = previousApiKey;
    } else if (incoming.apiKey === "") {
      apiKey = "";
    } else {
      apiKey = incoming.apiKey;
    }
    this.record = { ...incoming, apiKey };
  }
}

// ---------------------------------------------------------------------------
// 每日计划与事务
// ---------------------------------------------------------------------------

/** 内存每日计划存储：同 (learningDay, spaceId) 一行，upsert 覆盖。 */
export class InMemoryDailyPlanStore implements DailyPlanStore {
  private readonly plans = new Map<string, DailyPlanRecord>();
  /** upsert 调用次数：作为"是否重新模拟并落盘"的观测探针。 */
  public upsertCount = 0;

  get(input: { readonly learningDay: string; readonly spaceId: string }): DailyPlanRecord | null {
    return this.plans.get(`${input.spaceId}|${input.learningDay}`) ?? null;
  }

  upsert(plan: DailyPlanRecord): void {
    this.upsertCount += 1;
    this.plans.set(`${plan.spaceId}|${plan.learningDay}`, plan);
  }

  listRecent(input: {
    readonly spaceId: string;
    readonly beforeDay: string;
    readonly limit: number;
  }): DailyPlanRecord[] {
    return [...this.plans.values()]
      .filter((plan) => plan.spaceId === input.spaceId && plan.learningDay < input.beforeDay)
      .sort((a, b) => (a.learningDay < b.learningDay ? 1 : a.learningDay > b.learningDay ? -1 : 0))
      .slice(0, input.limit);
  }
}

/** 计数事务假实现：同步执行回调并记录次数，验证"多笔写入在同一事务内"。 */
export class RecordingUnitOfWork implements UnitOfWork {
  public runCount = 0;

  run(write: () => void): void {
    this.runCount += 1;
    write();
  }
}
