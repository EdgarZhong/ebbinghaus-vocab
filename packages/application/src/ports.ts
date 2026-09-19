/**
 * 应用用例依赖的外部能力端口（移植 V1 application/ports.py 并按 V2 事件溯源架构重设计）。
 *
 * 本文件是后续持久化/同步阶段（M5）的实现合同：每个端口的方法语义、原子性与失败
 * 行为都必须按注释落实。应用层只依赖本文件定义的接口，绝不 import 任何具体基础设施
 * （SQLite、HTTP、Tauri、文件系统）；实现由组合根注入，测试用内存假实现。
 *
 * 与 V1 的关键差异（V2 架构铁律所致）：
 * - V1 的 `LearningRepository` 直接读写可变状态行（Word/PlannedTask/TestSession…）；
 *   V2 的权威数据是**不可变学习事件** + 由各终端确定性重放的派生状态（AGENTS.md
 *   "数据与同步"），因此仓储拆分为：事件存储（append-only）、词内容目录、词书目录、
 *   设备本地执行状态（测试会话）、FSRS 卡片本地存储、每日计划存储。
 * - 时间一律经 `Clock`（domain 导出）；ID 生成经 `IdGenerator` 端口（禁止 crypto 直接
 *   调用）；设备内事件序号经 `DeviceSeqAllocator` 端口（进程重启后必须延续）。
 * - 活动 Space 是设备本地状态（判断文件 A1 第 5 项），走 `DeviceLocalStore`，不产生
 *   同步事件、不进入 settings 同步通道。
 */

import type { LearningEventType } from "@ebbinghaus/protocol";
import type {
  EntryOrganizationResult,
  Space,
  StructuredMeaning,
  StudyUnit,
} from "@ebbinghaus/domain";

export type { /** 可注入时钟：应用层一切"现在"的唯一来源（再导出自领域层）。 */ Clock } from "@ebbinghaus/domain";
// Space 与 StudyUnit 是端口方法签名的一部分（SpaceStore/BookCatalogStore），再导出
// 供消费方（测试假实现、UI 层）统一从应用层取类型，避免直接绕到 domain。
export type { Space, StudyUnit } from "@ebbinghaus/domain";

// ---------------------------------------------------------------------------
// 应用层事件视图：protocol schema 输出的结构化最小形态。
// ---------------------------------------------------------------------------

/**
 * 应用层产生、存储与重放的学习事件。
 *
 * 运行时保证：所有事件在产生处经 `learningEventSchema` 校验（见 eventRecorder.ts），
 * 校验失败立即抛错。协议导出的 `LearningEvent` TS 类型因 Zod 工厂泛型退化带索引签名，
 * 应用层用本结构收窄编译期信息；字段集合与协议 strictObject 信封完全一致，结构上
 * 可直接赋给 domain 重放器的 `ReplayableLearningEvent`。
 */
