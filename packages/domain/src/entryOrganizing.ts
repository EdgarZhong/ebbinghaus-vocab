/**
 * 两种录入模式共用的证据化大语言模型整理契约（移植 V1 domain/entry_organizing.py）。
 *
 * 本模块只负责纯本地结构校验和原文证据定位，不发起网络请求，也不保存任何数据。
 * 自由文本本身没有固定格式，因此调用整理器前不得用这里的规则阻止用户提交原始转写。
 *
 * 2026-09-10 校验机制整改后的核心口径（详见 docs/需求规格.md 6.2「本地校验与规范化口径」）：
 * - 证据定位不维护"每处原文只能被引用一次"的消耗游标：同一原文片段允许同时作为
 *   多个字段的证据，重复出现本身合法，高亮区间允许重叠；上下文只用于在多个出现
 *   位置中优先选择更合理的高亮位置，不再作为报错依据。
 * - "格式规范化"与"实质内容订正"分开：证据始终要求精确匹配原文字符；判断是否必须
 *   携带订正 warning 时，先对 value 与证据应用字段对应的有限规范化规则（大小写与
 *   连续空白折叠、中文标点的半角全角等价、词性别名规范化）再比较。
 * - 校验错误按词条汇总并分类，首个错误不中断其余词条的检查；父结构已经损坏的词条
 *   不再制造派生错误。
 */

import { PartOfSpeech, createStructuredMeaning, normalizePartOfSpeech, type StructuredMeaning } from "./meanings.ts";

export const ENTRY_ORGANIZER_SCHEMA_VERSION = "entry-organizer-v3";

/** 正式词性值域集合（PartOfSpeech 对象的值为全部合法词性，键只是标识符）。 */
const PART_OF_SPEECH_VALUES: ReadonlySet<string> = new Set(Object.values(PartOfSpeech));

/** 判断任意值是否是正式词性（值域校验基于值而非对象键）。 */
function isPartOfSpeechValue(value: unknown): value is PartOfSpeech {
  return typeof value === "string" && PART_OF_SPEECH_VALUES.has(value);
}

/** 合法英文词条形态：字母开头，允许撇号、连字符与短语空格（fullmatch 语义）。 */
const ENGLISH_TERM_PATTERN = /^[A-Za-z][A-Za-z'’-]*(?:\s+[A-Za-z][A-Za-z'’-]*)*$/;
/** 中文释义可以混合括号与英文说明，但至少必须包含一个中文字符。 */
const CHINESE_DEFINITION_PATTERN = /[\u3400-\u9fff]/;

/**
 * 中文释义比较时的标点等价表。规则必须有限、明确、逐条列举：只把语音转写中最常见
 * 的半角/全角形态差异视为等价（如原文「组成,构成」整理为「组成，构成」），不得扩展
 * 成"忽略所有标点"这类会掩盖实质内容变化的模糊匹配。
 */
const DEFINITION_PUNCTUATION_EQUIVALENTS: Readonly<Record<string, string>> = {
  ",": "，",
  ";": "；",
};

/** 统一条目显示空白，保留用户确认的大小写、连字符和撇号形态。 */
export function normalizeEntryTerm(value: string): string {
  return value.trim().split(/\s+/).join(" ");
}

/** 生成两种模式共用的查询与去重键。 */
export function normalizeEntryKey(value: string): string {
  return normalizeEntryTerm(value).replace(/’/g, "'").toLowerCase();
}

/** 判断整理后或用户确认后的值是否为合法英文单词或短语。 */
export function isValidEnglishEntryTerm(value: string): boolean {
  return ENGLISH_TERM_PATTERN.test(normalizeEntryTerm(value));
}

/** 中文义项可以混合括号与英文说明，但至少必须包含一个中文字符。 */
export function containsChineseDefinition(value: string): boolean {
  return CHINESE_DEFINITION_PATTERN.test(value);
}

/** 本地校验错误的稳定分类码；修复提示与日志按它区分原因，不靠可变文案匹配。 */
export const OrganizingIssueCategory = {
  /** 引用文本在原文中不存在：模型声明的 source_excerpt 无法在原始转写中定位。 */
  EvidenceNotFound: "evidence_not_found",
  /** 唯一出现位置明确落在其他词条原文区域内：典型是跨词条、跨义项引用。 */
  EvidenceContextMismatch: "evidence_context_mismatch",
  /** 实质订正缺少同节点说明：订正本身合规，缺的是说明，不是订正。 */
  CorrectionWithoutWarning: "correction_without_warning",
  /** 必要内容或结构缺失：必填字段缺失、值为空、类型不符、词性无法识别等。 */
  MissingRequired: "missing_required",
} as const;
export type OrganizingIssueCategory =
  (typeof OrganizingIssueCategory)[keyof typeof OrganizingIssueCategory];

