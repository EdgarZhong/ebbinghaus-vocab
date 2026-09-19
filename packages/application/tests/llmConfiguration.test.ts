/**
 * LLM 服务配置（设备本地）用例测试。
 *
 * 逐项映射 V1 tests/unit/application/test_llm_configuration.py（V2 架构差异见各用例
 * 注释）：供应商后台识别、解析优先级（本地 > 环境变量首填 > 百炼默认）、脱敏、
 * 设置页快照五字段、保存后立即重建活动整理器、连通性测试的准备/透传/未装配语义。
 * V2 新增：null=保留密钥 / 空串=清空密钥的保存口径（ports.ts 存储合同）。
 */
import { describe, expect, it } from "vitest";

import {
  ALIYUN_BAILIAN_BASE_URL,
  ALIYUN_BAILIAN_MODEL,
  KIMI_CODE_BASE_URL,
  LLM_API_KEY_ENVIRONMENT_VARIABLE,
  LLM_BASE_URL_ENVIRONMENT_VARIABLE,
  LLM_MODEL_ENVIRONMENT_VARIABLE,
  LlmConfigurationService,
  LlmProvider,
  OPENAI_COMPATIBLE_PROVIDER_KEY,
  identifyLlmProvider,
  maskApiKey,
  resolveLlmConfiguration,
} from "../src/llmConfiguration.ts";
import { LanguageModelNotConfiguredError } from "../src/errors.ts";
import type { EntryOrganizerService } from "../src/entryOrganizing.ts";
import type {
  LlmConnectivityProbe,
  LlmOrganizerFactory,
} from "../src/ports.ts";
import { InMemoryLlmConfigurationStore } from "./helpers/fakes.ts";

/** 组装被测服务，捕获整理器工厂构建参数与活动整理服务替换行为。 */
function buildService(options?: {
  readonly stored?: Parameters<InMemoryLlmConfigurationStore["save"]>[0] | null;
  readonly probe?: LlmConnectivityProbe | null;
}) {
  const store = new InMemoryLlmConfigurationStore();
  if (options?.stored !== undefined && options.stored !== null) {
    store.save(options.stored);
  }
  const built: {
    readonly baseUrl: string;
    readonly modelName: string;
    readonly apiKey: string | null;
    readonly thinkingEnabled: boolean;
  }[] = [];
  const factory: LlmOrganizerFactory = {
    build(configuration) {
      built.push(configuration);
      return { organize: () => {
        throw new Error("假整理器不执行真实整理");
      } };
    },
  };
  const replaced: (LanguageModelOrganizerPortLike | null)[] = [];
  const entryOrganizer = {
    replaceOrganizer(organizer: LanguageModelOrganizerPortLike | null) {
      replaced.push(organizer);
    },
  } as unknown as EntryOrganizerService;
  const service = new LlmConfigurationService({
    configurationStore: store,
    organizerFactory: factory,
    entryOrganizer,
    connectivityProbe: options?.probe ?? null,
  });
  return { store, service, built, replaced };
}

/** 仅用于类型标注的整理器端口最小视图。 */
interface LanguageModelOrganizerPortLike {
  organize(rawText: string): unknown;
}

describe("供应商识别（后台协议适配）", () => {
  it("按规范化 Base URL 识别百炼、Kimi 与通用兼容协议，未知地址走通用兼容", () => {
    // V1 映射：test_provider_is_an_internal_enum_detected_only_from_base_url。
    expect(identifyLlmProvider(`  ${ALIYUN_BAILIAN_BASE_URL}/  `)).toBe(LlmProvider.AliyunBailian);
    expect(identifyLlmProvider(`${KIMI_CODE_BASE_URL}/`)).toBe(LlmProvider.KimiCode);
    expect(identifyLlmProvider("https://example.com/openai/v1")).toBe(LlmProvider.OpenAiCompatible);
    expect(OPENAI_COMPATIBLE_PROVIDER_KEY).toBe("openai");
  });
});

