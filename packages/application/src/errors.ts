/**
 * 应用层统一错误类型（移植 V1 ports.py 与各用例的错误语义）。
 *
 * 错误信息全部是可直接展示给用户的中文文案：界面按错误类型决定展示方式，不解析
 * 错误消息文本。所有错误都继承 Error，保持 `instanceof` 可判定。
 */

import type { ConflictingWord } from "./entryOrganizing.ts";

/**
 * 大语言模型整理未能返回可复验结果的统一应用错误。
 *
 * `partialPayload` 只在结构修复耗尽时携带最后一版合并结果（含已通过的词条），
 * 供失败草稿审计保留"本次成果"；它从未通过本地复验，绝不进入保存或正式数据
 * （V1 LanguageModelOrganizationError 口径）。
 */
export class LanguageModelOrganizationError extends Error {
  public readonly partialPayload: unknown;

  constructor(message: string, options?: { readonly partialPayload?: unknown }) {
    super(message);
    this.name = "LanguageModelOrganizationError";
    this.partialPayload = options?.partialPayload ?? null;
  }
}

/** 本机没有配置智能整理服务（API Key 或必要模型信息缺失）。 */
export class LanguageModelNotConfiguredError extends LanguageModelOrganizationError {
  constructor(message: string) {
    super(message);
    this.name = "LanguageModelNotConfiguredError";
  }
}

/** 用户主动取消本次整理请求。 */
export class LanguageModelCancelledError extends LanguageModelOrganizationError {
  constructor(message: string) {
    super(message);
    this.name = "LanguageModelCancelledError";
  }
}

/** 在线词典查询未返回可缓存释义的统一应用错误。 */
export class DictionaryLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DictionaryLookupError";
  }
}

/** 在线词典请求超过组合根配置的最大等待时间。 */
export class DictionaryLookupTimeoutError extends DictionaryLookupError {
  constructor(message: string) {
    super(message);
    this.name = "DictionaryLookupTimeoutError";
  }
}

/** 网络断开、域名解析或远端连接失败。 */
export class DictionaryLookupNetworkError extends DictionaryLookupError {
  constructor(message: string) {
    super(message);
    this.name = "DictionaryLookupNetworkError";
  }
}

/** 远端响应结构变化、词条缺失或不含可识别中文释义。 */
export class DictionaryLookupResponseError extends DictionaryLookupError {
  constructor(message: string) {
    super(message);
    this.name = "DictionaryLookupResponseError";
  }
}

/** 页面切换或新查询替代旧查询后，调用方取消本次结果。 */
export class DictionaryLookupCancelledError extends DictionaryLookupError {
  constructor(message: string) {
    super(message);
    this.name = "DictionaryLookupCancelledError";
  }
}

/**
 * 常规模式 Space 内存在未被用户处理的条目冲突。
 *
 * 冲突必须逐条交由用户选择"覆盖"（软移除旧条目后录入新条目）或"本次不录入"，
 * 未覆盖全部冲突前禁止写入——禁止静默覆盖既有学习数据（V1 SpaceEntryConflictError）。
 */
export class SpaceEntryConflictError extends Error {
  public readonly conflicts: readonly ConflictingWord[];

  constructor(message: string, conflicts: readonly ConflictingWord[] = []) {
    super(message);
    this.name = "SpaceEntryConflictError";
    this.conflicts = conflicts;
  }
}

/** 词书复习测试用例无法继续时向界面提供的可理解错误。 */
export class ReviewTestingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewTestingError";
  }
}
