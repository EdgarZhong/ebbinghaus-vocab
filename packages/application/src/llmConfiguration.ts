/**
 * 大语言模型服务配置：后台供应商识别、解析优先级与脱敏辅助
 * （移植 V1 application/llm_configuration.py + bootstrap/configuration.py 的解析逻辑）。
 *
 * V2 口径（判断文件 A1 第 11–14 项【用户已定调】）：LLM 服务配置（Base URL/模型/
 * API Key/思考开关）是**设备本地数据**，读写走 `LlmConfigurationStore` 端口，绝不
 * 进入 settings 同步通道；API Key 加密落库由基础设施实现负责，应用层只持有明文或
 * null，且任何快照输出前必须先脱敏。
 *
 * 解析优先级（V1 test_llm_configuration.py 固化）：设备本地已存配置 > 环境变量首次
 * 填充 > 百炼默认值。环境变量只作首次填充默认值，一旦本地有记录就完全不覆盖——
 * 环境名常量保留 V1 形态（EBBINGHAUS_LLM_*），便于 Phase 3 组合根直接对接。
 * 供应商枚举只供后台协议适配使用，绝不进入设置页快照。
 */

import {
  LanguageModelNotConfiguredError,
} from "./errors.ts";
import type { EntryOrganizerService } from "./entryOrganizing.ts";
import type {
  LlmConfigurationRecord,
  LlmConfigurationStore,
  LlmConnectivityProbe,
  LlmOrganizerFactory,
} from "./ports.ts";

/** 通用 OpenAI 兼容协议的供应商键（后台协议适配用，不进设置页）。 */
export const OPENAI_COMPATIBLE_PROVIDER_KEY = "openai";

/** 默认服务地址：已验证的阿里云百炼兼容模式端点。 */
export const ALIYUN_BAILIAN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
/** Kimi 开放平台编码端点（后台识别用预设之一）。 */
export const KIMI_CODE_BASE_URL = "https://api.kimi.com/coding/v1";
/**
 * 默认模型必须支持本项目的 entry-organizer-v3 结构化输出契约；百炼模型卡显示通用
 * `deepseek-v4-flash` 支持结构化输出，而 `deepseek-v4-flash-0731` 快照不支持（V1 注记）。
 */
export const ALIYUN_BAILIAN_MODEL = "deepseek-v4-flash";

/** 环境变量首次填充的键名（与 V1 保持一致，组合根负责从运行环境读取）。 */
export const LLM_API_KEY_ENVIRONMENT_VARIABLE = "EBBINGHAUS_LLM_API_KEY";
export const LLM_BASE_URL_ENVIRONMENT_VARIABLE = "EBBINGHAUS_LLM_BASE_URL";
export const LLM_MODEL_ENVIRONMENT_VARIABLE = "EBBINGHAUS_LLM_MODEL";

/** 后台协议适配使用的供应商类别；枚举值不得作为设置页选项暴露。 */
export const LlmProvider = {
  AliyunBailian: "aliyun_bailian",
  KimiCode: "kimi_code",
  OpenAiCompatible: "openai_compatible",
} as const;
export type LlmProvider = (typeof LlmProvider)[keyof typeof LlmProvider];

/** 根据规范化 Base URL 识别后台供应商；未知地址走通用兼容协议。 */
export function identifyLlmProvider(baseUrl: string): LlmProvider {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (normalized === ALIYUN_BAILIAN_BASE_URL) {
    return LlmProvider.AliyunBailian;
  }
  if (normalized === KIMI_CODE_BASE_URL) {
    return LlmProvider.KimiCode;
  }
  return LlmProvider.OpenAiCompatible;
}

/**
 * 对明文 API 密钥脱敏，保留前三位与末四位以便用户辨认。
 *
 * null/空字符串返回空字符串；长度不超过 7 的短密钥全部以星号替代（星号数量随
 * 长度变化，避免泄露原长以外的信息），绝不返回任何明文。
 */
export function maskApiKey(apiKey: string | null | undefined): string {
  if (!apiKey) {
    return "";
  }
  if (apiKey.length <= 7) {
    return "*".repeat(apiKey.length);
  }
  return `${apiKey.slice(0, 3)}${"*".repeat(apiKey.length - 7)}${apiKey.slice(-4)}`;
}

