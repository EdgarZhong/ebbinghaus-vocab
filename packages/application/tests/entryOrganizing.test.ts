/**
 * 两种学习模式共用的唯一智能整理用例测试（移植 V1
 * tests/unit/application/test_unified_entry_workflow.py 与
 * test_regular_entry_organizing.py 的行为口径）。
 *
 * 覆盖口径：
 * - 统一整理入口只接收原文并原样返回领域证据树，不接收学习模式、Space、Unit 或
 *   List 等位置数据；
 * - 三道统一边界：空白原文先拒绝、未配置整理端口报 LanguageModelNotConfiguredError、
 *   空候选报 LanguageModelOrganizationError（两种模式绝不各写一套）；
 * - 失败不静默丢行：模型结果校验失败（证据定位失败等）原样传播携带定位信息的问题
 *   清单，绝不退回"把自由文本当规范条目解析"的旧路径；
 * - ConfirmedEntry：统一字段 term，旧关键字 originalSpelling/title 只保留为只读
 *   别名；英文词条与中文释义的统一校验规则；
 * - 审计访问器（provider/model/promptVersion/lastInteractionCount）与取消转发、
 *   整理端口热替换。
 */
import { describe, expect, it } from "vitest";

import {
  ENTRY_ORGANIZER_SCHEMA_VERSION,
  EntryOrganizingValidationError,
  OrganizingIssueCategory,
  PartOfSpeech,
  validateEntryOrganizerPayload,
  type EntryOrganizationResult,
  type StructuredMeaning,
} from "@ebbinghaus/domain";

import { ConfirmedEntry, EntryOrganizerService } from "../src/entryOrganizing.ts";
import {
  LanguageModelNotConfiguredError,
  LanguageModelOrganizationError,
} from "../src/errors.ts";
import type { LanguageModelOrganizerPort } from "../src/ports.ts";

/** 合法 v3 载荷（与 V1 测试同源的证据形态：term/词性/释义均携带原文引用）。 */
function v3Payload(entries: unknown[] = [
  {
    term: { value: "mentor", source_excerpt: "mentor" },
    meanings: [
      {
        part_of_speech: { value: "n.", source_excerpt: "名词" },
        definition: { value: "导师", source_excerpt: "导师" },
        usage: null,
      },
    ],
  },
]): Record<string, unknown> {
  return {
    schema_version: ENTRY_ORGANIZER_SCHEMA_VERSION,
    global_warning: null,
    entries,
  };
}

/** 经领域 v3 复验构造合法整理结果（与真实模型适配器输出同一形态）。 */
function organizedResult(rawText: string, payload: Record<string, unknown>): EntryOrganizationResult {
  return validateEntryOrganizerPayload(rawText, payload);
}

/** 从整理候选构造确认条目（UI 确认页的正式输入路径）。 */
function confirmedEntryFrom(result: EntryOrganizationResult): ConfirmedEntry {
  const candidate = result.candidates[0]!;
  return new ConfirmedEntry(
    candidate.term.value as string,
    candidate.meanings.map((meaning) => meaning.meaning),
  );
}

/** 记录原文并返回同一领域结果的可控整理端口（带审计属性与取消标记）。 */
class RecordingOrganizer implements LanguageModelOrganizerPort {
  public readonly provider = "测试服务";
  public readonly model = "test-model";
  public readonly promptVersion = "test-prompt-v3";
  public readonly lastInteractionCount = 2;
  public prepareCalls = 0;
  public cancelCalls = 0;
  public calls: string[] = [];

  constructor(private readonly result: EntryOrganizationResult) {}

  organize(rawText: string): EntryOrganizationResult {
    this.calls.push(rawText);
    return this.result;
  }

  prepareCancellation(): void {
    this.prepareCalls += 1;
  }

  cancel(): void {
    this.cancelCalls += 1;
  }
}

/** 抛出指定错误的整理端口：模拟模型结果校验失败路径。 */
class ThrowingOrganizer implements LanguageModelOrganizerPort {
  public calls: string[] = [];

  constructor(private readonly error: unknown) {}

  organize(rawText: string): EntryOrganizationResult {
    this.calls.push(rawText);
    throw this.error;
  }
}

describe("统一整理入口：原样返回领域证据树", () => {
  it("整理用例只接收原文，不接收学习模式、Space、Unit 或 List 等位置数据", () => {
    const rawText = "mentor 名词 导师";
    const expected = organizedResult(rawText, v3Payload());
    const organizer = new RecordingOrganizer(expected);
    const service = new EntryOrganizerService(organizer);

    // organize 的签名只有一个原文参数：位置数据没有进入模型请求的通道。
    const actual = service.organize(rawText);

    expect(actual).toBe(expected);
    expect(organizer.calls).toEqual([rawText]);
  });

  it("候选证据树完整保留：词条、义项与原文引用不丢失", () => {
    const rawText = "mentor 名词 导师";
    const service = new EntryOrganizerService(new RecordingOrganizer(organizedResult(rawText, v3Payload())));

    const result = service.organize(rawText);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.title).toBe("mentor");
    expect(result.candidates[0]?.meanings).toHaveLength(1);
    expect(result.candidates[0]?.meanings[0]?.meaningSourceExcerpt).toBe("导师");
    expect(result.globalWarning).toBeNull();
  });
});

