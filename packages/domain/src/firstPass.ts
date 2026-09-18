/**
 * 首过原始转写的本地解析、规范化与模型结构复验（移植 V1 domain/first_pass.py）。
 *
 * 解析器只生成待预览保存的结构化候选，绝不直接写入学习数据。所有无法识别或可能
 * 丢失的信息都通过带原始行号的问题返回，调用方必须在预览保存前解决阻塞错误。
 *
 * 两条路径共用同一套字段校验（`candidateFromFields`）：
 * - 本地规则路径（parseLocalFirstPass）：识别语音转写中的显式分隔与口述控制词；
 * - 大语言模型路径（validateOrganizedPayload）：复用唯一的 entry-organizer-v3 校验器，
 *   不让模型结果绕过本地格式规则。
 */

import {
  ENTRY_ORGANIZER_SCHEMA_VERSION,
  OrganizingIssueCategory,
  normalizeEntryKey,
  normalizeEntryTerm,
  containsChineseDefinition,
  isValidEnglishEntryTerm,
  validateEntryOrganizerPayload,
  type EntryOrganizationResult,
} from "./entryOrganizing.ts";
import {
  PartOfSpeech,
  createStructuredMeaning,
  dedupeMeanings,
  formatStructuredMeanings,
  splitPartOfSpeechPrefix,
  type StructuredMeaning,
} from "./meanings.ts";

/** 与 entry-organizer-v3 共用同一 schema 版本；本包不拥有第二套模型响应 Schema。 */
export const FIRST_PASS_RESPONSE_SCHEMA_VERSION = ENTRY_ORGANIZER_SCHEMA_VERSION;
export const LOCAL_PARSER_VERSION = "local-first-pass-parser-v2";

/** 口述"下一个"分隔词的切分模式（两侧空白一并吞掉）。 */
const SPOKEN_SEPARATOR_PATTERN = /\s*下一个\s*/;

/** 预览中问题的严重程度；错误阻止确认，警告要求用户核对。 */
export const ParseIssueLevel = {
  Warning: "警告",
  Error: "错误",
} as const;
export type ParseIssueLevel = (typeof ParseIssueLevel)[keyof typeof ParseIssueLevel];

/** 能够回到原始转写位置的解析问题。 */
export interface ParseIssue {
  readonly lineNumber: number;
  readonly code: string;
  readonly message: string;
  readonly originalFragment: string;
  readonly level: ParseIssueLevel;
}

export function isBlockingIssue(issue: ParseIssue): boolean {
  return issue.level === ParseIssueLevel.Error;
}

/** 尚未执行预览保存的一个英文词条与结构化手录义项候选。 */
export interface WordCandidate {
  readonly lineNumber: number;
  readonly originalFragment: string;
  readonly originalSpelling: string;
  readonly normalizedKey: string;
  readonly meanings: readonly StructuredMeaning[];
  readonly needsConfirmation: boolean;
  readonly warnings: readonly string[];
}

/** 使用产品推荐分隔符形成最终可编辑预览文案。 */
export function candidateManualMeaning(candidate: WordCandidate): string {
  return formatStructuredMeanings(candidate.meanings);
}

/** 本地或大语言模型路径统一返回的预览结构。 */
export interface ParseResult {
  readonly rawText: string;
  readonly candidates: readonly WordCandidate[];
  readonly issues: readonly ParseIssue[];
  readonly organizerKind: string;
  readonly parserVersion: string;
  readonly responseSchemaVersion: string;
}

/** 是否存在阻塞保存的错误。 */
export function hasBlockingErrors(result: ParseResult): boolean {
  return result.issues.some(isBlockingIssue);
}

/** 兼容旧词书调用；正式规范键由两种模式共用函数生成。 */
export function normalizeWordKey(spelling: string): string {
  return normalizeEntryKey(spelling);
}