/** 解析完成的服务配置（供整理器工厂与连通性探测消费）。 */
export interface ResolvedLlmConfiguration {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string | null;
  readonly thinkingEnabled: boolean;
  readonly provider: LlmProvider;
}

/**
 * 数据库优先解析 LLM 服务配置；本地无记录时用环境变量首填。
 *
 * 本地已保存的配置完全覆盖环境变量（环境变量不得覆盖库内的地址、模型或密钥）；
 * 本地与环境变量都无 API 密钥时返回 apiKey=null；思考开关只来自本地记录，
 * 环境变量填充路径恒为 true（V1 bootstrap 口径）。
 *
 * `environment` 是调用方显式传入的环境变量映射：应用层禁止读取 process.env，
 * 组合根负责在边界处注入（保证可测试与浏览器模式可用）。
 */
export function resolveLlmConfiguration(input: {
  readonly stored: LlmConfigurationRecord | null;
  readonly environment: Readonly<Record<string, string>>;
}): ResolvedLlmConfiguration {
  const stored = input.stored;
  if (stored !== null) {
    const baseUrl = stored.baseUrl || ALIYUN_BAILIAN_BASE_URL;
    // V1 口径：空字符串密钥等价于未配置（`stored.get("api_key") or None`）。
    const apiKey = stored.apiKey ? stored.apiKey : null;
    return {
      baseUrl,
      model: stored.modelName || ALIYUN_BAILIAN_MODEL,
      apiKey,
      thinkingEnabled: stored.thinkingEnabled,
      provider: identifyLlmProvider(baseUrl),
    };
  }
  const rawBaseUrl = input.environment[LLM_BASE_URL_ENVIRONMENT_VARIABLE] ?? "";
  const rawModel = input.environment[LLM_MODEL_ENVIRONMENT_VARIABLE] ?? "";
  const rawApiKey = input.environment[LLM_API_KEY_ENVIRONMENT_VARIABLE] ?? "";
  const baseUrl = (rawBaseUrl || ALIYUN_BAILIAN_BASE_URL).trim() || ALIYUN_BAILIAN_BASE_URL;
  const model = (rawModel || ALIYUN_BAILIAN_MODEL).trim() || ALIYUN_BAILIAN_MODEL;
  return {
    baseUrl,
    model,
    apiKey: rawApiKey ? rawApiKey : null,
    thinkingEnabled: true,
    provider: identifyLlmProvider(baseUrl),
  };
}

/** 设置页 LLM 配置快照的字段集合（V1 测试固化：恰好这五个键，绝无明文密钥）。 */
export interface LlmConfigurationSnapshot {
  readonly baseUrl: string;
  readonly modelName: string;
  readonly maskedApiKey: string;
  readonly hasApiKey: boolean;
  readonly thinkingEnabled: boolean;
}

/** LLM 配置用例依赖（活动整理器与工厂可选：未组装动态端口的宿主保持兼容）。 */
export interface LlmConfigurationServiceDeps {
  readonly configurationStore: LlmConfigurationStore;
  /** 配置事务提交后用新配置重建活动整理器的工厂；未注入时保存后不替换整理器。 */
  readonly organizerFactory?: LlmOrganizerFactory | null;
  /** 当前活动整理服务；与工厂同时注入时，保存后立即切换新连接。 */
  readonly entryOrganizer?: EntryOrganizerService | null;
  /** 连通性探测；未注入时连接测试明确报不可用（V1 行为）。 */
  readonly connectivityProbe?: LlmConnectivityProbe | null;
}

export class LlmConfigurationService {
  private readonly deps: LlmConfigurationServiceDeps;

  constructor(deps: LlmConfigurationServiceDeps) {
    this.deps = deps;
  }

  /**
   * 返回设置页快照：思考开关可见、内部供应商不泄漏、密钥脱敏后展示。
   * 无本地记录时直接展示百炼首填值，但 `hasApiKey=false`——绝不假装已配置密钥。
   */
  configurationSnapshot(): LlmConfigurationSnapshot {
    const stored = this.deps.configurationStore.load();
    const baseUrl = stored?.baseUrl || ALIYUN_BAILIAN_BASE_URL;
    const modelName = stored?.modelName || ALIYUN_BAILIAN_MODEL;
    const apiKey = stored?.apiKey ?? null;
    const thinkingEnabled = stored ? stored.thinkingEnabled : true;
    return {
      baseUrl,
      modelName,
      maskedApiKey: maskApiKey(typeof apiKey === "string" ? apiKey : null),
      hasApiKey: Boolean(apiKey),
      thinkingEnabled,
    };
  }

