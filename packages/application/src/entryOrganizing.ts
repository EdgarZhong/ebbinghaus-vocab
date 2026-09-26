/**
 * 两种学习模式共用的唯一智能整理应用用例（移植 V1 application/entry_organizing.py）。
 *
 * 设计要点（V1 定稿口径）：
 * - 整理用例不知道学习模式、Space、Unit 或 List：活动 Space 属于两种模式共同的保存
 *   隔离上下文，Unit/List 只属于词书保存边界；任何位置数据都不得进入模型请求或
 *   证据树。
 * - "解析失败不静默丢弃"由 domain 的 v3 证据树保证：每个字段值都携带 source_excerpt
 *   与定位 warning；应用层只负责输入非空边界、未配置边界与空结果边界三道闸门。
 * - `ConfirmedEntry` 是两种模式共用的最终可保存条目：统一字段名 term，旧关键字
 *   originalSpelling/title 只保留为只读别名（V1 UI 迁移兼容口径，行为测试固化）。
 */

import {
  containsChineseDefinition,
  formatStructuredMeanings,
  isValidEnglishEntryTerm,
  normalizeEntryTerm,
  PartOfSpeech,
  type EntryOrganizationResult,
  type StructuredMeaning,
} from "@ebbinghaus/domain";
import {
  LanguageModelNotConfiguredError,
  LanguageModelOrganizationError,
} from "./errors.ts";
import type { LanguageModelOrganizerPort } from "./ports.ts";

/**
 * 两种模式共用的最终可保存英文词条与结构化义项。
 *
 * 校验口径（与 V1 ConfirmedEntry 完全一致）：
 * - term、originalSpelling、title 必须且只能提供一个（TypeError）；
 * - term 规范化后必须能识别为合法英文词条（仅英文字母、连字符、撇号和短语空格）；
 * - 至少一条结构化义项；不得使用"待补充"词性；每条释义必须包含可识别中文内容。
 */
export class ConfirmedEntry {
  /** 唯一正式字段：规范化后的英文词条。 */
  public readonly term: string;
  public readonly meanings: readonly StructuredMeaning[];

  constructor(
    term?: string | null,
    meanings?: readonly StructuredMeaning[] | null,
    options?: {
      readonly originalSpelling?: string | null;
      readonly title?: string | null;
    },
  ) {
    // 兼容词书旧关键字 originalSpelling 与常规旧关键字 title：三者必须且只能提供一个。
    const suppliedTerms = [
      ...(term !== null && term !== undefined ? [term] : []),
      ...(options?.originalSpelling !== null && options?.originalSpelling !== undefined
        ? [options.originalSpelling]
        : []),
      ...(options?.title !== null && options?.title !== undefined ? [options.title] : []),
    ];
    if (suppliedTerms.length !== 1) {
      throw new TypeError("term、originalSpelling、title 必须且只能提供一个");
    }
    if (meanings === null || meanings === undefined) {
      throw new TypeError("meanings 必须提供");
    }
    const normalizedTerm = normalizeEntryTerm(suppliedTerms[0] as string);
    if (!isValidEnglishEntryTerm(normalizedTerm)) {
      throw new Error(
        "无法识别合法英文词条；仅允许英文字母、连字符、撇号和短语空格",
      );
    }
    if (meanings.length === 0) {
      throw new Error("Word 至少需要一个结构化手录义项");
    }
    for (const meaning of meanings) {
      // "待补充"只用于无损迁移旧数据；新保存的义项必须携带正式词性或留空。
      if (meaning.partOfSpeech === PartOfSpeech.Unclassified) {
        throw new Error("新保存的结构化手录义项不能使用待补充词性");
      }
      if (!containsChineseDefinition(meaning.definition)) {
        throw new Error("结构化手录义项必须包含可识别的中文内容");
      }
    }
    this.term = normalizedTerm;
    this.meanings = [...meanings];
    Object.freeze(this);
    Object.freeze(this.meanings);
  }

  /** 兼容词书旧调用的只读别名；正式字段统一为 term。 */
  get originalSpelling(): string {
    return this.term;
  }

  /** 兼容常规模式旧调用的只读别名；正式字段统一为 term。 */
  get title(): string {
    return this.term;
  }

