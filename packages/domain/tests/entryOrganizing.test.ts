/**
 * `entry-organizer-v3` 统一证据树的纯领域回归测试
 * （映射 V1 tests/unit/domain/test_entry_organizing.py，逐函数对应）。
 */
import { describe, expect, it } from "vitest";

import {
  ENTRY_ORGANIZER_SCHEMA_VERSION,
  OrganizingIssueCategory,
  collectEntryOrganizingIssues,
  issueCategoryLabel,
  validateEntryOrganizerPayload,
  type EntryOrganizingIssue,
} from "../src/entryOrganizing.ts";
import { PartOfSpeech } from "../src/meanings.ts";

// ---------------------------------------------------------------------------
// 载荷构造与导航辅助：严格索引模式下统一在此做非空断言，用例保持与 V1 一一对应。
// ---------------------------------------------------------------------------

type Payload = Record<string, unknown>;

/** 构造一个证据节点（warning 可选）。 */
function node(value: unknown, sourceExcerpt: unknown, warning?: string | null): Payload {
  const result: Payload = { value, source_excerpt: sourceExcerpt };
  if (warning !== undefined && warning !== null) {
    result["warning"] = warning;
  }
  return result;
}

/** 构造一份最小合法 v3 载荷（mentor / n. / 导师）。 */
function validPayload(): Payload {
  return {
    schema_version: ENTRY_ORGANIZER_SCHEMA_VERSION,
    global_warning: null,
    entries: [
      {
        term: node("mentor", "mentor"),
        meanings: [
          {
            part_of_speech: node("n.", "名词"),
            definition: node("导师", "导师"),
            usage: null,
          },
        ],
      },
    ],
  };
}

function entriesOf(payload: Payload): Payload[] {
  return payload["entries"] as Payload[];
}

function entryAt(payload: Payload, index: number): Payload {
  const entry = entriesOf(payload)[index];
  if (entry === undefined) {
    throw new Error(`测试载荷缺少词条 ${index}`);
  }
  return entry;
}

function meaningsOf(entry: Payload): Payload[] {
  return entry["meanings"] as Payload[];
}

function meaningAt(entry: Payload, index: number): Payload {
  const meaning = meaningsOf(entry)[index];
  if (meaning === undefined) {
    throw new Error(`测试载荷缺少义项 ${index}`);
  }
  return meaning;
}

function definitionNodeOf(meaning: Payload): Payload {
  return meaning["definition"] as Payload;
}

function partOfSpeechNodeOf(meaning: Payload): Payload {
  return meaning["part_of_speech"] as Payload;
}

