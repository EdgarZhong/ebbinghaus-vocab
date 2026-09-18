/**
 * 统一条目格式的纯领域回归测试（映射 V1 tests/unit/domain/test_entry_format.py）。
 */
import { describe, expect, it } from "vitest";

import { parseEntryBlocks } from "../src/entryFormat.ts";
import { PartOfSpeech } from "../src/meanings.ts";

describe("统一条目规范格式解析", () => {
  it("标题保留全部字符，义项只把第一个竖线视为用法边界", () => {
    const result = parseEntryBlocks("a|b.c 中文标题\nv. 释义|用法|仍是用法");

    expect(result.issues).toEqual([]);
    const candidate = result.candidates[0];
    expect(candidate?.title).toBe("a|b.c 中文标题");
    expect(candidate?.meanings[0]?.partOfSpeech).toBe(PartOfSpeech.Verb);
    expect(candidate?.meanings[0]?.definition).toBe("释义");
    expect(candidate?.meanings[0]?.usage).toBe("用法|仍是用法");
  });

  it("无词性义项合法；释义超过 50 字符整块进入问题清单", () => {
    const valid = parseEntryBlocks("任意标题\n无需词性");
    const invalid = parseEntryBlocks(`任意标题\n${"长".repeat(51)}`);

    expect(valid.issues).toEqual([]);
    expect(valid.candidates[0]?.meanings[0]?.partOfSpeech).toBeNull();
    expect(invalid.candidates).toEqual([]);
    expect(invalid.issues[0]?.message).toBe("释义不得超过 50 个字符");
  });
});
