/**
 * 本地首过解析与大语言模型结构复验测试
 * （映射 V1 tests/unit/domain/test_first_pass_parser.py，逐函数对应）。
 */
import { describe, expect, it } from "vitest";

import {
  FIRST_PASS_RESPONSE_SCHEMA_VERSION,
  ParseIssueLevel,
  candidateManualMeaning,
  hasBlockingErrors,
  parseLocalFirstPass,
  validateOrganizedPayload,
} from "../src/firstPass.ts";
import { normalizePartOfSpeech } from "../src/meanings.ts";
import { PartOfSpeech, type StructuredMeaning } from "../src/meanings.ts";

describe("本地首过解析", () => {
  it("竖线与 Tab 是高置信边界，括号内逗号不得错误拆成两个义项", () => {
    const result = parseLocalFirstPass(
      "abandon | v. 放弃；v. 抛弃\n" +
        "elaborate\t形容词 详尽的（常用，书面）；动词 详细说明\n" +
        "well-known | adj. 著名的",
    );

    expect(hasBlockingErrors(result)).toBe(false);
    expect(result.candidates.map((candidate) => candidate.normalizedKey)).toEqual([
      "abandon",
      "elaborate",
      "well-known",
    ]);
    const elaborate = result.candidates[1];
    expect(elaborate?.meanings).toEqual([
      { partOfSpeech: PartOfSpeech.Adjective, definition: "详尽的（常用，书面）", usage: null },
      { partOfSpeech: PartOfSpeech.Verb, definition: "详细说明", usage: null },
    ] satisfies readonly StructuredMeaning[]);
    expect(candidateManualMeaning(result.candidates[2]!)).toBe("a. 著名的");
  });

  it("本地规则可形成候选，但多词短语缺少明确分隔时必须留下预览核对警告", () => {
    const result = parseLocalFirstPass("abandon，动词放弃、动词抛弃\ntake over 动词接管；动词接任");

    expect(hasBlockingErrors(result)).toBe(false);
    expect(candidateManualMeaning(result.candidates[0]!)).toBe("v. 放弃；v. 抛弃");
    expect(result.candidates[1]?.originalSpelling).toBe("take over");
    expect(result.candidates[1]?.needsConfirmation).toBe(true);
    expect(result.issues.some((issue) => issue.code === "ambiguous-phrase-boundary")).toBe(true);
  });

  it("口述“竖线/下一个”可用于候选分隔，但原文与警告必须保留", () => {
    const rawText = "abandon 竖线 动词放弃 下一个 elaborate 竖线 形容词详尽的";
    const result = parseLocalFirstPass(rawText);

    expect(result.candidates.map((candidate) => candidate.normalizedKey)).toEqual([
      "abandon",
      "elaborate",
    ]);
    expect(result.candidates.every((candidate) => candidate.needsConfirmation)).toBe(true);
    expect(
      result.issues.filter((issue) => issue.code === "spoken-separator-converted"),
    ).toHaveLength(2);
    expect(result.rawText).toBe(rawText);
  });

  it("同一 List 重复词不重复入库，也不能在没有提示的情况下静默合并", () => {
    const result = parseLocalFirstPass("Abandon | v. 放弃\nabandon | 动词抛弃");

    expect(result.candidates).toHaveLength(1);
    const merged = result.candidates[0];
    expect(merged?.normalizedKey).toBe("abandon");
    expect(merged?.meanings).toEqual([
      { partOfSpeech: PartOfSpeech.Verb, definition: "放弃", usage: null },
      { partOfSpeech: PartOfSpeech.Verb, definition: "抛弃", usage: null },
    ]);
    expect(merged?.needsConfirmation).toBe(true);
    expect(result.issues.some((issue) => issue.code === "duplicate-word")).toBe(true);
  });

  it("缺少中文义项或非法英文词条必须返回原行定位，候选不得半成功入库", () => {
    const result = parseLocalFirstPass("abandon\n123word | v. 放弃\nvalid | a. 有效");

    expect(hasBlockingErrors(result)).toBe(true);
    expect(result.candidates.map((candidate) => candidate.normalizedKey)).toEqual(["valid"]);
    const blockingLineNumbers = result.issues
      .filter((issue) => issue.level === ParseIssueLevel.Error)
      .map((issue) => issue.lineNumber);
    expect([...new Set(blockingLineNumbers)].sort((a, b) => a - b)).toEqual([1, 2]);
    expect(result.issues.every((issue) => issue.originalFragment.length > 0)).toBe(true);
  });

  it("空白原文允许后续显式确认空 List，但解析器绝不生成占位 Word", () => {
    const result = parseLocalFirstPass("  \n\n");

    expect(result.candidates).toEqual([]);
    expect(result.issues).toEqual([]);
    expect(hasBlockingErrors(result)).toBe(false);
  });

  it("词性是可选字段：用户未表达词性时只给警告，绝不阻塞预览与保存", () => {
    const result = parseLocalFirstPass("abandon | 放弃");

    expect(hasBlockingErrors(result)).toBe(false);
    expect(result.issues.some((issue) => issue.code === "missing-part-of-speech")).toBe(true);
  });

  it("缺词性的义项保留在预览候选里，用户可留空保存，也可在表单中补选词性", () => {
    const result = parseLocalFirstPass("abandon | 放弃；抛弃");

    expect(hasBlockingErrors(result)).toBe(false);
    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0];
    expect(candidate?.normalizedKey).toBe("abandon");
    expect(candidate?.meanings.map((meaning) => meaning.partOfSpeech)).toEqual([null, null]);
    expect(candidate?.needsConfirmation).toBe(true);
  });

  it("录入页占位符示例必须不阻塞：带词性与省略词性两种写法都要能直接进预览", () => {
    const result = parseLocalFirstPass("abandon | v. 放弃；v. 抛弃\ncandid | 坦率的");

    expect(hasBlockingErrors(result)).toBe(false);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]?.meanings).toEqual([
      { partOfSpeech: PartOfSpeech.Verb, definition: "放弃", usage: null },
      { partOfSpeech: PartOfSpeech.Verb, definition: "抛弃", usage: null },
    ]);
    expect(result.candidates[1]?.meanings).toEqual([
      { partOfSpeech: null, definition: "坦率的", usage: null },
    ]);
  });
});