/** 只在括号外按候选标点拆义项，避免破坏词性或补充说明。 */
function splitMeaningFragments(text: string): string[] {
  const meanings: string[] = [];
  const current: string[] = [];
  let depth = 0;
  const opening = new Set(["(", "（", "[", "【"]);
  const closing = new Set([")", "）", "]", "】"]);
  const separators = new Set([";", "；", ",", "，", "、"]);
  for (const character of text.trim()) {
    if (opening.has(character)) {
      depth += 1;
    } else if (closing.has(character) && depth > 0) {
      depth -= 1;
    }
    if (separators.has(character) && depth === 0) {
      const meaning = current.join("").trim();
      if (meaning.length > 0 && !meanings.includes(meaning)) {
        meanings.push(meaning);
      }
      current.length = 0;
      continue;
    }
    current.push(character);
  }
  const finalMeaning = current.join("").trim();
  if (finalMeaning.length > 0 && !meanings.includes(finalMeaning)) {
    meanings.push(finalMeaning);
  }
  return meanings;
}

/**
 * 逐项提取并规范化词性；词性是可选字段，缺失时按无词性保留进预览。
 *
 * 本地规则绝不猜测用户没有表达的词性：缺词性的义项以 null 词性进入候选并携带
 * 警告提醒核对，用户可以留空保存，也可以在预览表单中逐条补选词性。
 */
function parseStructuredMeanings(input: {
  lineNumber: number;
  originalFragment: string;
  meaningText: string;
}): [StructuredMeaning[], ParseIssue[]] {
  const structured: StructuredMeaning[] = [];
  const issues: ParseIssue[] = [];
  for (const fragment of splitMeaningFragments(input.meaningText)) {
    const [partOfSpeech, definition] = splitPartOfSpeechPrefix(fragment);
    if (partOfSpeech === null) {
      issues.push({
        lineNumber: input.lineNumber,
        code: "missing-part-of-speech",
        message: `义项“${fragment}”缺少可识别词性，将按无词性保存，可在表单中补选`,
        originalFragment: input.originalFragment,
        level: ParseIssueLevel.Warning,
      });
    }
    structured.push(createStructuredMeaning(partOfSpeech, definition));
  }
  return [dedupeMeanings(structured), issues];
}

/** 拆出原始行，并标记是否应用了口述控制词候选转换。 */
function lineFragments(rawText: string): [number, string, boolean][] {
  const fragments: [number, string, boolean][] = [];
  const lines = rawText.split(/\r\n|\n|\r/);
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    if (rawLine === undefined) {
      continue;
    }
    const stripped = rawLine.trim();
    if (stripped.length === 0) {
      continue;
    }
    const spokenChanged = stripped.includes("下一个") || stripped.includes("竖线");
    const converted = stripped.split("竖线").join("|");
    const pieces = converted.includes("下一个")
      ? converted.split(SPOKEN_SEPARATOR_PATTERN)
      : [converted];
    for (const piece of pieces) {
      const trimmed = piece.trim();
      if (trimmed.length > 0) {
        fragments.push([index + 1, trimmed, spokenChanged]);
      }
    }
  }
  return fragments;
}

/** 优先使用明确分隔符，否则在首个中文字符前形成待确认边界。 */
function splitEntry(fragment: string): [string, string, boolean] {
  for (const separator of ["|", "\t"]) {
    if (fragment.includes(separator)) {
      const index = fragment.indexOf(separator);
      return [fragment.slice(0, index).trim(), fragment.slice(index + 1).trim(), true];
    }
  }
  const chineseMatch = /[\u3400-\u9fff]/.exec(fragment);
  if (chineseMatch === null || chineseMatch.index === undefined) {
    return [fragment.trim(), "", false];
  }
  const boundary = chineseMatch.index;
  // 词尾的标点不属于英文词条，切边界时一并去掉（与 V1 rstrip 集合一致）。
  const spelling = fragment
    .slice(0, boundary)
    .replace(/[ ,，:：.。;；]+$/u, "");
  const meaning = fragment.slice(boundary).trim();
  return [spelling.trim(), meaning, false];
}