  /**
   * 保存配置并返回新快照；`apiKey: null` 表示保留既有密钥（V1 保存口径）。
   * 保存事务成功后立即用新配置重建活动整理器，下一次请求即刻生效，同时不影响
   * 已经在执行的旧请求（替换的是端口引用，不是进行中的调用）。
   */
  saveConfiguration(input: {
    readonly baseUrl: string;
    readonly modelName: string;
    readonly apiKey: string | null;
    readonly thinkingEnabled: boolean;
  }): LlmConfigurationSnapshot {
    this.deps.configurationStore.save({
      baseUrl: input.baseUrl,
      modelName: input.modelName,
      apiKey: input.apiKey,
      thinkingEnabled: input.thinkingEnabled,
    });
    const snapshot = this.configurationSnapshot();
    this.replaceActiveOrganizer();
    return snapshot;
  }

  /**
   * 清空 API Key 并返回新快照；省略思考开关时保留本地既有值。
   * Base URL 与模型保留本地记录（无记录时回退百炼默认），"清空并重填"只影响密钥。
   */
  clearApiKey(input?: { readonly thinkingEnabled?: boolean | null }): LlmConfigurationSnapshot {
    const stored = this.deps.configurationStore.load();
    const baseUrl = stored?.baseUrl || ALIYUN_BAILIAN_BASE_URL;
    const modelName = stored?.modelName || ALIYUN_BAILIAN_MODEL;
    const thinkingEnabled =
      input?.thinkingEnabled === null || input?.thinkingEnabled === undefined
        ? stored
          ? stored.thinkingEnabled
          : true
        : input.thinkingEnabled;
    // 空字符串 = 清空密钥（存储端口契约，见 LlmConfigurationStore）。
    this.deps.configurationStore.save({
      baseUrl,
      modelName,
      apiKey: "",
      thinkingEnabled,
    });
    const snapshot = this.configurationSnapshot();
    this.replaceActiveOrganizer();
    return snapshot;
  }

  /**
   * 准备一次连通性测试：在当前调用上下文读取已保存配置并返回探测闭包。
   *
   * V1 语义：SQLite 读取只能在主线程发生，因此配置读取必须在准备阶段完成；返回的
   * 闭包只携带三字段值，可安全交给工作线程执行（V2 中组合根据此保持同语义）。
   * 闭包执行探测成功返回用户可读提示；探测抛出的错误原样透传，绝不吞掉或改写。
   * 组合根未注入探测时明确报不可用，而不是静默成功或抛出裸属性错误。
   */
  prepareConnectionTest(): () => string {
    const probe = this.deps.connectivityProbe;
    if (!probe) {
      throw new LanguageModelNotConfiguredError("当前运行环境不支持大语言模型连通性测试");
    }
    const stored = this.deps.configurationStore.load();
    const baseUrl = stored?.baseUrl || ALIYUN_BAILIAN_BASE_URL;
    const modelName = stored?.modelName || ALIYUN_BAILIAN_MODEL;
    const apiKey = typeof stored?.apiKey === "string" && stored.apiKey ? stored.apiKey : null;
    return () => {
      probe.probe(baseUrl, modelName, apiKey);
      return "连接成功，大语言模型服务可用";
    };
  }

  /**
   * 用本地最新配置重建活动整理器；未组装动态端口（无工厂或无整理服务）的宿主
   * 保持兼容、直接跳过。重新从存储读取密钥只在应用层内部发生，绝不返回给界面。
   */
  private replaceActiveOrganizer(): void {
    const factory = this.deps.organizerFactory;
    const organizerService = this.deps.entryOrganizer;
    if (!factory || !organizerService) {
      return;
    }
    const stored = this.deps.configurationStore.load();
    const resolved = resolveLlmConfiguration({ stored, environment: {} });
    const organizer = factory.build({
      baseUrl: resolved.baseUrl,
      modelName: resolved.model,
      apiKey: resolved.apiKey,
      thinkingEnabled: resolved.thinkingEnabled,
    });
    organizerService.replaceOrganizer(organizer);
  }
}