export interface ApplicationEvent {
  readonly eventId: string;
  readonly eventType: LearningEventType;
  readonly targetType: string;
  readonly targetId: string;
  /** 事件真实发生时刻（UTC ISO8601；由可注入 Clock 生成）。 */
  readonly occurredAt: string;
  /** 事件发生时按用户时区与换日边界计算的学习日标签（YYYY-MM-DD）。 */
  readonly learningDay: string;
  readonly source: string;
  readonly deviceId: string;
  readonly deviceSeq: number;
  readonly metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 身份与序号
// ---------------------------------------------------------------------------

/** ID 生成端口：所有实体标识（事件、条目、会话、Space…）必须经它生成。 */
export interface IdGenerator {
  /**
   * 返回一个全新唯一标识。实现必须产生 UUIDv4 形态（事件 eventId 与 settings
   * deviceId 都要过协议 uuidV4Schema 校验），且进程内绝不重复。
   */
  nextId(): string;
}

/** 设备身份端口：返回本设备首次启动时生成并持久化的 UUIDv4 设备标识。 */
export interface DeviceIdentityProvider {
  getDeviceId(): string;
}

/**
 * 设备内事件序号分配器。
 *
 * 语义（协议 events.ts deviceSeq 注释）：从 1 起严格单调递增；**进程重启后必须
 * 延续**（持久化已分配的最大值），否则同设备重启后会产生重复 deviceSeq，破坏
 * 领域重放排序 `occurredAt → deviceSeq → deviceId/eventId` 的确定性。分配本身
 * 不要求跨进程原子——单设备单进程写入。
 */
export interface DeviceSeqAllocator {
  nextSeq(): number;
}

// ---------------------------------------------------------------------------
// 事件存储（append-only）与同步出站
// ---------------------------------------------------------------------------

/**
 * 不可变学习事件存储端口。
 *
 * M5 实现语义要求：
 * - **原子性**：`appendEvents` 的整批事件与 outbox 入队必须在同一个 SQLite 事务内
 *   完成（AGENTS.md：先写本地不可变事件，再入 outbox 异步同步；两者要么同成要么
 *   同败，绝不允许"事件已写而 outbox 丢失"造成静默不同步）。
 * - **append-only**：禁止更新或删除已持久化事件；`eventId` 重复追加必须抛错
 *   （本地写入口径下重复属于编程错误；同步侧的服务器去重与本地无关）。
 * - 事件载荷（metadata）必须原样保留未知字段，禁止归一化改写。
 */
export interface LearningEventStore {
  /** 在单个事务内追加一批事件（同一用例的连带事件必须一批写入）。 */
  appendEvents(events: readonly ApplicationEvent[]): void;
  /** 返回本机全部事件（顺序不限；重放前由协议排序函数统一排序）。 */
  listAllEvents(): ApplicationEvent[];
}

// ---------------------------------------------------------------------------
// 内容目录（词身份与词书结构；本地内容表，非事件流）
// ---------------------------------------------------------------------------

/**
 * 词/条目内容记录（重放器 wordCatalog 的完整内容形态）。
 *
 * 词身份（拼写、规范键、归属）属于本地内容表：事件只承载学习事实，重放时由调用方
 * 提供内容登记（见 domain/replayer.ts 模块头）。手录释义与在线释义分字段、分来源
 * 保存；在线结果永不覆盖手录内容（AGENTS.md）。
 */
export interface WordContentRecord {
  readonly wordId: string;
  /** 词书模式词所属 List；常规模式条目为 null。 */
  readonly listId: string | null;
  /** 常规模式条目所属 Space；词书模式可为 null（由 List 层级间接归属）。 */
  readonly spaceId: string | null;
  readonly originalSpelling: string;
  readonly normalizedKey: string;
  /** 结构化义项派生的稳定义项文本（与 meanings 强一致，构造时校验）。 */
  readonly manualMeaning: string;
  readonly meanings: readonly StructuredMeaning[];
  /** 软移除标记：移除后立即从查询隐藏，历史与审计保留。 */
  readonly removed: boolean;
  /** 录入（或最近内容更新）时刻，UTC ISO8601。 */
  readonly recordedAt: string;
}

/**
 * 词内容目录端口（本地内容表）。
 *
 * M5 实现语义要求：软移除 `markRemoved` 只置标记，绝不物理删除行；同 Space 内
 * `normalizedKey` 的唯一性由用例层检测（冲突必须交给用户决定），存储层可加部分
 * 唯一索引兜底（仅对未移除行）。
 */
export interface WordContentStore {
  /** 插入或整体替换词内容（内容更新语义：保持同一 wordId 与学习历史）。 */
  upsertEntries(entries: readonly WordContentRecord[]): void;
  getEntry(wordId: string): WordContentRecord | null;
  /** 某 Space 下全部未移除条目（常规模式查询入口）。 */
  listEntriesForSpace(spaceId: string): WordContentRecord[];
  /** 某 List 下全部未移除词（词书模式查询入口）。 */
  listEntriesForList(listId: string): WordContentRecord[];
  /** 软移除：仅置标记；removedAt 仅作审计时间。 */
  markRemoved(wordId: string, removedAt: string): void;
  /** 全量内容登记（含已移除词），供重放器 wordCatalog 使用。 */
  listCatalogEntries(): WordContentRecord[];
  /** 判断该 Space 是否登记过任何条目（含已移除，用于"空 Space 才可删除"判定）。 */
  hasEntriesForSpace(spaceId: string): boolean;
}

/** 词书 Unit/List 的目录记录（纸质词书定位信息；阶段等学习状态由事件重放派生）。 */
export interface ListCatalogRecord {
  readonly listId: string;
  readonly spaceId: string;
  readonly unitId: string;
  readonly unitNumber: number;
  readonly listNumber: number;
}

/**
 * 词书目录端口（Unit/List 结构，本地内容表）。
 *
 * M5 实现语义要求：List 的阶段（短期同步/长期验证/已掌握）、同步时间与新增锁
 * **不在此存储**——它们是 `listSynchronized`/`listMastered` 事件的派生状态；
 * 目录只承载"这个 List 属于哪个 Unit/Space、编号多少"的定位事实。
 */
export interface BookCatalogStore {
  addUnit(unit: StudyUnit): void;
  getUnit(unitId: string): StudyUnit | null;
  getUnitByNumber(spaceId: string, number: number): StudyUnit | null;
  addList(record: ListCatalogRecord): void;
  getList(listId: string): ListCatalogRecord | null;
  getListByNumber(unitId: string, number: number): ListCatalogRecord | null;
  listListsForSpace(spaceId: string): ListCatalogRecord[];
  /** 判断该 Space 是否建过任何 List（用于"空 Space 才可删除"判定）。 */
  hasListsForSpace(spaceId: string): boolean;
}

// ---------------------------------------------------------------------------
// Space 元数据
// ---------------------------------------------------------------------------

/**
 * Space 元数据端口。
 *
 * Space 的创建/重命名/归档不是学习事件（协议 7.2 十八类中没有 Space 事件），是
 * 内容元数据；V2 第一阶段由本地与云端内容表承载（同步策略随 Phase 3 定稿）。
 * `listSpaces` 必须按 `displayOrder` 升序稳定返回。
 */
export interface SpaceStore {
  addSpace(space: Space): void;
  updateSpace(space: Space): void;
  deleteSpace(spaceId: string): void;
  listSpaces(): Space[];
  getSpace(spaceId: string): Space | null;
}

// ---------------------------------------------------------------------------
// 测试会话（设备本地执行状态，不参与同步与重放）
// ---------------------------------------------------------------------------

/**
 * 会话执行状态（本地值域）。
 *
 * 会话是"正在执行一次测试"的本地过程状态：协议只有 testSessionPaused/Resumed
 * 两个审计事件，会话本身的进度、快照与完成状态不同步、不重放——各终端各自的
 * 会话互不相干（AGENTS.md：派生状态不同步）。
 */
export const TestSessionExecutionStatus = {
  InProgress: "进行中",
  Paused: "已暂停",
  WaitingForPaperReview: "等待纸质复习",
  Completed: "已完成",
} as const;
export type TestSessionExecutionStatus =
  (typeof TestSessionExecutionStatus)[keyof typeof TestSessionExecutionStatus];

/** 会话内一个待测条目的计划快照（开始会话时定格，之后状态变化不影响本会话）。 */
export interface SessionWordPlan {
  readonly wordId: string;
  /** 计划测试时刻（UTC ISO8601，通常为会话开始时刻）。 */
  readonly plannedTestAt: string;
}

/** 测试会话记录（词书模式与常规模式共用形态，按字段区分）。 */
export interface TestSessionRecord {
  readonly sessionId: string;
  readonly learningMode: "词书模式" | "常规模式";
  /** 常规模式：所属 Space；词书模式为 null。 */
  readonly spaceId: string | null;
  /** 词书模式：所属 List；常规模式为 null。 */
  readonly listId: string | null;
  /** 会话所属学习日。 */
  readonly learningDay: string;
  /** 常规模式当日测试组序号；词书模式为 null。 */
  readonly groupOrdinal: number | null;
  /** 词书模式绑定的计划任务标识（任务由调度派生，绑定关系保存在会话里）。 */
  readonly taskId: string | null;
  /** 会话开始时的条目顺序快照（之后新增/移除不影响进行中的会话）。 */
  readonly words: readonly SessionWordPlan[];
  readonly currentPosition: number;
  readonly status: TestSessionExecutionStatus;
  /** 已确认过结果的条目（同一会话内禁止对同一条目重复确认）。 */
  readonly answeredWordIds: readonly string[];
  readonly startedAt: string;
  readonly lastActiveAt: string;
}

/**
 * 测试会话存储端口（设备本地）。
 *
 * M5 实现语义要求：会话与事件不同事务——会话进度允许在极端崩溃时回退到上次
 * 确认点（事件是权威事实，会话只是执行游标）；`getOpenRegularSession` 返回该
 * Space 当日唯一未完成会话（进行中或已暂停）。
 */
export interface TestSessionStore {
  addSession(session: TestSessionRecord): void;
  updateSession(session: TestSessionRecord): void;
  getSession(sessionId: string): TestSessionRecord | null;
  getOpenRegularSession(spaceId: string, learningDay: string): TestSessionRecord | null;
  getOpenListSession(listId: string): TestSessionRecord | null;
}

// ---------------------------------------------------------------------------
// FSRS 卡片本地存储（常规模式）
// ---------------------------------------------------------------------------

/**
 * 常规模式 FSRS 卡片记录（与 V1 upsert_fsrs_card 字段一一对应）。
 *
 * 边界说明：卡片到期时间与掌握状态可从事件重放派生（testAnswered afterState），
 * 但 FSRS 的精确内部参数（稳定性/难度）不在事件 metadata 中——重放只能得到事件
 * 实际承载的到期时间。精确卡片快照属于**设备本地派生态**：不参与同步，换设备
 * 后按事件重放的到期时间继续调度（重放器模块头已如实记录该协议边界）。
 */
export interface FsrsCardRecord {
  readonly wordId: string;
  readonly cardJson: string;
  /** 卡片当前到期时间（UTC ISO8601）。 */
  readonly dueAt: string;
  readonly schedulerJson: string;
  readonly algorithmVersion: string;
  readonly libraryVersion: string;
  readonly updatedAt: string;
  /** ts-fsrs 卡片状态名（Learning/Review/Relearning/New）。 */
  readonly cardState: string;
  /** 累计认识次数（不认识不清零）。 */
  readonly cumulativeRecognizedCount: number;
  /** 最近一次最终判断；从未测试为 null。 */
  readonly lastFinalJudgement: string | null;
}

/** FSRS 卡片本地存储端口：每词最多一行，upsert 整体覆盖。 */
export interface FsrsCardStore {
  upsert(record: FsrsCardRecord): void;
  get(wordId: string): FsrsCardRecord | null;
}

// ---------------------------------------------------------------------------
// 设置通道：同步 KV + 设备本地 KV（判断文件 A1/B2）
// ---------------------------------------------------------------------------

/**
 * 同步设置存储端口（settings KV 通道的本地视图）。
 *
 * M5 实现语义要求：
 * - `save` 把条目写入本地收敛视图，并把推送入队与写入放在**同一事务**（B2：settings
 *   变更走 outbox 异步推送、失败退避重试，但不进入事件流、不参与领域重放）；
 * - `getAll` 返回本地已收敛的全量条目（含每键 updatedAt/deviceId），供启动对账与
 *   服务器全量 LWW 合并；
 * - 冲突决胜只依赖协议 `isSettingEntryNewer`（LWW：updatedAt → deviceId → value 序列），
 *   实现不得自建合并规则。
 */
export interface SyncedSettingsStore {
  getAll(): import("@ebbinghaus/protocol").SettingEntry[];
  save(entries: readonly import("@ebbinghaus/protocol").SettingEntry[]): void;
}

/**
 * 设备本地 KV 存储端口。
 *
 * 只承载"本设备自己的状态"：活动 Space（A1 第 5 项）、未来的 UI 主题与窗口状态
 * （A5 预留）。不同步、不参与 LWW、无冲突语义（单设备单写者）。值统一为字符串，
 * 结构化数据由调用方自行 JSON 序列化。
 */
export interface DeviceLocalStore {
  getString(key: string): string | null;
  setString(key: string, value: string): void;
}

// ---------------------------------------------------------------------------
// 大语言模型服务配置（设备本地，判断文件 A1 第 11–14 项）与整理能力
// ---------------------------------------------------------------------------

/** LLM 服务配置记录（设备本地；加密存储由实现负责，应用层只持有明文或 null）。 */
export interface LlmConfigurationRecord {
  readonly baseUrl: string;
  readonly modelName: string;
  /**
   * 解密后的 API Key；null 表示尚未配置。
   * 写入语义（V1 ports.py save_llm_configuration 口径）：null = 保留既有密钥，
   * 空字符串 = 清空密钥，非空 = 更新密钥。
   */
  readonly apiKey: string | null;
  readonly thinkingEnabled: boolean;
}

/**
 * LLM 服务配置存储端口（设备本地）。
 *
 * M5 实现语义要求：`apiKey` 必须密文落库、明文不外泄（继承规格 6.9）；`save`
 * 收到 `apiKey: null` 时必须保留既有密钥原值（不得误存 null 覆盖）。
 */
export interface LlmConfigurationStore {
  /** 读取完整配置（含解密后密钥）；无记录返回 null。 */
  load(): LlmConfigurationRecord | null;
  save(record: LlmConfigurationRecord): void;
}

/**
 * 大语言模型整理器端口：把本次原始转写整理为候选结构，不负责最终入库。
 * 实现（HTTP 适配器）由基础设施层提供；失败语义见 errors.ts 的统一错误类型。
 */
export interface LanguageModelOrganizerPort {
  organize(rawText: string): EntryOrganizationResult;
}

/** 整理器构造端口：组合根在配置事务提交后用它构建新的活动整理器。 */
export interface LlmOrganizerFactory {
  build(configuration: {
    readonly baseUrl: string;
    readonly modelName: string;
    readonly apiKey: string | null;
    readonly thinkingEnabled: boolean;
  }): LanguageModelOrganizerPort;
}

/**
 * LLM 连通性探测端口。
 *
 * 实现执行一次纯网络请求并自行把失败翻译为用户可读错误抛出；应用层只负责在
 * 调用线程读取配置、把三字段值交给探测闭包（V1 prepare_llm_connection_test 语义）。
 */
export interface LlmConnectivityProbe {
  probe(baseUrl: string, modelName: string, apiKey: string | null): void;
}

// ---------------------------------------------------------------------------
// 在线词典（可失败的补充依赖）
// ---------------------------------------------------------------------------

/** 在线词典查询载荷（提供方相关结构，原样交给缓存层保存，不做语义解读）。 */
export type DictionaryLookupPayload = Record<string, unknown>;

/**
 * 在线词典端口：可失败的补充依赖；返回数据不得覆盖手录义项。
 * 失败语义用统一错误类型表达（见 errors.ts 的 DictionaryLookupError 家族）。
 */
export interface OnlineDictionaryPort {
  lookup(
    normalizedWord: string,
    options?: { readonly isCancelled?: () => boolean },
  ): DictionaryLookupPayload;
}

// ---------------------------------------------------------------------------
// 每日计划（容量预测结果的持久化形态）
// ---------------------------------------------------------------------------

/** 看板与容量模型共用的当日到期任务快照（写入 DailyPlan 的 dueSnapshot）。 */
export interface DueTaskSnapshot {
  readonly taskId: string;
  readonly listId: string;
  readonly taskType: string;
  readonly learningDay: string;
  readonly workload: number;
  readonly dueReason: string;
  readonly status: string;
}

/** DailyPlan 的到期侧快照。 */
export interface DueSnapshot {
  readonly dueWorkload: number;
  readonly overdueWorkload: number;
  readonly tasks: readonly DueTaskSnapshot[];
  readonly candidateActiveWordCount: number;
}

/** 容量候选指标（JSON 安全形态；无限清空时间已转为 null）。 */
export interface CapacityCandidatePayload {
  readonly newListCount: number;
  readonly expectedWorkloadByDay: readonly number[];
  readonly riskQuantileWorkloadByDay: readonly number[];
  readonly overloadProbability: number;
  readonly expectedMaxBacklog: number;
  readonly riskQuantileMaxBacklog: number;
  readonly expectedClearanceDays: number | null;
}

/** DailyPlan 的风险指标侧快照（含输入指纹，供跨进程缓存命中）。 */
export interface RiskMetrics {
  readonly recentActualDailyWorkload: number | null;
  readonly recentActualSampleCount: number;
  readonly historyWindowDays: number;
  readonly riskCapacity: number;
  readonly riskQuantile: number;
  readonly reserveWorkload: number;
  readonly sampleCount: number;
  readonly randomSeed: number;
  readonly inputFingerprint: string;
  readonly selectedCandidate: CapacityCandidatePayload;
  readonly candidates: readonly CapacityCandidatePayload[];
}

/** 一次容量预测的持久化计划记录（对应 V1 DailyPlan 行）。 */
export interface DailyPlanRecord {
  readonly learningDay: string;
  readonly spaceId: string;
  readonly targetCapacity: number;
  readonly dueSnapshot: DueSnapshot;
  readonly suggestedFirstPassCount: number;
  readonly actualFirstPassCount: number;
  readonly actualCompletedWorkload: number;
  readonly predictionWindowDays: number;
  readonly riskMetrics: RiskMetrics;
  readonly algorithmVersion: string;
}

/**
 * 每日计划存储端口。
 *
 * M5 实现语义要求：同 (learningDay, spaceId) 只保留一行，upsert 整体覆盖
 * （V1 口径：当天版本随输入变化重写）；`listRecent` 返回 beforeDay 之前（不含）
 * 最近 limit 天的记录，用于"最近实际日均完成量"。
 */
export interface DailyPlanStore {
  get(input: { readonly learningDay: string; readonly spaceId: string }): DailyPlanRecord | null;
  upsert(plan: DailyPlanRecord): void;
  listRecent(input: {
    readonly spaceId: string;
    readonly beforeDay: string;
    readonly limit: number;
  }): DailyPlanRecord[];
}

// ---------------------------------------------------------------------------
// 事务边界
// ---------------------------------------------------------------------------

/**
 * 用例事务端口：把一次用例的多笔写入绑定为单个原子事务。
 *
 * M5 实现语义要求：映射到 SQLite `BEGIN … COMMIT`；回调抛错时回滚并原样传播，
 * 绝不吞错。应用层所有"多笔写入必须同生共死"的用例（事件 + 内容 + 卡片）都经
 * 它包裹；内存假实现直接同步执行回调即可。
 */
export interface UnitOfWork {
  run(write: () => void): void;
}