/** 同一 List 内重复规范键合并义项，同时保留重复位置警告。 */
function mergeCandidates(
  candidates: WordCandidate[],
  issues: ParseIssue[],
): WordCandidate[] {
  const merged = new Map<string, WordCandidate>();
  const order: string[] = [];
  for (const candidate of candidates) {
    const existing = merged.get(candidate.normalizedKey);
    if (existing === undefined) {
      merged.set(candidate.normalizedKey, candidate);
      order.push(candidate.normalizedKey);
      continue;
    }
    const combinedMeanings = dedupeMeanings([...existing.meanings, ...candidate.meanings]);
    const warning = `与第 ${existing.lineNumber} 行词条重复，义项已合并，保存前请确认`;
    issues.push({
      lineNumber: candidate.lineNumber,
      code: "duplicate-word",
      message: warning,
      originalFragment: candidate.originalFragment,
      level: ParseIssueLevel.Warning,
    });
    merged.set(candidate.normalizedKey, {
      ...existing,
      meanings: combinedMeanings,
      needsConfirmation: true,
      warnings: [...new Set([...existing.warnings, warning])],
    });
  }
  return order.map((key) => {
    const candidate = merged.get(key);
    if (candidate === undefined) {
      throw new Error("候选合并内部错误：排序键缺失");
    }
    return candidate;
  });
}

/** 统一校验本地和模型产生的字段，不让模型结果绕过格式规则。 */
function candidateFromFields(input: {
  lineNumber: number;
  originalFragment: string;
  spelling: string;
  meanings: readonly StructuredMeaning[];
  explicitSeparator: boolean;
  externalWarnings?: readonly string[];
}): [WordCandidate | null, ParseIssue[]] {
  const issues: ParseIssue[] = [];
  const normalizedSpelling = normalizeEntryTerm(input.spelling);
  if (!isValidEnglishEntryTerm(normalizedSpelling)) {
    issues.push({
      lineNumber: input.lineNumber,
      code: "invalid-word",
      message: "无法识别合法英文词条；仅允许英文字母、连字符、撇号和短语空格",
      originalFragment: input.originalFragment,
      level: ParseIssueLevel.Error,
    });
  }
  if (input.meanings.length === 0) {
    issues.push({
      lineNumber: input.lineNumber,
      code: "missing-meaning",
      message: "缺少中文义项",
      originalFragment: input.originalFragment,
      level: ParseIssueLevel.Error,
    });
  }
  if (input.meanings.some((meaning) => !containsChineseDefinition(meaning.definition))) {
    issues.push({
      lineNumber: input.lineNumber,
      code: "meaning-without-chinese",
      message: "义项未包含可识别的中文内容",
      originalFragment: input.originalFragment,
      level: ParseIssueLevel.Error,
    });
  }
  if (issues.some(isBlockingIssue)) {
    return [null, issues];
  }

  const externalWarnings = [...(input.externalWarnings ?? [])];
  let needsConfirmation = externalWarnings.length > 0;
  const warnings = [...externalWarnings];
  if (normalizedSpelling.includes(" ") && !input.explicitSeparator) {
    const message = "多词短语未使用竖线或 Tab 明确边界，预览保存前必须核对";
    issues.push({
      lineNumber: input.lineNumber,
      code: "ambiguous-phrase-boundary",
      message,
      originalFragment: input.originalFragment,
      level: ParseIssueLevel.Warning,
    });
    needsConfirmation = true;
    warnings.push(message);
  }
  return [
    {
      lineNumber: input.lineNumber,
      originalFragment: input.originalFragment,
      originalSpelling: normalizedSpelling,
      normalizedKey: normalizeWordKey(normalizedSpelling),
      meanings: [...input.meanings],
      needsConfirmation,
      warnings: [...new Set(warnings)],
    },
    issues,
  ];
}