const ISSUE_CATEGORY_LABELS: Readonly<Record<OrganizingIssueCategory, string>> = {
  [OrganizingIssueCategory.EvidenceNotFound]: "引用文本在原文中不存在",
  [OrganizingIssueCategory.EvidenceContextMismatch]: "引用与当前字段的上下文明显不对应",
  [OrganizingIssueCategory.CorrectionWithoutWarning]: "实质订正缺少同节点说明",
  [OrganizingIssueCategory.MissingRequired]: "必要内容或结构缺失",
};

/** 一条可定位到节点的校验问题；entryIndex 用于按词条分组局部修复。 */
export interface EntryOrganizingIssue {
  readonly category: OrganizingIssueCategory;
  readonly path: string;
  readonly expectation: string;
  readonly entryIndex: number | null;
}

/** 不带方括号的路径别名：部分调用方把路径直接传给正则匹配而没有转义 `[0]`。 */
export function issueRegexCompatiblePath(issue: EntryOrganizingIssue): string {
  return issue.path.replace(/\[/g, "").replace(/\]/g, "");
}

/** 错误分类的稳定中文名称，供修复提示与日志直接引用。 */
export function issueCategoryLabel(issue: EntryOrganizingIssue): string {
  return ISSUE_CATEGORY_LABELS[issue.category];
}

/** 面向修复提示与日志的单行描述；不回显原始输入或模型 payload 全文。 */
export function renderIssue(issue: EntryOrganizingIssue): string {
  return `${issueRegexCompatiblePath(issue)}（${issue.path}）: ${issueCategoryLabel(issue)}；期望${issue.expectation}`;
}

/** 按词条汇总后的全部校验问题。 */
export class EntryOrganizingValidationError extends Error {
  public readonly issues: readonly EntryOrganizingIssue[];

  constructor(issues: readonly EntryOrganizingIssue[]) {
    super(
      `本地校验发现 ${issues.length} 个问题：\n${issues
        .map((issue, index) => `${index + 1}. ${renderIssue(issue)}`)
        .join("\n")}`,
    );
    this.name = "EntryOrganizingValidationError";
    this.issues = issues;
  }
}

/** 一个可追溯到原始转写的字段值及其局部警告。 */
export interface EvidenceNode {
  /** 词条为字符串、词性为正式词性（或 null）；始终是模型整理后的最终值。 */
  readonly value: string | PartOfSpeech | null;
  readonly sourceExcerpt: string | null;
  readonly warning: string | null;
  readonly sourceStart: number | null;
  readonly sourceEnd: number | null;
}

/** 一个义项的词性、释义和可选用法证据节点。 */
export class OrganizedMeaningCandidate {
  public readonly partOfSpeech: EvidenceNode;
  public readonly definition: EvidenceNode;
  public readonly usage: EvidenceNode | null;

  constructor(
    partOfSpeech: EvidenceNode,
    definition: EvidenceNode,
    usage: EvidenceNode | null,
  ) {
    this.partOfSpeech = partOfSpeech;
    this.definition = definition;
    this.usage = usage;
    Object.freeze(this);
  }

  /** 为现有应用层提供无损的结构化义项兼容视图。 */
  get meaning(): StructuredMeaning {
    const part = this.partOfSpeech.value;
    const definition = this.definition.value;
    const usage = this.usage === null ? null : this.usage.value;
    return {
      partOfSpeech: isPartOfSpeechValue(part) ? part : null,
      definition: typeof definition === "string" ? definition : "",
      usage: typeof usage === "string" ? usage : null,
    };
  }

  /** 兼容旧调用；新界面应直接读取 definition 节点。 */
  get meaningSourceExcerpt(): string | null {
    return this.definition.sourceExcerpt;
  }

  /** 兼容旧调用；新界面应直接读取 usage 节点。 */
  get usageSourceExcerpt(): string | null {
    return this.usage === null ? null : this.usage.sourceExcerpt;
  }
}

/** 一个英文词条及其按模型顺序排列的义项证据树。 */
export class OrganizedEntryCandidate {
  public readonly term: EvidenceNode;
  public readonly meanings: readonly OrganizedMeaningCandidate[];

  constructor(term: EvidenceNode, meanings: readonly OrganizedMeaningCandidate[]) {
    this.term = term;
    this.meanings = meanings;
    Object.freeze(this);
    Object.freeze(meanings);
  }

  /** 兼容旧调用；词条节点在 v3 中的正式名称是 term。 */
  get title(): string {
    return typeof this.term.value === "string" ? this.term.value : "";
  }

  /** 兼容旧调用；term 的正式契约保证证据非空。 */
  get titleSourceExcerpt(): string {
    return this.term.sourceExcerpt ?? "";
  }