  /** 形成最终学习数据使用的稳定义项文本。 */
  get manualMeaning(): string {
    return formatStructuredMeanings(this.meanings);
  }
}

/**
 * 把模式无关的原始转写交给唯一整理端口并返回完整 v3 证据树。
 *
 * 三道统一边界（两种模式绝不各写一套）：
 * 1. 空白原文直接拒绝（"请先输入要整理的内容"），绝不把空白转写发给模型；
 * 2. 未配置整理端口时抛 LanguageModelNotConfiguredError（"未配置智能整理服务"）；
 * 3. 模型未识别到任何条目时抛 LanguageModelOrganizationError（"没有识别到可填写的条目"）。
 */
export class EntryOrganizerService {
  private organizer: LanguageModelOrganizerPort | null;

  constructor(organizer: LanguageModelOrganizerPort | null) {
    this.organizer = organizer;
  }

  /** 是否存在实际整理端口；不检查或暴露端口中的 API 密钥。 */
  get isConfigured(): boolean {
    return this.organizer !== null;
  }

  /** 逻辑提供方标识（解析审计用），不向 UI 提供供应商选项。 */
  get provider(): unknown {
    return readPortProperty(this.organizer, "provider", "未声明");
  }

  /** 模型标识（解析审计用）。 */
  get model(): unknown {
    return readPortProperty(this.organizer, "model", "未声明");
  }

  /** 系统提示词版本（解析审计用）。 */
  get promptVersion(): unknown {
    return readPortProperty(this.organizer, "promptVersion", "未声明");
  }

  /** 最近一次整理的交互轮数；端口未声明时按 1 处理（V1 兼容口径）。 */
  get lastInteractionCount(): unknown {
    return readPortProperty(this.organizer, "lastInteractionCount", 1);
  }

  /** 执行两种模式完全相同的非空校验、模型调用和空结果校验。 */
  async organize(rawText: string): Promise<EntryOrganizationResult> {
    EntryOrganizerService.validateRawText(rawText);
    if (this.organizer === null) {
      throw new LanguageModelNotConfiguredError("未配置智能整理服务");
    }
    const result = await this.organizer.organize(rawText);
    if (result.candidates.length === 0) {
      throw new LanguageModelOrganizationError("没有识别到可填写的条目");
    }
    return result;
  }

  /** 替换当前活动整理适配器，使设置事务提交后的下一次请求立即使用新配置。 */
  replaceOrganizer(organizer: LanguageModelOrganizerPort | null): void {
    this.organizer = organizer;
  }

  /** 在 UI 启动新整理前清除适配器上一轮的取消标记（端口未实现时静默跳过）。 */
  prepareCancellation(): void {
    this.organizer?.prepareCancellation?.();
  }

  /** 向具体整理适配器转发用户取消，不让应用层猜测 HTTP 实现细节。 */
  cancel(): void {
    this.organizer?.cancel?.();
  }

  /** 定义唯一的智能整理输入边界，供需要先落草稿的词书编排提前复用。 */
  static validateRawText(rawText: string): void {
    if (rawText.trim().length === 0) {
      throw new Error("请先输入要整理的内容");
    }
  }
}

/** 读取整理端口上可选的审计属性；端口未声明时返回统一缺省值。 */
function readPortProperty(
  organizer: LanguageModelOrganizerPort | null,
  key: string,
  fallback: unknown,
): unknown {
  const value = (organizer as Record<string, unknown> | null)?.[key];
  return value === undefined ? fallback : value;
}

// ---------------------------------------------------------------------------
// 冲突语义（两种学习模式共用）
// ---------------------------------------------------------------------------

/**
 * 保存时检测到的词条冲突：目标范围内已存在同一规范键的词条。
 * 两种学习模式共用同一冲突语义：词书模式按 List 检测，常规模式按 Space 检测。
 */
export interface ConflictingWord {
  readonly normalizedKey: string;
  readonly existingWordId: string;
  readonly existingSpelling: string;
  readonly incomingSpelling: string;
}

/**
 * 用户对一条词条冲突的独立决定。
 * `removeExisting` 为真表示软移除范围内已有的旧条目后录入本次新条目（覆盖）；
 * 为假表示保留旧条目、本次冲突词条不录入。
 */
export interface WordConflictResolution {
  readonly normalizedKey: string;
  readonly removeExisting: boolean;
}