describe("配置解析优先级（本地 > 环境变量首填 > 百炼默认）", () => {
  it("本地已有配置时环境变量不得覆盖库内地址、模型或密钥", () => {
    // V1 映射：test_database_configuration_takes_priority_over_environment。
    const resolved = resolveLlmConfiguration({
      stored: {
        baseUrl: "https://db.example.com",
        modelName: "db-model",
        apiKey: "db-key",
        thinkingEnabled: false,
      },
      environment: {
        [LLM_API_KEY_ENVIRONMENT_VARIABLE]: "env-key",
        [LLM_BASE_URL_ENVIRONMENT_VARIABLE]: "https://env.example.com/v1",
        [LLM_MODEL_ENVIRONMENT_VARIABLE]: "env-model",
      },
    });

    expect(resolved.baseUrl).toBe("https://db.example.com");
    expect(resolved.model).toBe("db-model");
    expect(resolved.apiKey).toBe("db-key");
    expect(resolved.provider).toBe(LlmProvider.OpenAiCompatible);
    expect(resolved.thinkingEnabled).toBe(false);
  });

  it("本地无记录时环境变量作为首次填充默认值生效", () => {
    // V1 映射：test_environment_seeds_defaults_when_database_empty。
    const resolved = resolveLlmConfiguration({
      stored: null,
      environment: {
        [LLM_API_KEY_ENVIRONMENT_VARIABLE]: "env-key",
        [LLM_BASE_URL_ENVIRONMENT_VARIABLE]: "https://env.example.com/v1",
        [LLM_MODEL_ENVIRONMENT_VARIABLE]: "env-model",
      },
    });

    expect(resolved.baseUrl).toBe("https://env.example.com/v1");
    expect(resolved.model).toBe("env-model");
    expect(resolved.apiKey).toBe("env-key");
    // 环境变量填充路径的思考开关恒为 true（V1 bootstrap 口径）。
    expect(resolved.thinkingEnabled).toBe(true);
  });

  it("本地与环境变量都无配置时使用百炼默认值且密钥为 null", () => {
    // V1 映射：test_defaults_used_when_both_database_and_environment_empty。
    const resolved = resolveLlmConfiguration({ stored: null, environment: {} });

    expect(resolved.baseUrl).toBe(ALIYUN_BAILIAN_BASE_URL);
    expect(resolved.model).toBe(ALIYUN_BAILIAN_MODEL);
    expect(resolved.apiKey).toBeNull();
    expect(resolved.provider).toBe(LlmProvider.AliyunBailian);
    expect(resolved.thinkingEnabled).toBe(true);
  });

  it("本地记录的空字符串密钥等价于未配置（解析为 null）", () => {
    // V1 口径：`stored.get("api_key") or None`；空串是"清空"后的合法落库形态。
    const resolved = resolveLlmConfiguration({
      stored: {
        baseUrl: "",
        modelName: "",
        apiKey: "",
        thinkingEnabled: false,
      },
      environment: {},
    });

    // 空串地址/模型同样回退百炼默认。
    expect(resolved.baseUrl).toBe(ALIYUN_BAILIAN_BASE_URL);
    expect(resolved.model).toBe(ALIYUN_BAILIAN_MODEL);
    expect(resolved.apiKey).toBeNull();
  });
});

describe("API 密钥脱敏", () => {
  it("保留前三位与末四位，绝不返回明文", () => {
    // V1 映射：test_llm_configuration_snapshot_masks_api_key。
    const plaintext = "sk-test-secret-key-12345";
    const masked = maskApiKey(plaintext);

    expect(masked).not.toBe(plaintext);
    expect(masked).not.toContain(plaintext);
    expect(masked.startsWith("sk-")).toBe(true);
    expect(masked.endsWith("2345")).toBe(true);
    expect(masked).toContain("*");
  });

  it("null 与空字符串脱敏为空串；短密钥全部以星号替代", () => {
    expect(maskApiKey(null)).toBe("");
    expect(maskApiKey("")).toBe("");
    expect(maskApiKey("abc1234")).toBe("*******");
  });
});

describe("设置页快照", () => {
  it("快照恰好五个字段：含思考开关、脱敏密钥，不泄漏内部供应商与明文", () => {
    // V1 映射：test_desktop_snapshot_includes_thinking_switch_and_hides_internal_provider。
    const { service } = buildService({
      stored: {
        baseUrl: `${ALIYUN_BAILIAN_BASE_URL}/`,
        modelName: "stored-model",
        apiKey: "sk-secret-value-1234",
        thinkingEnabled: false,
      },
    });

    const snapshot = service.configurationSnapshot();

    expect(snapshot.baseUrl).toBe(`${ALIYUN_BAILIAN_BASE_URL}/`);
    expect(snapshot.modelName).toBe("stored-model");
    expect(snapshot.hasApiKey).toBe(true);
    expect(snapshot.thinkingEnabled).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain("sk-secret-value-1234");
    expect(Object.keys(snapshot).sort()).toEqual(
      ["baseUrl", "hasApiKey", "maskedApiKey", "modelName", "thinkingEnabled"],
    );
  });

  it("新安装快照展示百炼首填值，但不得假装已配置密钥", () => {
    // V1 映射：test_empty_desktop_snapshot_uses_bailian_and_reports_no_secret。
    const { service } = buildService();

    const snapshot = service.configurationSnapshot();

    expect(snapshot.baseUrl).toBe(ALIYUN_BAILIAN_BASE_URL);
    expect(snapshot.modelName).toBe(ALIYUN_BAILIAN_MODEL);
    expect(snapshot.maskedApiKey).toBe("");
    expect(snapshot.hasApiKey).toBe(false);
    expect(snapshot.thinkingEnabled).toBe(true);
  });
});