  /** 兼容旧 UI 的只读摘要，完整归属仍保留在各证据节点。 */
  get warnings(): readonly string[] {
    const values: (string | null)[] = [this.term.warning];
    for (const meaning of this.meanings) {
      values.push(
        meaning.partOfSpeech.warning,
        meaning.definition.warning,
        meaning.usage === null ? null : meaning.usage.warning,
      );
    }
    // 按首次出现顺序去重（对应 Python dict.fromkeys）。
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
      if (value !== null && !seen.has(value)) {
        seen.add(value);
        result.push(value);
      }
    }
    return result;
  }
}

/** 完整通过本地复验的 v3 整理结果。 */
export interface EntryOrganizationResult {
  readonly globalWarning: string | null;
  readonly candidates: readonly OrganizedEntryCandidate[];
}

/** 判断输入是否是普通 JSON 对象（排除数组与 null，对应 Python Mapping 检查）。 */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** warning 缺失、空字符串或 null 统一视为"无警告"，不因表示形式失败。 */
function optionalWarningValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const stripped = value.trim();
  return stripped.length > 0 ? stripped : null;
}

/** 可选用法为空的表示差异（空字符串、空白字符串或空 value 节点）本地统一视为 null。 */
function usageIsEmpty(usage: unknown): boolean {
  if (typeof usage === "string") {
    return usage.trim().length === 0;
  }
  if (isJsonObject(usage)) {
    const value = usage["value"];
    return typeof value === "string" && value.trim().length === 0;
  }
  return false;
}

function joinPath(path: string, key: string): string {
  return path.length > 0 ? `${path}.${key}` : key;
}

/**
 * 比较依据时只折叠大小写与连续空白，不替模型容忍内容改写。
 *
 * 大小写折叠使用 toLowerCase：本契约涉及的英文仅限普通词条与别名表键，
 * 与 Python casefold 的差异不影响任何等价判断。
 */
function foldText(value: string): string {
  return value.toLowerCase().trim().split(/\s+/).join(" ");
}

/**
 * 按字段应用有限、明确的等价规则，用于区分"格式规范化"与"实质订正"。
 *
 * 规则清单（除此之外的差异一律视为实质订正，必须携带同节点 warning）：
 * - 全部字段：大小写折叠、首尾与连续空白整理。
 * - 中文释义：标点等价表中逐条列举的半角/全角标点形态等价。词条、用法等字段不适用
 *   标点映射，避免掩盖英文拼写或例句的实质变化。
 */
function foldValueForField(value: string, field: string): string {
  const folded = foldText(value);
  if (field !== "definition") {
    return folded;
  }
  let result = folded;
  for (const [halfWidth, fullWidth] of Object.entries(DEFINITION_PUNCTUATION_EQUIVALENTS)) {
    result = result.split(halfWidth).join(fullWidth);
  }
  return result;
}

/** 允许在多段原文之间插入授权中文翻译，但不得替换或重排原文片段。 */
function sourceSegmentsAppearInOrder(value: string, sourceExcerpt: string): boolean {
  const foldedValue = foldText(value);
  let offset = 0;
  for (const line of sourceExcerpt.split("\n")) {
    const segment = foldText(line);
    if (segment.length === 0) {
      continue;
    }
    const index = foldedValue.indexOf(segment, offset);
    if (index < 0) {
      return false;
    }
    offset = index + segment.length;
  }
  return true;
}

/** 定位失败的哨兵：与"契约允许的空证据"（null）区分，防止误当作合法补全继续派生。 */
const LOCATE_FAILED = Symbol("locate-failed");

interface Located {
  start: number;
  end: number;
}

/** 词条骨架：结构检查通过的词条；含义位为 null 的义项在内容阶段跳过。 */
interface EntrySkeleton {
  term: Record<string, unknown>;
  meanings: (MeaningSkeleton | null)[];
}

interface MeaningSkeleton {
  partOfSpeech: Record<string, unknown>;
  definition: Record<string, unknown>;
  usage: unknown;
}

/** 单次校验会话的中间产物：问题清单与（零问题时）最终结果。 */
interface ValidationOutcome {
  issues: EntryOrganizingIssue[];
  result: EntryOrganizationResult | null;
}

/** 单次校验会话：先定位各词条证据建立原文区域，再逐节点校验。 */
class PayloadValidator {
  private readonly rawText: string;
  private readonly issues: EntryOrganizingIssue[] = [];
  /**
   * 每个词条在原文中的区域 [start, end)：start 是该词条 term 证据的位置，end 是
   * 下一个词条 term 证据的位置（或原文末尾）。term 证据缺失时区域为 null，该词条
   * 的其余节点只做存在性校验，不做上下文归属判断。
   */
  private readonly entrySpans = new Map<number, [number, number] | null>();