/** 执行校验并捕获错误信息（无错误时返回空串，断言由用例完成）。 */
function validationErrorMessage(rawText: string, payload: unknown): string {
  try {
    validateEntryOrganizerPayload(rawText, payload);
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("v3 证据树：结构保持与不可变性", () => {
  it("词条、多个义项和义项级多行 usage 都必须保持节点归属与定位范围", () => {
    const rawText =
      "distinction 名词 差别区分 名词 荣誉。" +
      "conjunction 名词 同时发生 in conjunction with\n" +
      "Guilt emerges in conjunction with a child's growing grasp of moral norms。";
    const payload = {
      schema_version: ENTRY_ORGANIZER_SCHEMA_VERSION,
      global_warning: "请核对本轮语音转写。",
      entries: [
        {
          term: node("distinction", "distinction", "词条存在语音歧义，请核对。"),
          meanings: [
            {
              part_of_speech: node("n.", "名词"),
              definition: node("差别区分", "差别区分", "释义边界请核对。"),
              usage: null,
            },
            {
              part_of_speech: node("n.", "名词"),
              definition: node("荣誉", "荣誉"),
              usage: null,
            },
          ],
        },
        {
          term: node("conjunction", "conjunction"),
          meanings: [
            {
              part_of_speech: node("n.", "名词"),
              definition: node("同时发生", "同时发生"),
              usage: node(
                "in conjunction with\n与……同时\n" +
                  "Guilt emerges in conjunction with a child's growing grasp " +
                  "of moral norms。",
                "in conjunction with\n" +
                  "Guilt emerges in conjunction with a child's growing grasp " +
                  "of moral norms。",
              ),
            },
          ],
        },
      ],
    };

    const result = validateEntryOrganizerPayload(rawText, payload);

    expect(result.globalWarning).toBe("请核对本轮语音转写。");
    expect(Object.hasOwn(result, "unresolved_fragments")).toBe(false);
    const distinction = result.candidates[0];
    expect(distinction?.term.value).toBe("distinction");
    expect(distinction?.term.warning).toBe("词条存在语音歧义，请核对。");
    expect(distinction?.meanings[0]?.partOfSpeech.value).toBe(PartOfSpeech.Noun);
    expect(distinction?.meanings[0]?.definition.warning).toBe("释义边界请核对。");
    expect(distinction?.meanings[1]?.definition.value).toBe("荣誉");
    const conjunctionUsage = result.candidates[1]?.meanings[0]?.usage;
    expect(conjunctionUsage).toBeDefined();
    const usageValue = conjunctionUsage?.value ?? "";
    const usageExcerpt = conjunctionUsage?.sourceExcerpt ?? "";
    expect(usageValue.startsWith("in conjunction with\n与……同时")).toBe(true);
    expect(conjunctionUsage?.sourceStart).toBe(rawText.indexOf(usageExcerpt));
    expect(conjunctionUsage?.sourceEnd).toBe((conjunctionUsage?.sourceStart ?? 0) + usageExcerpt.length);
    expect(distinction?.meanings[0]?.meaning.partOfSpeech).toBe(PartOfSpeech.Noun);
    expect(distinction?.meanings[0]?.meaning.definition).toBe("差别区分");
    expect(distinction?.meanings[0]?.meaningSourceExcerpt).toBe("差别区分");
  });

  it("校验结果不能被 UI 或应用层原地改写，避免证据与字段值失去对应关系", () => {
    const result = validateEntryOrganizerPayload("mentor 名词 导师", validPayload());

    expect(Array.isArray(result.candidates)).toBe(true);
    expect(Array.isArray(result.candidates[0]?.meanings)).toBe(true);
    expect(() => {
      (result as { globalWarning?: string }).globalWarning = "新的警告";
    }).toThrow(TypeError);
  });
});

describe("v3 证据树：结构校验与稳定路径", () => {
  it("缺失与额外字段按稳定路径报告（缺失 global_warning）", () => {
    const payload = validPayload();
    delete payload["global_warning"];
    expect(() => validateEntryOrganizerPayload("mentor 名词 导师", payload)).toThrow(/global_warning/);
  });

  it("缺失与额外字段按稳定路径报告（缺失 term）", () => {
    const payload = validPayload();
    delete entryAt(payload, 0)["term"];
    expect(() => validateEntryOrganizerPayload("mentor 名词 导师", payload)).toThrow(/entries\[0\]\.term/);
  });

  it("缺失与额外字段按稳定路径报告（definition 缺少 source_excerpt）", () => {
    const payload = validPayload();
    delete definitionNodeOf(meaningAt(entryAt(payload, 0), 0))["source_excerpt"];
    expect(() => validateEntryOrganizerPayload("mentor 名词 导师", payload)).toThrow(
      /entries\[0\]\.meanings\[0\]\.definition\.source_excerpt/,
    );
  });

  it("缺失与额外字段按稳定路径报告（definition 出现额外字段）", () => {
    const payload = validPayload();
    Object.assign(definitionNodeOf(meaningAt(entryAt(payload, 0), 0)), { unexpected: true });
    expect(() => validateEntryOrganizerPayload("mentor 名词 导师", payload)).toThrow(
      /entries\[0\]\.meanings\[0\]\.definition\.unexpected/,
    );
  });

  it("缺失与额外字段按稳定路径报告（根对象出现额外字段）", () => {
    const payload = validPayload();
    payload["unresolved_fragments"] = [];
    expect(() => validateEntryOrganizerPayload("mentor 名词 导师", payload)).toThrow(/unresolved_fragments/);
  });

  it("错误类型和期望值必须可定位（错误 schema 版本）", () => {
    const payload = validPayload();
    payload["schema_version"] = "entry-organizer-v2";
    const message = validationErrorMessage("mentor 名词 导师", payload);
    expect(message).toContain("schema_version");
    expect(message).toContain("期望");
  });

  it("错误类型和期望值必须可定位（entries 成员不是对象）", () => {
    const payload = validPayload();
    // 刻意注入脏输入验证结构校验；类型断言仅为通过测试侧的严格检查。
    entriesOf(payload)[0] = "not an object" as unknown as Payload;
    const message = validationErrorMessage("mentor 名词 导师", payload);
    expect(message).toContain("entries[0]");
    expect(message).toContain("期望");
  });

  it("错误类型和期望值必须可定位（meanings 为空）", () => {
    const payload = validPayload();
    entryAt(payload, 0)["meanings"] = [];
    const message = validationErrorMessage("mentor 名词 导师", payload);
    expect(message).toContain("entries[0].meanings");
    expect(message).toContain("期望");
  });

  it("错误类型和期望值必须可定位（词性取值非法）", () => {
    const payload = validPayload();
    meaningAt(entryAt(payload, 0), 0)["part_of_speech"] = "not-a-part-of-speech";
    const message = validationErrorMessage("mentor 名词 导师", payload);
    expect(message).toContain("entries[0].meanings[0].part_of_speech.value");
    expect(message).toContain("期望");
  });

  it("错误类型和期望值必须可定位（释义值为空）", () => {
    const payload = validPayload();
    Object.assign(definitionNodeOf(meaningAt(entryAt(payload, 0), 0)), { value: "" });
    const message = validationErrorMessage("mentor 名词 导师", payload);
    expect(message).toContain("entries[0].meanings[0].definition.value");
    expect(message).toContain("期望");
  });

  it("补全词性、补全释义和非空用法都必须把不确定性留在所属证据节点（释义证据为 null）", () => {
    const payload = validPayload();
    Object.assign(definitionNodeOf(meaningAt(entryAt(payload, 0), 0)), { source_excerpt: null });
    expect(() => validateEntryOrganizerPayload("mentor 名词 导师", payload)).toThrow(
      "entries[0].meanings[0].definition.warning",
    );
  });

  it("补全词性、补全释义和非空用法都必须把不确定性留在所属证据节点（词性值为 null）", () => {
    const payload = validPayload();
    Object.assign(partOfSpeechNodeOf(meaningAt(entryAt(payload, 0), 0)), { value: null });
    expect(() => validateEntryOrganizerPayload("mentor 名词 导师", payload)).toThrow(
      "entries[0].meanings[0].part_of_speech.warning",
    );
  });

  it("补全词性、补全释义和非空用法都必须把不确定性留在所属证据节点（词性证据为 null）", () => {
    const payload = validPayload();
    Object.assign(partOfSpeechNodeOf(meaningAt(entryAt(payload, 0), 0)), { source_excerpt: null });
    expect(() => validateEntryOrganizerPayload("mentor 名词 导师", payload)).toThrow(
      "entries[0].meanings[0].part_of_speech.warning",
    );
  });

  it("补全词性、补全释义和非空用法都必须把不确定性留在所属证据节点（用法证据为 null）", () => {
    const payload = validPayload();
    meaningAt(entryAt(payload, 0), 0)["usage"] = node("go ahead", null);
    expect(() => validateEntryOrganizerPayload("mentor 名词 导师", payload)).toThrow(
      "entries[0].meanings[0].usage.source_excerpt",
    );
  });

  it("模型可以修正有依据的词条，但不能无依据补造英文词条", () => {
    const payload = validPayload();
    entryAt(payload, 0)["term"] = node("invented", null);

    expect(() => validateEntryOrganizerPayload("mentor 名词 导师", payload)).toThrow(
      /entries\[0\]\.term\.source_excerpt/,
    );
  });

  it("字段修正必须在同一个证据节点告知用户（term）", () => {
    const payload = validPayload();
    entryAt(payload, 0)["term"] = node("mentor", "menter");
    expect(() => validateEntryOrganizerPayload("menter 名词 导师", payload)).toThrow(
      "entries[0].term.warning",
    );
  });

  it("字段修正必须在同一个证据节点告知用户（definition）", () => {
    const payload = validPayload();
    meaningAt(entryAt(payload, 0), 0)["definition"] = node("教练", "导师");
    expect(() => validateEntryOrganizerPayload("mentor 名词 导师", payload)).toThrow(
      "entries[0].meanings[0].definition.warning",
    );
  });

  it("字段修正必须在同一个证据节点告知用户（usage）", () => {
    const payload = validPayload();
    meaningAt(entryAt(payload, 0), 0)["usage"] = node("go forward", "go ahead");
    expect(() => validateEntryOrganizerPayload("mentor 名词 导师 go ahead", payload)).toThrow(
      "entries[0].meanings[0].usage.warning",
    );
  });

  it("模型不能把中文片段或其他非英文文本作为正式英文词条", () => {
    const payload = validPayload();
    entryAt(payload, 0)["term"] = node("导师", "导师");

    expect(() => validateEntryOrganizerPayload("导师 名词 导师", payload)).toThrow(
      /entries\[0\]\.term\.value/,
    );
  });

  it("两种模式共用的模型契约不能把纯英文解释作为正式中文释义", () => {
    const payload = validPayload();
    meaningAt(entryAt(payload, 0), 0)["definition"] = node("teacher", "teacher");

    expect(() => validateEntryOrganizerPayload("mentor 名词 teacher", payload)).toThrow(
      /entries\[0\]\.meanings\[0\]\.definition\.value/,
    );
  });

  it("保留原文词组并追加中文翻译属于允许的派生内容，不应制造警告", () => {
    const payload = validPayload();
    meaningAt(entryAt(payload, 0), 0)["usage"] = node("go ahead\n继续进行", "go ahead");

    const result = validateEntryOrganizerPayload("mentor 名词 导师 go ahead", payload);

    const usage = result.candidates[0]?.meanings[0]?.usage;
    expect(usage).toBeDefined();
    expect(usage?.warning).toBeNull();
  });
});

describe("v3 证据树：证据定位（无消耗游标口径）", () => {
  it("同一证据片段被多个节点重复引用合法；高亮位置按上下文偏好向后分配", () => {
    const rawText = "mentor 名词 导师；名词 教练；尾部没有引用的课堂内容";
    const payload = validPayload();
    entryAt(payload, 0)["meanings"] = [
      {
        part_of_speech: node("n.", "名词"),
        definition: node("导师", "导师"),
        usage: null,
      },
      {
        part_of_speech: node("n.", "名词"),
        definition: node("教练", "教练"),
        usage: null,
      },
    ];

    const result = validateEntryOrganizerPayload(rawText, payload);

    const firstPos = result.candidates[0]?.meanings[0]?.partOfSpeech;
    const secondPos = result.candidates[0]?.meanings[1]?.partOfSpeech;
    const firstStart = firstPos?.sourceStart;
    const firstEnd = firstPos?.sourceEnd;
    expect(firstStart).toBe(rawText.indexOf("名词"));
    expect(firstEnd).not.toBeNull();
    expect(secondPos?.sourceStart).toBe(rawText.indexOf("名词", firstEnd ?? 0));
    expect(
      firstEnd !== null && firstEnd !== undefined && secondPos !== undefined &&
        secondPos.sourceStart !== null && secondPos.sourceStart > firstEnd,
    ).toBe(true);
    expect(result.globalWarning).toBeNull();
  });

  it("原文半角逗号、整理值全角逗号属于明确等价的标点形态差异（constitute 案例）", () => {
    const rawText = "constitute 动词 组成,构成";
    const payload = validPayload();
    const entry = entryAt(payload, 0);
    entry["term"] = node("constitute", "constitute");
    entry["meanings"] = [
      {
        part_of_speech: node("v.", "动词"),
        // value 采用规范全角标点，证据保留原文字符；两者等价，不要求 warning。
        definition: node("组成，构成", "组成,构成"),
        usage: null,
      },
    ];

    const result = validateEntryOrganizerPayload(rawText, payload);

    const definition = result.candidates[0]?.meanings[0]?.definition;
    expect(definition?.value).toBe("组成，构成");
    expect(definition?.sourceExcerpt).toBe("组成,构成");
    expect(definition?.warning).toBeNull();
  });

  it("超出有限标点等价表的实质内容修改仍必须携带同节点 warning", () => {
    const rawText = "constitute 动词 组成,构成";
    const payload = validPayload();
    const entry = entryAt(payload, 0);
    entry["term"] = node("constitute", "constitute");
    entry["meanings"] = [
      {
        part_of_speech: node("v.", "动词"),
        definition: node("形成，构成", "组成,构成"),
        usage: null,
      },
    ];

    const issues = collectEntryOrganizingIssues(rawText, payload);

    expect(issues.map((issue) => issue.category)).toEqual([
      OrganizingIssueCategory.CorrectionWithoutWarning,
    ]);
    expect(issues[0]?.path).toBe("entries[0].meanings[0].definition.warning");
    expect(issues[0]?.entryIndex).toBe(0);
  });

  it("模型写 noun／名词／n 等有效别名时本地规范化为正式简称，不要求订正 warning", () => {
    for (const alias of ["noun", "名词", "n", "N."]) {
      const payload = validPayload();
      meaningAt(entryAt(payload, 0), 0)["part_of_speech"] = node(alias, "名词");

      const result = validateEntryOrganizerPayload("mentor 名词 导师", payload);

      const part = result.candidates[0]?.meanings[0]?.partOfSpeech;
      expect(part?.value).toBe(PartOfSpeech.Noun);
      expect(part?.warning).toBeNull();
    }
  });

  it("Extension 案例：词性错字订正为 n.，证据保留错字且 warning 挂在词性节点", () => {
    const rawText = "extension 名次 延期扩大 名词 伸展";
    const payload = validPayload();
    const entry = entryAt(payload, 0);
    entry["term"] = node("extension", "extension");
    entry["meanings"] = [
      {
        part_of_speech: node("n.", "名次", "原文「名次」为「名词」的转写错字，已订正。"),
        definition: node("延期扩大", "延期扩大"),
        usage: null,
      },
      {
        part_of_speech: node("n.", "名词"),
        definition: node("伸展", "伸展"),
        usage: null,
      },
    ];

    const result = validateEntryOrganizerPayload(rawText, payload);

    const part = result.candidates[0]?.meanings[0]?.partOfSpeech;
    expect(part?.value).toBe(PartOfSpeech.Noun);
    expect(part?.sourceExcerpt).toBe("名次");
    expect(part?.warning).toBe("原文「名次」为「名词」的转写错字，已订正。");
    // 两个义项都保留，订正说明没有挂到释义节点。
    expect(result.candidates[0]?.meanings).toHaveLength(2);
    expect(result.candidates[0]?.meanings[0]?.definition.warning).toBeNull();

    // 同一订正缺少同节点说明时，仍按「实质订正缺少同节点说明」判定为必须修复。
    meaningAt(entry, 0)["part_of_speech"] = node("n.", "名次");
    const issues = collectEntryOrganizingIssues(rawText, payload);
    expect(issues.map((issue) => issue.category)).toEqual([
      OrganizingIssueCategory.CorrectionWithoutWarning,
    ]);
    expect(issues[0]?.path).toBe("entries[0].meanings[0].part_of_speech.warning");
  });

  it("Conduct 案例：大量重复「名词」不触发引用次数耗尽，也不把错误推给靠后词条", () => {
    const rawText = "distinction 名词 差别区分 名词 荣誉 conduct 名词 行为 动词 实施";
    const payload = {
      schema_version: ENTRY_ORGANIZER_SCHEMA_VERSION,
      global_warning: null,
      entries: [
        {
          term: node("distinction", "distinction"),
          meanings: [
            {
              part_of_speech: node("n.", "名词"),
              definition: node("差别区分", "差别区分"),
              usage: null,
            },
            {
              part_of_speech: node("n.", "名词"),
              definition: node("荣誉", "荣誉"),
              usage: null,
            },
          ],
        },
        {
          term: node("conduct", "conduct"),
          meanings: [
            {
              part_of_speech: node("n.", "名词"),
              definition: node("行为", "行为"),
              usage: null,
            },
            {
              part_of_speech: node("v.", "动词"),
              definition: node("实施", "实施"),
              usage: null,
            },
          ],
        },
      ],
    };

    const result = validateEntryOrganizerPayload(rawText, payload);

    expect(result.candidates).toHaveLength(2);
    // conduct 的两个义项都通过校验，重复「名词」各自定位到自己区域内的出现位置。
    const conduct = result.candidates[1];
    const conductSpanStart = rawText.indexOf("conduct");
    const firstStart = conduct?.meanings[0]?.partOfSpeech.sourceStart;
    expect(firstStart).not.toBeNull();
    expect((firstStart ?? 0)).toBeGreaterThan(conductSpanStart);
  });

  it("唯一出现位置明确落在其他词条区域内的引用按上下文不对应指出实际出错节点", () => {
    const rawText = "extension 名词 延期 conduct 名词 行为";
    const payload = validPayload();
    const entry = entryAt(payload, 0);
    entry["term"] = node("extension", "extension");
    meaningAt(entry, 0)["definition"] = node("延期", "延期");
    entriesOf(payload).push({
      term: node("conduct", "conduct"),
      meanings: [
        {
          part_of_speech: node("n.", "名词"),
          // conduct 的释义证据引用了只属于 extension 区域的「延期」。
          definition: node("行为", "延期"),
          usage: null,
        },
      ],
    });

    const issues = collectEntryOrganizingIssues(rawText, payload);

    expect(issues.map((issue) => issue.category)).toEqual([
      OrganizingIssueCategory.EvidenceContextMismatch,
    ]);
    expect(issues[0]?.path).toBe("entries[1].meanings[0].definition.source_excerpt");
    expect(issues[0]?.entryIndex).toBe(1);
  });

  it("模型声明原文中不存在的证据片段仍按「引用文本在原文中不存在」识别", () => {
    const payload = validPayload();
    meaningAt(entryAt(payload, 0), 0)["definition"] = node("导师", "根本不存在的原文");

    const issues = collectEntryOrganizingIssues("mentor 名词 导师", payload);

    expect(issues.map((issue) => issue.category)).toEqual([
      OrganizingIssueCategory.EvidenceNotFound,
    ]);
    expect(issues[0]?.path).toBe("entries[0].meanings[0].definition.source_excerpt");
  });
});

describe("v3 证据树：warning 与 usage 表示差异", () => {
  it("warning 缺失、空字符串或 null 统一视为无警告", () => {
    for (const warningValue of ["", "   ", null]) {
      const payload = validPayload();
      Object.assign(definitionNodeOf(meaningAt(entryAt(payload, 0), 0)), { warning: warningValue });

      const result = validateEntryOrganizerPayload("mentor 名词 导师", payload);

      expect(result.candidates[0]?.meanings[0]?.definition.warning).toBeNull();
    }
  });

  it("可选用法为空字符串或空 value 节点时本地统一视为没有用法", () => {
    for (const usageValue of ["", "  ", { value: "", source_excerpt: null }]) {
      const payload = validPayload();
      meaningAt(entryAt(payload, 0), 0)["usage"] = usageValue;

      const result = validateEntryOrganizerPayload("mentor 名词 导师", payload);

      expect(result.candidates[0]?.meanings[0]?.usage).toBeNull();
    }
  });
});

describe("v3 证据树：按词条汇总错误", () => {
  it("校验按词条汇总全部可独立判断的问题，首个错误不再中断其余词条的检查", () => {
    const payload = validPayload();
    meaningAt(entryAt(payload, 0), 0)["definition"] = node("导师", "不存在的原文");
    entriesOf(payload).push({
      term: node("coach", "coach"),
      meanings: [
        {
          part_of_speech: node("n.", "名词"),
          definition: node("教练", "另一处不存在的原文"),
          usage: null,
        },
      ],
    });

    let captured: { issues: readonly EntryOrganizingIssue[]; message: string } | null = null;
    try {
      validateEntryOrganizerPayload("mentor 名词 导师 coach 名词 教练", payload);
    } catch (error) {
      if (error instanceof Error && "issues" in error) {
        captured = {
          issues: (error as { issues: readonly EntryOrganizingIssue[] }).issues,
          message: error.message,
        };
      } else {
        throw error;
      }
    }

    expect(captured).not.toBeNull();
    expect(captured?.issues.map((issue) => issue.entryIndex)).toEqual([0, 1]);
    expect(captured?.issues.map((issue) => issue.category)).toEqual([
      OrganizingIssueCategory.EvidenceNotFound,
      OrganizingIssueCategory.EvidenceNotFound,
    ]);
    expect(captured?.message).toContain("entries[0].meanings[0].definition.source_excerpt");
    expect(captured?.message).toContain("entries[1].meanings[0].definition.source_excerpt");
  });

  it("父结构已经损坏的词条只报告结构错误本身，不再派生一串子节点错误", () => {
    const payload = validPayload();
    entryAt(payload, 0)["meanings"] = "not-a-list";

    const issues = collectEntryOrganizingIssues("mentor 名词 导师", payload);

    expect(issues.map((issue) => issue.path)).toEqual(["entries[0].meanings"]);
    expect(issues.map((issue) => issue.category)).toEqual([
      OrganizingIssueCategory.MissingRequired,
    ]);
  });

  it("错误分类标签是稳定中文名称", () => {
    const payload = validPayload();
    meaningAt(entryAt(payload, 0), 0)["definition"] = node("导师", "根本不存在的原文");
    const issues = collectEntryOrganizingIssues("mentor 名词 导师", payload);
    const firstIssue = issues[0];
    expect(firstIssue).toBeDefined();
    expect(issueCategoryLabel(firstIssue!)).toBe("引用文本在原文中不存在");
  });
});