describe("统一整理入口：三道边界（两种模式共用）", () => {
  it("空白原文先拒绝，绝不把空白转写发给模型", () => {
    const organizer = new RecordingOrganizer(organizedResult("mentor 名词 导师", v3Payload()));
    const service = new EntryOrganizerService(organizer);

    expect(() => service.organize(" \n\t")).toThrow("请先输入要整理的内容");
    expect(organizer.calls).toEqual([]);
  });

  it("未配置整理端口时报 LanguageModelNotConfiguredError，两种模式同一文案", () => {
    const service = new EntryOrganizerService(null);

    expect(() => service.organize("mentor")).toThrow("未配置智能整理服务");
    try {
      service.organize("mentor");
    } catch (error) {
      expect(error).toBeInstanceOf(LanguageModelNotConfiguredError);
      expect(error).toBeInstanceOf(LanguageModelOrganizationError);
    }
  });

  it("模型未识别到任何条目时报 LanguageModelOrganizationError", () => {
    const rawText = "只有课堂噪声";
    const empty = organizedResult(rawText, v3Payload([]));
    const service = new EntryOrganizerService(new RecordingOrganizer(empty));

    expect(() => service.organize(rawText)).toThrow("没有识别到可填写的条目");
  });
});

describe("失败不静默丢行：错误定位保留", () => {
  it("模型结果校验失败原样传播：问题清单携带分类码与词条定位，不回退本地解析", () => {
    const rawText = "完全无关的课堂转写";
    // 领域 v3 校验器对坏载荷抛出的问题清单：term 证据引用了原文中不存在的文本，
    // 每个字段值必须可追溯——证据定位失败的词条不能被静默丢弃或改写。
    let domainError: unknown = null;
    try {
      validateEntryOrganizerPayload(
        rawText,
        v3Payload([
          {
            term: { value: "mentor", source_excerpt: "原文中根本不存在这句话" },
            meanings: [
              {
                part_of_speech: { value: "n.", source_excerpt: "名词" },
                definition: { value: "导师", source_excerpt: "导师" },
                usage: null,
              },
            ],
          },
        ]),
      );
    } catch (error) {
      domainError = error;
    }
    expect(domainError).toBeInstanceOf(EntryOrganizingValidationError);
    const issues = (domainError as EntryOrganizingValidationError).issues;
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((issue) => issue.category === OrganizingIssueCategory.EvidenceNotFound)).toBe(true);
    expect(issues.some((issue) => issue.path.startsWith("entries[0]"))).toBe(true);

    // 应用层把模型适配器的失败原样抛给界面：没有第二套"本地规范解析"可以补救。
    const organizer = new ThrowingOrganizer(domainError);
    const service = new EntryOrganizerService(organizer);
    expect(() => service.organize(rawText)).toThrow(domainError as Error);
    expect(organizer.calls).toEqual([rawText]);
  });
});