  constructor(rawText: string) {
    this.rawText = rawText;
  }

  run(payload: unknown): ValidationOutcome {
    if (!isJsonObject(payload)) {
      this.record(OrganizingIssueCategory.MissingRequired, "$", "JSON 对象", null);
      return { issues: this.issues, result: null };
    }
    this.checkKeys(payload, "", ["schema_version", "global_warning", "entries"], [], null);
    if (
      "schema_version" in payload &&
      payload["schema_version"] !== ENTRY_ORGANIZER_SCHEMA_VERSION
    ) {
      this.record(
        OrganizingIssueCategory.MissingRequired,
        "schema_version",
        `常量 ${ENTRY_ORGANIZER_SCHEMA_VERSION}`,
        null,
      );
    }
    const globalWarning = optionalWarningValue(payload["global_warning"]);
    const rawEntries = payload["entries"];
    if (!Array.isArray(rawEntries)) {
      this.record(OrganizingIssueCategory.MissingRequired, "entries", "数组", null);
      return { issues: this.issues, result: null };
    }

    // 第一阶段：只做结构检查，把无法安全下钻的词条整体标记为损坏。父结构损坏时
    // 不再深入其子节点，避免一个结构错误派生出一串误导性的字段错误。
    const skeletons: (EntrySkeleton | null)[] = [];
    for (let entryIndex = 0; entryIndex < rawEntries.length; entryIndex += 1) {
      const rawEntry = rawEntries[entryIndex];
      skeletons.push(this.checkEntrySkeleton(entryIndex, rawEntry));
    }

    // 第二阶段：先定位全部词条的 term 证据，建立各词条的原文区域。词条在原文中
    // 通常按转写顺序出现，因此定位 term 时使用"上一个词条之后优先"的 soft 偏好；
    // 找不到时不消耗任何配额，只记录证据不存在。
    let termHint = 0;
    for (let entryIndex = 0; entryIndex < skeletons.length; entryIndex += 1) {
      const skeleton = skeletons[entryIndex];
      if (skeleton === undefined || skeleton === null) {
        this.entrySpans.set(entryIndex, null);
        continue;
      }
      const located = this.locateTerm(skeleton, termHint);
      if (located === null) {
        this.entrySpans.set(entryIndex, null);
        continue;
      }
      this.entrySpans.set(entryIndex, [located.start, this.rawText.length]);
      termHint = located.end;
    }
    // 用下一个已定位词条的 term 起点收紧当前词条区域右边界。
    const knownStarts = [...this.entrySpans.values()]
      .filter((span): span is [number, number] => span !== null)
      .map((span) => span[0])
      .sort((a, b) => a - b);
    for (const [entryIndex, span] of this.entrySpans) {
      if (span === null) {
        continue;
      }
      const later = knownStarts.filter((start) => start > span[0]);
      this.entrySpans.set(entryIndex, [
        span[0],
        later.length > 0 ? Math.min(...later) : this.rawText.length,
      ]);
    }

    // 第三阶段：逐词条逐节点做内容与证据校验。词条内容错误的词条仍继续检查其余
    // 节点，使一次校验就能汇总该词条的全部问题。
    const candidates: OrganizedEntryCandidate[] = [];
    for (let entryIndex = 0; entryIndex < skeletons.length; entryIndex += 1) {
      const skeleton = skeletons[entryIndex];
      if (skeleton === undefined || skeleton === null) {
        continue;
      }
      const candidate = this.validateEntry(entryIndex, skeleton);
      if (candidate !== null) {
        candidates.push(candidate);
      }
    }

    if (this.issues.length > 0) {
      return { issues: this.issues, result: null };
    }
    return {
      issues: this.issues,
      result: Object.freeze({
        globalWarning,
        candidates: Object.freeze(candidates),
      }) as EntryOrganizationResult,
    };
  }

  // ------------------------------------------------------------------
  // 结构检查（第一阶段）
  // ------------------------------------------------------------------

