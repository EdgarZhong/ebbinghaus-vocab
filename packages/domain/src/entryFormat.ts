/**
 * 统一条目规范格式的本地解析（移植 V1 domain/entry_format.py）。
 *
 * 用户可以输入任意自由文本；本模块只负责识别已经符合规范的块。无法识别的内容由
 * 应用层交给智能整理或作为未整理片段呈现在确认表单，绝不在这里猜测、改写或丢弃原文。
 */

import { createStructuredMeaning, normalizePartOfSpeech, type StructuredMeaning } from "./meanings.ts";

/** 可定位到原始输入的格式问题。 */
export interface EntryFormatIssue {
  readonly lineNumber: number;
  readonly message: string;
  readonly fragment: string;
}

/** 标题原样保留的规范条目候选。 */
export interface EntryFormatCandidate {
  readonly lineNumber: number;
  /** 标题不做任何格式化；标题内的点、竖线和空格都是用户内容。 */
  readonly title: string;
  readonly meanings: readonly StructuredMeaning[];
  readonly originalBlock: string;
}

/** 本地识别的候选与必须人工或智能整理处理的片段。 */
export interface EntryFormatParseResult {
  readonly candidates: readonly EntryFormatCandidate[];
  readonly issues: readonly EntryFormatIssue[];
}

/** 解析一条义项，且只把第一个竖线解释为释义与用法的边界。 */
function parseMeaningLine(
  lineNumber: number,
  line: string,
): [StructuredMeaning | null, EntryFormatIssue | null] {
  const separatorIndex = line.indexOf("|");
  const meaningPart = separatorIndex < 0 ? line : line.slice(0, separatorIndex);
  const usagePart = separatorIndex < 0 ? "" : line.slice(separatorIndex + 1);
  const hasSeparator = separatorIndex >= 0;
  let content = meaningPart.trim();
  if (content.length === 0) {
    return [null, { lineNumber, message: "释义不能为空", fragment: line }];
  }
  let partOfSpeech: ReturnType<typeof normalizePartOfSpeech> = null;
  if (content.includes(".")) {
    // 只按第一个点拆分：点前部分若能规范化为正式词性则视为词性标记。
    const dotIndex = content.indexOf(".");
    const possiblePos = content.slice(0, dotIndex);
    const possibleDefinition = content.slice(dotIndex + 1);
    const normalizedPos = normalizePartOfSpeech(possiblePos);
    if (normalizedPos !== null) {
      content = possibleDefinition.trim();
      partOfSpeech = normalizedPos;
    }
    // 点不是有效词性时属于释义正文，不能替用户猜测其语义。
  }
  if (content.length === 0) {
    return [null, { lineNumber, message: "词性后必须填写释义", fragment: line }];
  }
  if (content.length > 50) {
    return [null, { lineNumber, message: "释义不得超过 50 个字符", fragment: line }];
  }
  const usage = hasSeparator && usagePart.trim().length > 0 ? usagePart : null;
  return [createStructuredMeaning(partOfSpeech, content, usage), null];
}

/**
 * 按空行、首行标题和点/竖线义项语法识别已经规范的条目块。
 *
 * 只把全部义项行都解析成功的块识别为候选；任何一个义项行有问题时整块进入 issues，
 * 保证候选"半成功入库"不会发生。
 */
export function parseEntryBlocks(rawText: string): EntryFormatParseResult {
  const candidates: EntryFormatCandidate[] = [];
  const issues: EntryFormatIssue[] = [];
  let blockLines: [number, string][] = [];

  const flush = (): void => {
    if (blockLines.length === 0) {
      return;
    }
    const firstLine = blockLines[0];
    if (firstLine === undefined) {
      return;
    }
    const [firstLineNumber, title] = firstLine;
    const originalBlock = blockLines.map(([, line]) => line).join("\n");
    if (title.trim().length === 0) {
      issues.push({ lineNumber: firstLineNumber, message: "条目标题不能为空", fragment: originalBlock });
      blockLines = [];
      return;
    }
    if (blockLines.length === 1) {
      issues.push({
        lineNumber: firstLineNumber,
        message: "条目至少需要一条释义",
        fragment: originalBlock,
      });
      blockLines = [];
      return;
    }
    const meanings: StructuredMeaning[] = [];
    for (const [lineNumber, line] of blockLines.slice(1)) {
      const [meaning, issue] = parseMeaningLine(lineNumber, line);
      if (issue !== null) {
        issues.push(issue);
      } else if (meaning !== null) {
        meanings.push(meaning);
      }
    }
    if (meanings.length === blockLines.length - 1) {
      candidates.push({
        lineNumber: firstLineNumber,
        title,
        meanings,
        originalBlock,
      });
    }
    blockLines = [];
  };

  // 与 Python str.splitlines 的常见形态对齐：识别 \n、\r\n 与孤立 \r 三种换行。
  const lines = rawText.split(/\r\n|\n|\r/);
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    if (rawLine === undefined || rawLine.trim().length === 0) {
      flush();
      continue;
    }
    blockLines.push([index + 1, rawLine]);
  }
  flush();
  return { candidates, issues };
}
