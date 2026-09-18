/**
 * 核心领域实体与构造不变量（移植 V1 domain/entities.py 中与基础设施无关的部分）。
 *
 * 实体用 readonly 接口 + 校验工厂表达不可变性：一旦构造成功，任何修改都通过
 * 展开产生新对象，历史状态永不被原地改写。持久化行形态的实体（TestSession/
 * TestAnswer/DailyPlan 等）属于应用层与持久层职责，不进入本包；此处只保留
 * 它们承载的领域规则（改判方向、会话进度不变量）为纯校验函数。
 *
 * 时间口径：所有绝对时间使用带时区偏移的 ISO8601 字符串（与协议
 * isoTimestampSchema 同语义——`Z` 或 `±hh:mm` 均可，语义是"可解析为绝对时刻"），
 * 学习日锚点使用 `YYYY-MM-DD` 标签。历史时间必须可跨时区无歧义回放。
 */

import {
  LearningMode,
  MasteryStatus,
  SpaceKind,
  TestJudgement,
  WordListStage,
  isMasteryStatus,
  type ShortTermPassCount,
} from "./enums.ts";
import { formatStructuredMeanings, type StructuredMeaning } from "./meanings.ts";

/** 带时区偏移的 ISO8601 绝对时间（协议 occurredAt/t0/t1/t2 的领域侧同语义形态）。 */
export type AbsoluteIsoTime = string;

/** ISO8601 且必须携带时区信息（Z 或数值偏移）；无偏移的本地时间禁止入库回放。 */
const ABSOLUTE_ISO_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** 拒绝无法形成稳定标识或业务内容的空白文本。 */
export function requireText(value: string, fieldName: string): string {
  if (value.trim().length === 0) {
    throw new Error(`${fieldName}不能为空`);
  }
  return value;
}