describe("ConfirmedEntry：统一字段与校验规则", () => {
  it("从整理候选构造确认条目：term 规范化、义项结构化、manualMeaning 稳定文本", () => {
    const result = organizedResult("mentor 名词 导师", v3Payload());

    const confirmed = confirmedEntryFrom(result);

    expect(confirmed.term).toBe("mentor");
    expect(confirmed.meanings).toEqual([
      { partOfSpeech: PartOfSpeech.Noun, definition: "导师", usage: null },
    ]);
    expect(confirmed.manualMeaning).toBe("n. 导师");
  });

  it("旧关键字 originalSpelling/title 只是只读别名，三种构造方式等价", () => {
    const meanings: readonly StructuredMeaning[] = [
      { partOfSpeech: PartOfSpeech.Noun, definition: "导师", usage: null },
    ];

    const canonical = new ConfirmedEntry("mentor", meanings);
    const fromBook = new ConfirmedEntry(undefined, meanings, { originalSpelling: "mentor" });
    const fromRegular = new ConfirmedEntry(undefined, meanings, { title: "mentor" });

    expect(fromBook.term).toBe("mentor");
    expect(fromRegular.term).toBe("mentor");
    expect(canonical.term).toBe(canonical.originalSpelling);
    expect(canonical.originalSpelling).toBe(canonical.title);
  });

  it("term、originalSpelling、title 必须且只能提供一个", () => {
    const meanings: readonly StructuredMeaning[] = [
      { partOfSpeech: PartOfSpeech.Noun, definition: "导师", usage: null },
    ];

    expect(
      () => new ConfirmedEntry("mentor", meanings, { originalSpelling: "mentor" }),
    ).toThrow(TypeError);
    expect(() => new ConfirmedEntry(undefined, meanings, {})).toThrow(TypeError);
  });

  it("非英文词条被拒绝：仅允许英文字母、连字符、撇号和短语空格", () => {
    const meanings: readonly StructuredMeaning[] = [
      { partOfSpeech: PartOfSpeech.Noun, definition: "导师", usage: null },
    ];

    expect(() => new ConfirmedEntry("导师", meanings)).toThrow(/合法英文词条/);
    expect(() => new ConfirmedEntry("mentor2", meanings)).toThrow(/合法英文词条/);
  });

  it("释义必须包含可识别中文内容；待补充词性不得用于新保存的义项", () => {
    expect(
      () =>
        new ConfirmedEntry("mentor", [
          { partOfSpeech: PartOfSpeech.Noun, definition: "teacher", usage: null },
        ]),
    ).toThrow(/中文内容/);
    expect(
      () =>
        new ConfirmedEntry("mentor", [
          { partOfSpeech: PartOfSpeech.Unclassified, definition: "导师", usage: null },
        ]),
    ).toThrow(/待补充/);
  });

  it("至少需要一条结构化义项", () => {
    expect(() => new ConfirmedEntry("mentor", [])).toThrow(/至少需要一个结构化手录义项/);
  });

  it("多义项 manualMeaning 按“；”连接并保留词性前缀", () => {
    const confirmed = new ConfirmedEntry("take over", [
      { partOfSpeech: PartOfSpeech.TransitiveVerb, definition: "接管", usage: null },
      { partOfSpeech: PartOfSpeech.Noun, definition: "接手", usage: "接手项目" },
    ]);

    expect(confirmed.term).toBe("take over");
    expect(confirmed.manualMeaning).toBe("vt. 接管；n. 接手");
  });
});

describe("整理端口审计与生命周期", () => {
  it("审计访问器读取端口声明的提供方/模型/提示词版本/交互轮数", () => {
    const organizer = new RecordingOrganizer(organizedResult("mentor 名词 导师", v3Payload()));
    const service = new EntryOrganizerService(organizer);

    expect(service.isConfigured).toBe(true);
    expect(service.provider).toBe("测试服务");
    expect(service.model).toBe("test-model");
    expect(service.promptVersion).toBe("test-prompt-v3");
    expect(service.lastInteractionCount).toBe(2);
  });

  it("端口未声明审计属性时返回统一缺省值（交互轮数按 1 处理）", () => {
    const bare: LanguageModelOrganizerPort = {
      organize: () => organizedResult("mentor 名词 导师", v3Payload()),
    };
    const service = new EntryOrganizerService(bare);

    expect(service.provider).toBe("未声明");
    expect(service.model).toBe("未声明");
    expect(service.promptVersion).toBe("未声明");
    expect(service.lastInteractionCount).toBe(1);
  });

  it("prepareCancellation 与 cancel 转发给具体端口，不让应用层猜测实现细节", () => {
    const organizer = new RecordingOrganizer(organizedResult("mentor 名词 导师", v3Payload()));
    const service = new EntryOrganizerService(organizer);

    service.prepareCancellation();
    service.cancel();

    expect(organizer.prepareCalls).toBe(1);
    expect(organizer.cancelCalls).toBe(1);
  });

  it("端口未实现取消方法时静默跳过，不抛错", () => {
    const bare: LanguageModelOrganizerPort = {
      organize: () => organizedResult("mentor 名词 导师", v3Payload()),
    };
    const service = new EntryOrganizerService(bare);

    expect(() => {
      service.prepareCancellation();
      service.cancel();
    }).not.toThrow();
  });

  it("replaceOrganizer 热替换：设置事务提交后的下一次请求立即使用新端口", () => {
    const first = new RecordingOrganizer(organizedResult("mentor 名词 导师", v3Payload()));
    const second = new RecordingOrganizer(organizedResult("pupil 名词 学生", v3Payload([
      {
        term: { value: "pupil", source_excerpt: "pupil" },
        meanings: [
          {
            part_of_speech: { value: "n.", source_excerpt: "名词" },
            definition: { value: "学生", source_excerpt: "学生" },
            usage: null,
          },
        ],
      },
    ])));
    const service = new EntryOrganizerService(first);

    service.replaceOrganizer(second);
    service.organize("pupil 名词 学生");

    expect(first.calls).toEqual([]);
    expect(second.calls).toEqual(["pupil 名词 学生"]);

    // 替换为 null 等价未配置：下一次请求立即走未配置边界。
    service.replaceOrganizer(null);
    expect(() => service.organize("mentor")).toThrow("未配置智能整理服务");
  });
});