  private checkEntrySkeleton(entryIndex: number, rawEntry: unknown): EntrySkeleton | null {
    const entryPath = `entries[${entryIndex}]`;
    if (!isJsonObject(rawEntry)) {
      this.record(OrganizingIssueCategory.MissingRequired, entryPath, "对象", entryIndex);
      return null;
    }
    if (!this.checkKeys(rawEntry, entryPath, ["term", "meanings"], [], entryIndex)) {
      return null;
    }
    const rawTerm = rawEntry["term"];
    const rawMeanings = rawEntry["meanings"];
    if (!isJsonObject(rawTerm)) {
      this.record(
        OrganizingIssueCategory.MissingRequired,
        `${entryPath}.term`,
        "对象",
        entryIndex,
      );
      return null;
    }
    if (!this.checkNodeKeys(rawTerm, `${entryPath}.term`, entryIndex)) {
      return null;
    }
    if (!Array.isArray(rawMeanings) || rawMeanings.length === 0) {
      this.record(
        OrganizingIssueCategory.MissingRequired,
        `${entryPath}.meanings`,
        "至少包含一个对象的数组",
        entryIndex,
      );
      return null;
    }
    const meanings: (MeaningSkeleton | null)[] = [];
    for (let meaningIndex = 0; meaningIndex < rawMeanings.length; meaningIndex += 1) {
      const meaningPath = `${entryPath}.meanings[${meaningIndex}]`;
      const rawMeaning = rawMeanings[meaningIndex];
      if (!isJsonObject(rawMeaning)) {
        this.record(OrganizingIssueCategory.MissingRequired, meaningPath, "对象", entryIndex);
        meanings.push(null);
        continue;
      }
      if (!this.checkKeys(rawMeaning, meaningPath, ["part_of_speech", "definition", "usage"], [], entryIndex)) {
        meanings.push(null);
        continue;
      }
      const part = rawMeaning["part_of_speech"];
      const definition = rawMeaning["definition"];
      // 词性与释义是必需证据节点；词性对象整体错误时定位到用户真正需要修复的
      // value 字段，使修复消息与正式 Schema 的叶子路径保持一致。
      if (!isJsonObject(part)) {
        this.record(
          OrganizingIssueCategory.MissingRequired,
          `${meaningPath}.part_of_speech.value`,
          "正式词性简称或 null",
          entryIndex,
        );
        meanings.push(null);
        continue;
      }
      if (!isJsonObject(definition)) {
        this.record(
          OrganizingIssueCategory.MissingRequired,
          `${meaningPath}.definition`,
          "对象",
          entryIndex,
        );
        meanings.push(null);
        continue;
      }
      const nodesOk =
        this.checkNodeKeys(part, `${meaningPath}.part_of_speech`, entryIndex) &&
        this.checkNodeKeys(definition, `${meaningPath}.definition`, entryIndex);
      const usage = rawMeaning["usage"];
      let usageOk = true;
      if (usage !== null && !usageIsEmpty(usage)) {
        usageOk = isJsonObject(usage) && this.checkNodeKeys(usage, `${meaningPath}.usage`, entryIndex);
        if (!isJsonObject(usage)) {
          this.record(
            OrganizingIssueCategory.MissingRequired,
            `${meaningPath}.usage`,
            "证据节点对象、空字符串或 null",
            entryIndex,
          );
        }
      }
      meanings.push(
        nodesOk && usageOk ? { partOfSpeech: part, definition, usage } : null,
      );
    }
    return { term: rawTerm, meanings };
  }

  private checkKeys(
    payload: Record<string, unknown>,
    path: string,
    required: readonly string[],
    optional: readonly string[],
    entryIndex: number | null,
  ): boolean {
    const allowed = new Set([...required, ...optional]);
    const present = new Set(Object.keys(payload));
    let ok = true;
    for (const key of required.filter((item) => !present.has(item)).sort()) {
      this.record(OrganizingIssueCategory.MissingRequired, joinPath(path, key), "必填字段", entryIndex);
      ok = false;
    }
    for (const key of [...present].filter((item) => !allowed.has(item)).sort()) {
      this.record(OrganizingIssueCategory.MissingRequired, joinPath(path, key), "不存在额外字段", entryIndex);
      ok = false;
    }
    return ok;
  }

  private checkNodeKeys(
    node: Record<string, unknown>,
    path: string,
    entryIndex: number,
  ): boolean {
    return this.checkKeys(node, path, ["value", "source_excerpt"], ["warning"], entryIndex);
  }

  // ------------------------------------------------------------------
  // 证据定位（第二阶段与逐节点调用）
  // ------------------------------------------------------------------

  /** 查找证据片段在原文中的全部真实出现位置；不维护任何消费配额。 */
  private findOccurrences(excerpt: string): number[] {
    const starts: number[] = [];
    let offset = 0;
    for (;;) {
      const index = this.rawText.indexOf(excerpt, offset);
      if (index < 0) {
        return starts;
      }
      starts.push(index);
      offset = index + 1;
    }
  }

  /** 定位词条证据；词条内容问题在第三阶段统一处理，这里只关心原文位置。 */
  private locateTerm(skeleton: EntrySkeleton, hint: number): Located | null {
    const source = skeleton.term["source_excerpt"];
    if (typeof source !== "string" || source.trim().length === 0) {
      return null;
    }
    const occurrences = this.findOccurrences(source);
    if (occurrences.length === 0) {
      return null;
    }
    const start = occurrences.find((item) => item >= hint) ?? occurrences[0];
    if (start === undefined) {
      return null;
    }
    return { start, end: start + source.length };
  }