describe("保存配置与活动整理器重建", () => {
  it("保存后立即用新配置重建活动整理器；null 密钥保留既有密钥", () => {
    // V1 映射：test_saving_llm_configuration_replaces_active_organizer_immediately。
    // 保存口径（ports.ts LlmConfigurationRecord.apiKey 合同）：null = 保留既有密钥。
    const { service, built, replaced } = buildService({
      stored: {
        baseUrl: "https://old.example.com/v1",
        modelName: "old-model",
        apiKey: "old-key",
        thinkingEnabled: true,
      },
    });

    const snapshot = service.saveConfiguration({
      baseUrl: "https://new.example.com/v1",
      modelName: "new-model",
      apiKey: null,
      thinkingEnabled: false,
    });

    expect(snapshot.thinkingEnabled).toBe(false);
    expect(snapshot.hasApiKey).toBe(true);
    expect(built).toEqual([
      { baseUrl: "https://new.example.com/v1", modelName: "new-model", apiKey: "old-key", thinkingEnabled: false },
    ]);
    // 替换的是端口引用（活动整理器），不是进行中的调用。
    expect(replaced).toHaveLength(1);
  });

  it("未组装动态端口（无工厂或无整理服务）的宿主保存后保持兼容", () => {
    const store = new InMemoryLlmConfigurationStore();
    const service = new LlmConfigurationService({ configurationStore: store });

    const snapshot = service.saveConfiguration({
      baseUrl: "https://new.example.com/v1",
      modelName: "new-model",
      apiKey: "new-key",
      thinkingEnabled: true,
    });

    expect(snapshot.hasApiKey).toBe(true);
  });

  it("clearApiKey 清空密钥并保留地址、模型与思考开关", () => {
    const { service, built } = buildService({
      stored: {
        baseUrl: "https://db.example.com",
        modelName: "db-model",
        apiKey: "db-key",
        thinkingEnabled: false,
      },
    });

    const snapshot = service.clearApiKey();

    expect(snapshot.baseUrl).toBe("https://db.example.com");
    expect(snapshot.modelName).toBe("db-model");
    expect(snapshot.hasApiKey).toBe(false);
    expect(snapshot.thinkingEnabled).toBe(false);
    // 清空后重建的整理器拿到 null 密钥（空串在解析层等价未配置）。
    expect(built).toEqual([
      { baseUrl: "https://db.example.com", modelName: "db-model", apiKey: null, thinkingEnabled: false },
    ]);
  });

  it("clearApiKey 省略思考开关时保留本地既有值；无记录时回退默认并保持 true", () => {
    const withRecord = buildService({
      stored: { baseUrl: "https://db.example.com", modelName: "db-model", apiKey: "k", thinkingEnabled: true },
    });
    const snapshotWithRecord = withRecord.service.clearApiKey({ thinkingEnabled: null });
    expect(snapshotWithRecord.thinkingEnabled).toBe(true);

    const empty = buildService();
    const snapshotEmpty = empty.service.clearApiKey();
    expect(snapshotEmpty.baseUrl).toBe(ALIYUN_BAILIAN_BASE_URL);
    expect(snapshotEmpty.thinkingEnabled).toBe(true);
    expect(snapshotEmpty.hasApiKey).toBe(false);
  });
});

describe("连通性测试准备", () => {
  it("准备阶段读取已保存配置，闭包执行才探测，成功返回用户可读提示", () => {
    // V1 映射：test_prepare_llm_connection_test_reads_saved_config_on_calling_thread。
    const captured: { baseUrl: string; modelName: string; apiKey: string | null }[] = [];
    const { service } = buildService({
      stored: { baseUrl: "https://db.example.com", modelName: "db-model", apiKey: "db-key", thinkingEnabled: true },
      probe: {
        probe(baseUrl, modelName, apiKey) {
          captured.push({ baseUrl, modelName, apiKey });
        },
      },
    });

    const run = service.prepareConnectionTest();

    // 准备阶段只读配置，不发起探测。
    expect(captured).toEqual([]);
    expect(run()).toBe("连接成功，大语言模型服务可用");
    expect(captured).toEqual([{ baseUrl: "https://db.example.com", modelName: "db-model", apiKey: "db-key" }]);
  });

  it("库内无记录时使用百炼默认地址与模型，密钥为 null", () => {
    // V1 映射：test_prepare_llm_connection_test_uses_defaults_without_stored_config。
    const captured: { baseUrl: string; modelName: string; apiKey: string | null }[] = [];
    const { service } = buildService({
      probe: {
        probe(baseUrl, modelName, apiKey) {
          captured.push({ baseUrl, modelName, apiKey });
        },
      },
    });

    service.prepareConnectionTest()();

    expect(captured).toEqual([{ baseUrl: ALIYUN_BAILIAN_BASE_URL, modelName: ALIYUN_BAILIAN_MODEL, apiKey: null }]);
  });

  it("探测闭包抛出的用户可读错误原样透传，不得吞掉或改写", () => {
    // V1 映射：test_prepare_llm_connection_test_propagates_probe_failure。
    const { service } = buildService({
      probe: {
        probe() {
          throw new Error("无法连接大语言模型服务");
        },
      },
    });

    expect(() => service.prepareConnectionTest()()).toThrow("无法连接大语言模型服务");
  });

  it("组合根未注入探测时明确报不可用，而不是静默成功", () => {
    // V1 映射：test_prepare_llm_connection_test_without_probe_reports_unavailable。
    const { service } = buildService();

    expect(() => service.prepareConnectionTest()).toThrow(LanguageModelNotConfiguredError);
    expect(() => service.prepareConnectionTest()).toThrow(/连通性测试/);
  });
});