/** 解析原始转写并返回可编辑预览；空白原文代表待确认的空 List。 */
export function parseLocalFirstPass(rawText: string): ParseResult {
  const candidates: WordCandidate[] = [];
  const issues: ParseIssue[] = [];
  for (const [lineNumber, fragment, spokenChanged] of lineFragments(rawText)) {
    const [spelling, meaningText, explicitSeparator] = splitEntry(fragment);
    let externalWarnings: string[] = [];
    if (spokenChanged) {
      const message = "已按口述控制词生成候选分隔，保存前请对照原文确认";
      externalWarnings = [message];
      issues.push({
        lineNumber,
        code: "spoken-separator-converted",
        message,
        originalFragment: fragment,
        level: ParseIssueLevel.Warning,
      });
    }
    const [structuredMeanings, meaningIssues] = parseStructuredMeanings({
      lineNumber,
      originalFragment: fragment,
      meaningText,
    });
    // 缺词性等问题随候选一起进预览并标记为待核对，让用户在表单里逐条修正，
    // 而不是整条候选被丢弃后无处可修。
    if (meaningIssues.length > 0) {
      externalWarnings = [...externalWarnings, ...meaningIssues.map((issue) => issue.message)];
    }
    // 词性解析必须先于统一字段校验，让缺失词性与缺少中文义项分别定位。
    const [candidate, candidateIssues] = candidateFromFields({
      lineNumber,
      originalFragment: fragment,
      spelling,
      meanings: structuredMeanings,
      explicitSeparator,
      externalWarnings,
    });
    issues.push(...meaningIssues);
    issues.push(...candidateIssues);
    if (candidate !== null) {
      candidates.push(candidate);
    }
  }
  return {
    rawText,
    candidates: mergeCandidates(candidates, issues),
    issues,
    organizerKind: "本地规则",
    parserVersion: LOCAL_PARSER_VERSION,
    responseSchemaVersion: FIRST_PASS_RESPONSE_SCHEMA_VERSION,
  };
}

/**
 * 复用唯一 v3 校验器，并转换为词书模式现有预览结构。
 *
 * ParseResult 是词书保存流程的兼容视图，不再拥有第二套模型响应 Schema。原文中
 * 未被模型引用的内容不会产生覆盖率错误；完整证据树由上层结果快照另行保留给新 UI。
 */
export function validateOrganizedPayload(rawText: string, payload: unknown): ParseResult {
  const organization = validateEntryOrganizerPayload(rawText, payload);
  return organizationResultToParseResult(rawText, organization);
}

/** 把已校验 v3 结果转换为词书保存流程的兼容预览对象。 */
export function organizationResultToParseResult(
  rawText: string,
  organization: EntryOrganizationResult,
): ParseResult {
  const candidates: WordCandidate[] = [];
  const issues: ParseIssue[] = [];
  if (organization.globalWarning !== null) {
    issues.push({
      lineNumber: 0,
      code: "model-global-warning",
      message: organization.globalWarning,
      originalFragment: "",
      level: ParseIssueLevel.Warning,
    });
  }

  let index = 1;
  for (const organized of organization.candidates) {
    // 旧预览对象只接受条目级 warnings，因此这里只提供兼容摘要；v3 证据节点本身
    // 仍完整保留在 organization 中，新的界面路径不得从该摘要反推证据归属。
    const [candidate, candidateIssues] = candidateFromFields({
      lineNumber: index,
      originalFragment: organized.titleSourceExcerpt,
      spelling: organized.title,
      meanings: organized.meanings.map((meaning) => meaning.meaning),
      explicitSeparator: true,
      externalWarnings: organized.warnings,
    });
    issues.push(...candidateIssues);
    if (candidate !== null) {
      candidates.push(candidate);
    }
    index += 1;
  }

  return {
    rawText,
    candidates: mergeCandidates(candidates, issues),
    issues,
    organizerKind: "大语言模型",
    parserVersion: "model-output-local-validator-v3",
    responseSchemaVersion: FIRST_PASS_RESPONSE_SCHEMA_VERSION,
  };
}

/** 导出词性值域给消费方做表单候选（与 meanings 保持同源引用）。 */
export { PartOfSpeech };
export { OrganizingIssueCategory };