/** 历史时间必须包含 UTC 偏移且真实可解析，才能在时区变化后无歧义回放。 */
export function requireAbsoluteIso(value: string, fieldName: string): AbsoluteIsoTime {
  if (!ABSOLUTE_ISO_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${fieldName}必须是带时区的 ISO8601 绝对时间，收到：${value}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Space / Unit / List
// ---------------------------------------------------------------------------

/** 用户可管理的学习范围，同时保留三个默认词频板块的来源标识。 */
export interface Space {
  readonly id: string;
  /** 仅标识三个首次启动默认项；自定义 Space 为 null，调度层只依赖稳定 id。 */
  readonly kind: SpaceKind | null;
  readonly displayOrder: number;
  /** 名称在领域入口统一去除首尾空白，避免界面、唯一索引和比较口径不一致。 */
  readonly name: string | null;
  readonly archivedAt: AbsoluteIsoTime | null;
  readonly createdAt: AbsoluteIsoTime | null;
  readonly updatedAt: AbsoluteIsoTime | null;
  readonly learningMode: LearningMode;
}

/** 用户看到的名称；旧三参数构造自动沿用默认词频名称。 */
export function spaceDisplayName(space: Space): string {
  if (space.name !== null) {
    return space.name;
  }
  if (space.kind === null) {
    // 构造校验已阻止该分支，仅保留类型收窄兜底。
    throw new Error("Space 缺少显示名称");
  }
  return space.kind;
}

/** 归档只影响日常选择与任务生成，不删除任何历史数据。 */
export function isSpaceArchived(space: Space): boolean {
  return space.archivedAt !== null;
}

function optionalAbsoluteIso(
  value: AbsoluteIsoTime | null | undefined,
  fieldName: string,
): AbsoluteIsoTime | null {
  if (value === null || value === undefined) {
    return null;
  }
  return requireAbsoluteIso(value, fieldName);
}

/** 构造 Space 并执行与 V1 `Space.__post_init__` 一致的不变量校验。 */
export function createSpace(input: {
  id: string;
  kind: SpaceKind | null;
  displayOrder: number;
  name?: string | null;
  archivedAt?: AbsoluteIsoTime | null;
  createdAt?: AbsoluteIsoTime | null;
  updatedAt?: AbsoluteIsoTime | null;
  learningMode?: LearningMode;
}): Space {
  requireText(input.id, "Space 标识");
  // kind 是封闭值域：仅允许三个默认词频板块或 null（自定义 Space），
  // 运行时值域校验防止非法字符串绕过类型系统流入持久层。
  if (
    input.kind !== null &&
    input.kind !== SpaceKind.Required &&
    input.kind !== SpaceKind.Common &&
    input.kind !== SpaceKind.Occasional
  ) {
    throw new Error("Space 类型必须为默认词频板块或自定义 Space");
  }
  const learningMode = input.learningMode ?? LearningMode.Book;
  if (learningMode !== LearningMode.Book && learningMode !== LearningMode.Regular) {
    throw new Error("Space 学习模式必须为词书模式或常规模式");
  }
  if (input.displayOrder <= 0) {
    throw new Error("Space 显示顺序必须大于 0");
  }
  let name: string | null = null;
  if (input.name !== null && input.name !== undefined) {
    const normalized = input.name.trim();
    if (normalized.length === 0) {
      throw new Error("Space 名称不能为空");
    }
    name = normalized;
  }
  if (input.kind === null && name === null) {
    throw new Error("自定义 Space 必须提供名称");
  }
  return {
    id: input.id,
    kind: input.kind,
    displayOrder: input.displayOrder,
    name,
    archivedAt: optionalAbsoluteIso(input.archivedAt, "Space 归档时间"),
    createdAt: optionalAbsoluteIso(input.createdAt, "Space 创建时间"),
    updatedAt: optionalAbsoluteIso(input.updatedAt, "Space 更新时间"),
    learningMode,
  };
}

/** Space 下由纸质词书编号定位的 Unit。 */
export interface StudyUnit {
  readonly id: string;
  readonly spaceId: string;
  readonly number: number;
}

/** Unit 与 List 编号是纸质词书定位信息，零和负数都不是合法编号。 */
export function createStudyUnit(input: { id: string; spaceId: string; number: number }): StudyUnit {
  requireText(input.id, "Unit 标识");
  requireText(input.spaceId, "Space 标识");
  if (input.number <= 0) {
    throw new Error("Unit 编号必须大于 0");
  }
  return { id: input.id, spaceId: input.spaceId, number: input.number };
}

/** Unit 下用户所有可见学习操作的最小单位。 */
export interface WordList {
  readonly id: string;
  readonly unitId: string;
  readonly number: number;
  readonly firstPassedAt: AbsoluteIsoTime | null;
  readonly stage: WordListStage;
  readonly synchronizedAt: AbsoluteIsoTime | null;
  readonly longTermValidationAt: AbsoluteIsoTime | null;
  /** 进入长期验证意味着新增锁永久生效；后续长期验证结果不得解除该锁。 */
  readonly additionsLocked: boolean;
  readonly aggregateStatus: MasteryStatus;
}

/** 构造 List 并执行与 V1 `WordList.__post_init__` 一致的阶段不变量。 */
export function createWordList(input: {
  id: string;
  unitId: string;
  number: number;
  firstPassedAt?: AbsoluteIsoTime | null;
  stage?: WordListStage;
  synchronizedAt?: AbsoluteIsoTime | null;
  longTermValidationAt?: AbsoluteIsoTime | null;
  additionsLocked?: boolean;
  aggregateStatus?: MasteryStatus;
}): WordList {
  requireText(input.id, "List 标识");
  requireText(input.unitId, "Unit 标识");
  if (input.number <= 0) {
    throw new Error("List 编号必须大于 0");
  }
  const stage = input.stage ?? WordListStage.ShortTermSync;
  if (
    stage !== WordListStage.ShortTermSync &&
    stage !== WordListStage.LongTermValidation &&
    stage !== WordListStage.Mastered
  ) {
    throw new Error("List 阶段必须为短期同步、长期验证或已掌握");
  }
  const aggregateStatus = input.aggregateStatus ?? MasteryStatus.Unmastered;
  const additionsLocked = input.additionsLocked ?? false;
  // 用构造不变量阻止界面或仓储绕过"长期验证即永久锁新增"的规则。
  if (stage !== WordListStage.ShortTermSync && !additionsLocked) {
    throw new Error("List 进入长期验证后必须永久锁定新增 Word");
  }
  const synchronizedAt = optionalAbsoluteIso(input.synchronizedAt, "List 同步时间");
  if (stage === WordListStage.LongTermValidation && synchronizedAt === null) {
    throw new Error("长期验证阶段必须保存同步时间");
  }
  if (stage === WordListStage.Mastered && aggregateStatus !== MasteryStatus.Mastered) {
    throw new Error("已掌握 List 的聚合状态必须为已掌握");
  }
  return {
    id: input.id,
    unitId: input.unitId,
    number: input.number,
    firstPassedAt: optionalAbsoluteIso(input.firstPassedAt, "List 首过时间"),
    stage,
    synchronizedAt,
    longTermValidationAt: optionalAbsoluteIso(input.longTermValidationAt, "List 长期验证时间"),
    additionsLocked,
    aggregateStatus,
  };
}

// ---------------------------------------------------------------------------
// Word（词书模式与常规模式共用的学习条目）
// ---------------------------------------------------------------------------

/** 两种模式共用的学习条目；词书模式才关联 List 并使用短期状态。 */
export interface Word {
  readonly id: string;
  /** 词书模式必填；常规模式无 List，为 null。 */
  readonly listId: string | null;
  readonly originalSpelling: string;
  readonly normalizedKey: string;
  /** 兼容列表与历史版本使用的派生快照，不能与结构化义项分叉。 */
  readonly manualMeaning: string;
  readonly shortTermPassCount: ShortTermPassCount;
  readonly masteryStatus: MasteryStatus;
  readonly meanings: readonly StructuredMeaning[];
  readonly shortTermCycleStartedAt: AbsoluteIsoTime | null;
  readonly shortTermOneStartedAt: AbsoluteIsoTime | null;
  readonly waitingCheckStartedAt: AbsoluteIsoTime | null;
  readonly spaceId: string | null;
  /** 常规模式新条目的首次可测试学习日（录入学习日 + 1，规格 11.7）。 */
  readonly eligibleFromLearningDay: string | null;
}

/** 构造 Word 并执行与 V1 `Word.__post_init__` 一致的状态起点不变量。 */
export function createWord(input: {
  id: string;
  listId: string | null;
  originalSpelling: string;
  normalizedKey: string;
  manualMeaning?: string;
  shortTermPassCount: ShortTermPassCount;
  masteryStatus: MasteryStatus;
  meanings?: readonly StructuredMeaning[];
  shortTermCycleStartedAt?: AbsoluteIsoTime | null;
  shortTermOneStartedAt?: AbsoluteIsoTime | null;
  waitingCheckStartedAt?: AbsoluteIsoTime | null;
  spaceId?: string | null;
  eligibleFromLearningDay?: string | null;
}): Word {
  requireText(input.id, "Word 标识");
  requireText(input.originalSpelling, "Word 原始拼写");
  requireText(input.normalizedKey, "Word 规范键");
  if (input.listId !== null) {
    requireText(input.listId, "List 标识");
  }
  if (input.spaceId !== null && input.spaceId !== undefined) {
    requireText(input.spaceId, "Space 标识");
  }
  const meanings = input.meanings ?? [];
  const manualMeaning = input.manualMeaning ?? formatStructuredMeanings(meanings);
  if (manualMeaning.trim().length === 0 && meanings.length === 0) {
    throw new Error("Word 必须至少包含一条手录义项");
  }
  if (!isMasteryStatus(input.masteryStatus)) {
    throw new Error("掌握状态必须为未掌握或已掌握");
  }
  if (meanings.length > 0 && manualMeaning !== formatStructuredMeanings(meanings)) {
    // manualMeaning 是兼容列表和历史版本使用的派生快照，不能与规范子结构分叉。
    throw new Error("Word 手录义项快照必须与结构化义项一致");
  }
  const shortTermCycleStartedAt = optionalAbsoluteIso(
    input.shortTermCycleStartedAt,
    "T0",
  );
  const shortTermOneStartedAt = optionalAbsoluteIso(input.shortTermOneStartedAt, "T1");
  const waitingCheckStartedAt = optionalAbsoluteIso(input.waitingCheckStartedAt, "T2");
  // 词书模式的未掌握 Word 才参与 List 短期调度；常规模式由独立 FSRS 卡片维护状态。
  // 状态起点不变量：当前短期通过次数对应的周期起点必须真实存在，否则历史不可回放。
  if (input.listId !== null && input.masteryStatus === MasteryStatus.Unmastered) {
    if (input.shortTermPassCount === 0 && shortTermCycleStartedAt === null) {
      throw new Error("短期通过次数为 0 时必须保存 T0");
    }
    if (input.shortTermPassCount === 1 && shortTermOneStartedAt === null) {
      throw new Error("短期通过次数为 1 时必须保存 T1");
    }
    if (input.shortTermPassCount === 2 && waitingCheckStartedAt === null) {
      throw new Error("短期通过次数为 2 时必须保存 T2");
    }
  }
  return {
    id: input.id,
    listId: input.listId,
    originalSpelling: input.originalSpelling,
    normalizedKey: input.normalizedKey,
    manualMeaning,
    shortTermPassCount: input.shortTermPassCount,
    masteryStatus: input.masteryStatus,
    meanings,
    shortTermCycleStartedAt,
    shortTermOneStartedAt,
    waitingCheckStartedAt,
    spaceId: input.spaceId ?? null,
    eligibleFromLearningDay: input.eligibleFromLearningDay ?? null,
  };
}

// ---------------------------------------------------------------------------
// 测试改判方向与会话进度（原 TestAnswer / TestSession 实体承载的领域规则）
// ---------------------------------------------------------------------------

/**
 * 校验一次测试判断的改判方向与改判标记一致性。
 *
 * 规格只允许从"认识"单向改为"不认识"（答案揭示后的第二次操作），绝不允许反向
 * 修正；改判标记必须与初判和最终判断的相等关系一致。该规则原属 V1 TestAnswer
 * 构造校验，V2 中由应用层在确认最终判断时调用。
 */
export function validateJudgementRevision(input: {
  initialJudgement: TestJudgement;
  finalJudgement: TestJudgement;
  answerRevised: boolean;
}): void {
  if (
    input.initialJudgement === TestJudgement.NotRecognized &&
    input.finalJudgement === TestJudgement.Recognized
  ) {
    throw new Error("初判不认识不得改回认识");
  }
  const expectedRevised = input.initialJudgement !== input.finalJudgement;
  if (input.answerRevised !== expectedRevised) {
    throw new Error("测试改判标记必须与初判和最终判断一致");
  }
}

/**
 * 校验测试会话进度不变量：只有全部 Word 均已确认后才能等待纸质复习或完成。
 *
 * 该不变量可阻止界面跳过测试直接进入纸质复习阶段；原属 V1 TestSession 构造
 * 校验，V2 中由应用层在推进会话游标时调用。
 */
export function validateTestSessionProgress(input: {
  currentPosition: number;
  totalWords: number;
  status: "待纸质复习" | "已完成";
}): void {
  if (input.currentPosition !== input.totalWords) {
    throw new Error("测试会话未完成全部 Word 时不得进入纸质复习或完成状态");
  }
}