describe("大语言模型结构复验（entry-organizer-v3 统一校验器）", () => {
  it("模型正常结构仍经过相同词条与义项校验，并返回统一预览对象", () => {
    const rawText = "abandon | 动词放弃；give up\nelaborate | 形容词详尽的";
    const result = validateOrganizedPayload(rawText, {
      schema_version: FIRST_PASS_RESPONSE_SCHEMA_VERSION,
      global_warning: null,
      entries: [
        {
          term: { value: "abandon", source_excerpt: "abandon" },
          meanings: [
            {
              part_of_speech: { value: "v.", source_excerpt: "动词" },
              definition: { value: "放弃", source_excerpt: "放弃" },
              usage: { value: "give up", source_excerpt: "give up" },
            },
          ],
        },
        {
          term: { value: "elaborate", source_excerpt: "elaborate" },
          meanings: [
            {
              part_of_speech: {
                value: "a.",
                source_excerpt: "形容词",
                warning: "请核对本义项词性。",
              },
              definition: { value: "详尽的", source_excerpt: "详尽的" },
              usage: null,
            },
          ],
        },
      ],
    });

    expect(result.organizerKind).toBe("大语言模型");
    expect(hasBlockingErrors(result)).toBe(false);
    expect(result.candidates.map((candidate) => candidate.normalizedKey)).toEqual([
      "abandon",
      "elaborate",
    ]);
    expect(result.candidates[0]?.meanings[0]?.usage).toBe("give up");
    expect(result.candidates[1]?.needsConfirmation).toBe(true);
    expect(result.candidates[1]?.warnings[0]).toContain("核对");
  });

  it("用户未朗读词性时模型输出 null，本地复验同样按无词性候选放行", () => {
    const rawText = "abandon | 放弃";
    const result = validateOrganizedPayload(rawText, {
      schema_version: FIRST_PASS_RESPONSE_SCHEMA_VERSION,
      global_warning: null,
      entries: [
        {
          term: { value: "abandon", source_excerpt: "abandon" },
          meanings: [
            {
              part_of_speech: {
                value: null,
                source_excerpt: null,
                warning: "原文未提供词性。",
              },
              definition: { value: "放弃", source_excerpt: "放弃" },
              usage: null,
            },
          ],
        },
      ],
    });

    expect(hasBlockingErrors(result)).toBe(false);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.meanings).toEqual([
      { partOfSpeech: null, definition: "放弃", usage: null },
    ]);
  });

  it.each([
    ["free text", /JSON 对象/],
    [
      { schema_version: "wrong", global_warning: null, entries: [] },
      /schema_version/,
    ],
    [
      {
        schema_version: FIRST_PASS_RESPONSE_SCHEMA_VERSION,
        global_warning: null,
        entries: [
          {
            term: {
              value: "invented",
              source_excerpt: "模型虚构片段",
              warning: "词条经过修正。",
            },
            meanings: [
              {
                part_of_speech: {
                  value: null,
                  source_excerpt: null,
                  warning: "未提供词性。",
                },
                definition: {
                  value: "虚构",
                  source_excerpt: null,
                  warning: "模型补充释义。",
                },
                usage: null,
              },
            ],
          },
        ],
      },
      /source_excerpt/,
    ],
  ] as const)("自由文本、错误版本和模型虚构片段都不得进入预览或正式数据", (payload, pattern) => {
    expect(() => validateOrganizedPayload("abandon | 放弃", payload)).toThrow(pattern);
  });

  it("原文存在未引用内容时仍可预览，本地不得恢复旧覆盖率或未整理片段逻辑", () => {
    const rawText = "abandon | 动词放弃\nelaborate | 形容词详尽的";
    const result = validateOrganizedPayload(rawText, {
      schema_version: FIRST_PASS_RESPONSE_SCHEMA_VERSION,
      global_warning: null,
      entries: [
        {
          term: { value: "abandon", source_excerpt: "abandon" },
          meanings: [
            {
              part_of_speech: { value: "v.", source_excerpt: "动词" },
              definition: { value: "放弃", source_excerpt: "放弃" },
              usage: null,
            },
          ],
        },
      ],
    });

    expect(hasBlockingErrors(result)).toBe(false);
    expect(result.issues.every((issue) => issue.level !== ParseIssueLevel.Error)).toBe(true);
  });
});

describe("词性别名规范化", () => {
  it.each([
    ["n.", PartOfSpeech.Noun],
    ["verb", PartOfSpeech.Verb],
    ["及物动词", PartOfSpeech.TransitiveVerb],
    ["vi", PartOfSpeech.IntransitiveVerb],
    ["adj.", PartOfSpeech.Adjective],
    ["形容词", PartOfSpeech.Adjective],
    ["adv", PartOfSpeech.Adverb],
    ["副词", PartOfSpeech.Adverb],
    ["preposition", PartOfSpeech.Preposition],
    ["pron.", PartOfSpeech.Pronoun],
    ["conj", PartOfSpeech.Conjunction],
    ["num.", PartOfSpeech.Numeral],
    ["art", PartOfSpeech.Article],
    ["auxiliary verb", PartOfSpeech.Auxiliary],
    ["modal verb", PartOfSpeech.Modal],
    ["interj.", PartOfSpeech.Interjection],
    ["determiner", PartOfSpeech.Determiner],
  ] as const)("%s 收敛到规格中的唯一简称", (alias, expected) => {
    expect(normalizePartOfSpeech(alias)).toBe(expected);
  });
});