  /**
   * 定位单个节点的原文证据。
   *
   * 返回 Located 表示定位成功；返回 null 表示该节点契约允许空证据；返回
   * LOCATE_FAILED 表示已记录问题、不再派生后续判断。
   */
  private locateNodeSource(
    source: unknown,
    path: string,
    entryIndex: number,
    hint: number,
    options: { allowNullSource: boolean },
  ): Located | null | typeof LOCATE_FAILED {
    if (source === null || source === undefined) {
      if (options.allowNullSource) {
        return null;
      }
      this.record(
        OrganizingIssueCategory.MissingRequired,
        `${path}.source_excerpt`,
        "原始转写中的非空连续片段",
        entryIndex,
      );
      return LOCATE_FAILED;
    }
    if (typeof source !== "string" || source.trim().length === 0) {
      this.record(
        OrganizingIssueCategory.MissingRequired,
        `${path}.source_excerpt`,
        "非空字符串或契约允许的 null",
        entryIndex,
      );
      return LOCATE_FAILED;
    }
    const occurrences = this.findOccurrences(source);
    if (occurrences.length === 0) {
      this.record(
        OrganizingIssueCategory.EvidenceNotFound,
        `${path}.source_excerpt`,
        "原始转写中的连续片段",
        entryIndex,
      );
      return LOCATE_FAILED;
    }
    const ownSpan = this.entrySpans.get(entryIndex) ?? null;
    // 高亮位置选择偏好：优先落在本词条区域内、且不早于当前词条内上一节点终点的
    // 出现位置，让重复片段（如多个义项均为「名词」）各自高亮到更合理的上下文；
    // 这只是高亮质量偏好，重复使用同一位置始终合法，不产生任何问题。
    const inSpan =
      ownSpan === null
        ? []
        : occurrences.filter((start) => ownSpan[0] <= start && start < ownSpan[1]);
    // occurrences 非空已由上方检查保证，fallback 链末端必然命中，这里仅为满足
    // 严格索引类型检查而保留 undefined 兜底（直接抛错，不静默归零）。
    const start =
      inSpan.find((item) => item >= hint) ??
      (inSpan.length > 0
        ? inSpan[0]
        : (occurrences.find((item) => item >= hint) ?? occurrences[0]));
    if (start === undefined) {
      throw new Error("证据定位内部错误：occurrences 非空却未取得位置");
    }
    // 明显跨词条引用识别：只有"全部原文中唯一一次出现、且该位置明确落在另一个
    // 词条的证据区域内"才判定上下文不对应。片段存在多个出现位置、词条区域因
    // term 证据缺失而无法建立等情况都属于无法唯一定位，一律不当作引用伪造。
    if (ownSpan !== null && !(ownSpan[0] <= start && start < ownSpan[1])) {
      const others: number[] = [];
      for (const [otherIndex, span] of this.entrySpans) {
        if (otherIndex !== entryIndex && span !== null && span[0] <= start && start < span[1]) {
          others.push(otherIndex);
        }
      }
      if (occurrences.length === 1 && others.length > 0) {
        this.record(
          OrganizingIssueCategory.EvidenceContextMismatch,
          `${path}.source_excerpt`,
          "属于当前词条原文区域的连续片段",
          entryIndex,
        );
        return LOCATE_FAILED;
      }
    }
    return { start, end: start + source.length };
  }

  // ------------------------------------------------------------------
  // 逐节点内容与证据校验（第三阶段）
  // ------------------------------------------------------------------

  private validateEntry(entryIndex: number, skeleton: EntrySkeleton): OrganizedEntryCandidate | null {
    const entryPath = `entries[${entryIndex}]`;
    // 词条区域右边界已由第二阶段建立；term 节点从区域起点开始定位，与第二阶段
    // 建立区域时选择的必然是同一出现位置。
    const span = this.entrySpans.get(entryIndex) ?? null;
    let term = this.validateTextNode(skeleton.term, `${entryPath}.term`, entryIndex, {
      hint: 0,
      allowNullSource: false,
      usageTranslationAllowed: false,
      field: "term",
    });
    // 词条内其余节点的定位偏好从词条证据终点开始，使重复片段（如多个「名词」）
    // 在词条区域内优先按出现顺序分配高亮位置；这只是偏好，不是消耗配额。
    let hint = span !== null ? span[0] : 0;
    if (term !== null && term.sourceEnd !== null) {
      hint = term.sourceEnd;
    }
    if (term !== null) {
      // 原文证据可以是语音识别错误片段，但整理后的正式词条必须仍是英文单词或短语；
      // 该约束属于两种模式共用的领域契约，不能留给任一保存流程单独补验。
      if (typeof term.value !== "string" || !isValidEnglishEntryTerm(term.value)) {
        this.record(
          OrganizingIssueCategory.MissingRequired,
          `${entryPath}.term.value`,
          "英文单词或短语",
          entryIndex,
        );
        term = null;
      }
    }

    const meanings: OrganizedMeaningCandidate[] = [];
    for (let meaningIndex = 0; meaningIndex < skeleton.meanings.length; meaningIndex += 1) {
      const meaningSkeleton = skeleton.meanings[meaningIndex];
      if (meaningSkeleton === null || meaningSkeleton === undefined) {
        continue;
      }
      const meaningPath = `${entryPath}.meanings[${meaningIndex}]`;
      const part = this.validatePartOfSpeechNode(
        meaningSkeleton.partOfSpeech,
        `${meaningPath}.part_of_speech`,
        entryIndex,
        hint,
      );
      if (part !== null && part.sourceEnd !== null) {
        hint = Math.max(hint, part.sourceEnd);
      }
      const definition = this.validateTextNode(
        meaningSkeleton.definition,
        `${meaningPath}.definition`,
        entryIndex,
        { hint, allowNullSource: true, usageTranslationAllowed: false, field: "definition" },
      );
      if (definition !== null && definition.sourceEnd !== null) {
        hint = Math.max(hint, definition.sourceEnd);
      }
      const rawUsage = meaningSkeleton.usage;
      let usage: EvidenceNode | null = null;
      const usageRequired = rawUsage !== null && rawUsage !== undefined && !usageIsEmpty(rawUsage);
      if (usageRequired) {
        usage = this.validateTextNode(rawUsage as Record<string, unknown>, `${meaningPath}.usage`, entryIndex, {
          hint,
          allowNullSource: false,
          usageTranslationAllowed: true,
          field: "usage",
        });
        if (usage !== null && usage.sourceEnd !== null) {
          hint = Math.max(hint, usage.sourceEnd);
        }
      }
      if (part === null || definition === null || (usageRequired && usage === null)) {
        continue;
      }

      // StructuredMeaning 仍是正式学习数据的最小值对象；在领域边界提前运行它的
      // 长度和空值约束，防止无效候选直到保存阶段才失败。
      const structuredPart = part.value;
      const structuredMeaning = (() => {
        try {
          return createStructuredMeaning(
            isPartOfSpeechValue(structuredPart) ? structuredPart : null,
            String(definition.value),
            usage === null ? null : String(usage.value),
          );
        } catch {
          return null;
        }
      })();
      if (structuredMeaning === null) {
        this.record(
          OrganizingIssueCategory.MissingRequired,
          meaningPath,
          "满足结构化义项约束的字段",
          entryIndex,
        );
        continue;
      }
      if (!containsChineseDefinition(structuredMeaning.definition)) {
        this.record(
          OrganizingIssueCategory.MissingRequired,
          `${meaningPath}.definition.value`,
          "至少包含一个中文字符的释义",
          entryIndex,
        );
        continue;
      }
      meanings.push(new OrganizedMeaningCandidate(part, definition, usage));
    }

    // 词条或义项校验失败时该词条没有可交付候选；问题已逐条记录，这里不追加派生错误。
    if (term === null) {
      return null;
    }
    return new OrganizedEntryCandidate(term, meanings);
  }

  private validateTextNode(
    node: Record<string, unknown>,
    path: string,
    entryIndex: number,
    options: {
      hint: number;
      allowNullSource: boolean;
      usageTranslationAllowed: boolean;
      field: string;
    },
  ): EvidenceNode | null {
    let ok = true;
    const value = node["value"];
    let normalizedValue = "";
    if (typeof value !== "string" || value.trim().length === 0) {
      this.record(OrganizingIssueCategory.MissingRequired, `${path}.value`, "非空字符串", entryIndex);
      ok = false;
    } else {
      normalizedValue = value.trim();
    }
    const warning = optionalWarningValue(node["warning"]);

    const located = this.locateNodeSource(node["source_excerpt"], path, entryIndex, options.hint, {
      allowNullSource: options.allowNullSource,
    });
    if (located === LOCATE_FAILED) {
      return null;
    }
    if (located === null) {
      // 无原文依据的模型补充内容必须在同节点说明来源，不得静默放行。
      if (warning === null) {
        this.record(
          OrganizingIssueCategory.MissingRequired,
          `${path}.warning`,
          "source_excerpt 为空时的非空字符串",
          entryIndex,
        );
        ok = false;
      }
      return ok
        ? { value: normalizedValue, sourceExcerpt: null, warning, sourceStart: null, sourceEnd: null }
        : null;
    }
    const source = node["source_excerpt"] as string;

    // 证据本身始终要求精确匹配原文字符（上面的定位已保证）；这里只在"格式规范化后
    // 仍不一致"时要求订正 warning。字段对应的规范化规则见 foldValueForField。
    const foldedValue = foldValueForField(normalizedValue, options.field);
    const foldedSource = foldValueForField(source, options.field);
    const unchanged = options.usageTranslationAllowed
      ? sourceSegmentsAppearInOrder(normalizedValue, source)
      : foldedSource.includes(foldedValue);
    if (!unchanged && warning === null) {
      this.record(
        OrganizingIssueCategory.CorrectionWithoutWarning,
        `${path}.warning`,
        "字段修正时的非空字符串",
        entryIndex,
      );
      ok = false;
    }
    if (!ok) {
      return null;
    }
    return {
      value: normalizedValue,
      sourceExcerpt: source,
      warning,
      sourceStart: located.start,
      sourceEnd: located.end,
    };
  }

  private validatePartOfSpeechNode(
    node: Record<string, unknown>,
    path: string,
    entryIndex: number,
    hint: number,
  ): EvidenceNode | null {
    let ok = true;
    const warning = optionalWarningValue(node["warning"]);

    const rawValue = node["value"];
    let value: PartOfSpeech | null = null;
    if (rawValue === null) {
      value = null;
    } else if (typeof rawValue === "string") {
      // 有效词性别名（noun／名词／n 等）先本地规范化为正式简称；表示形式差异
      // 不再是失败原因。无法识别的取值（包括「名次」这类错字——它不进入别名表，
      // 是否表示名词由模型结合上下文判断并以订正加 warning 表达）才算结构问题。
      value = normalizePartOfSpeech(rawValue);
      if (value === null) {
        this.record(
          OrganizingIssueCategory.MissingRequired,
          `${path}.value`,
          "正式词性简称、可识别的词性别名或 null",
          entryIndex,
        );
        ok = false;
      }
    } else {
      this.record(
        OrganizingIssueCategory.MissingRequired,
        `${path}.value`,
        "正式词性简称或 null",
        entryIndex,
      );
      ok = false;
    }

    const located = this.locateNodeSource(node["source_excerpt"], path, entryIndex, hint, {
      allowNullSource: true,
    });
    if (located === LOCATE_FAILED) {
      return null;
    }
    let source: unknown = node["source_excerpt"];
    if (located === null) {
      source = null;
    }
    // 词性值缺失或原文依据缺失（模型补全）都必须在同节点说明。
    if ((value === null || located === null) && warning === null) {
      this.record(
        OrganizingIssueCategory.MissingRequired,
        `${path}.warning`,
        "值或原文依据为空时的非空字符串",
        entryIndex,
      );
      ok = false;
    }
    if (value !== null && located !== null && typeof source === "string") {
      const sourcePart = normalizePartOfSpeech(source);
      // 证据侧同样走别名规范化：原文说「名词」、整理值为 n. 属于格式规范化，
      // 不要求 warning；只有规范化后仍不一致（如把「名次」订正为名词）才算实质订正。
      if (sourcePart !== value && warning === null) {
        this.record(
          OrganizingIssueCategory.CorrectionWithoutWarning,
          `${path}.warning`,
          "词性发生修正时的非空字符串",
          entryIndex,
        );
        ok = false;
      }
    }
    if (!ok) {
      return null;
    }
    return {
      value,
      sourceExcerpt: typeof source === "string" ? source : null,
      warning,
      sourceStart: located === null ? null : located.start,
      sourceEnd: located === null ? null : located.end,
    };
  }

  // ------------------------------------------------------------------
  // 问题记录
  // ------------------------------------------------------------------

  private record(
    category: OrganizingIssueCategory,
    path: string,
    expectation: string,
    entryIndex: number | null,
  ): void {
    this.issues.push({ category, path, expectation, entryIndex });
  }
}

/** 汇总全部可独立判断的校验问题；父结构损坏的词条不再派生子节点错误。 */
export function collectEntryOrganizingIssues(
  rawText: string,
  payload: unknown,
): readonly EntryOrganizingIssue[] {
  return new PayloadValidator(rawText).run(payload).issues;
}

/**
 * 严格复验 v3 结构、字段语义和每个模型声明的非空原文证据。
 *
 * 与旧实现的首个错误即抛出不同，这里先汇总全部问题：任一问题存在即抛出携带完整
 * 问题清单的 EntryOrganizingValidationError，全部通过才返回整理结果。
 */
export function validateEntryOrganizerPayload(
  rawText: string,
  payload: unknown,
): EntryOrganizationResult {
  const outcome = new PayloadValidator(rawText).run(payload);
  if (outcome.issues.length > 0) {
    throw new EntryOrganizingValidationError(outcome.issues);
  }
  if (outcome.result === null) {
    // 校验器只在零问题时构造结果；此处不可能为 null，防御未来改动静默返回空结果。
    throw new Error("校验器内部错误：零问题但结果缺失");
  }
  return outcome.result;
}
