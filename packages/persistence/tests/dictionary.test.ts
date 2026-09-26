import { describe, expect, it, vi } from "vitest";
import {
  DictionaryLookupNetworkError, DictionaryLookupResponseError,
  type DictionaryCacheRecord,
} from "@ebbinghaus/application";
import { openClientDatabase } from "../src/sqlite/connection.ts";
import { SqliteDictionaryCacheStore } from "../src/repositories/dictionary.ts";
import {
  createConcurrentOnlineDictionary, parseWiktionaryDefinitions, parseYoudaoDefinitions,
  type DictionaryHttpTransport,
} from "../src/dictionary/onlineDictionary.ts";

const youdaoBody = JSON.stringify({ ec: { word: [{ trs: [
  { tr: [{ l: { i: "v. 放弃" } }] }, { tr: [{ l: { i: "n. 弃权" } }] },
] }] }, oxford: { encrypted: true } });
const wikiBody = JSON.stringify({ parse: { wikitext: "==英语==\n===词源===\n# 忽略\n===动词===\n# [[放弃]]\n#* 例句\n==法语==\n===名词===\n# 忽略" } });

describe("V1 词典源解析与并发", () => {
  it("有道仅抽取英汉字段，维基仅抽取英语词性一级释义", () => {
    expect(parseYoudaoDefinitions(JSON.parse(youdaoBody))).toEqual([
      { partOfSpeech: "v.", definition: "放弃" }, { partOfSpeech: "n.", definition: "弃权" },
    ]);
    expect(parseWiktionaryDefinitions(JSON.parse(wikiBody).parse.wikitext)).toEqual([
      { partOfSpeech: "动词", definition: "放弃" },
    ]);
  });

  it("两个源同时请求，先失败的源不阻断另一源成功", async () => {
    const get = vi.fn(async (source: string) => {
      if (source === "youdao") throw new DictionaryLookupResponseError("结构变化");
      return wikiBody;
    });
    const dictionary = createConcurrentOnlineDictionary({ get } as DictionaryHttpTransport);
    const result = await dictionary.lookup("abandon");
    expect(get).toHaveBeenCalledTimes(2);
    expect(result.provider).toBe("维基词典");
  });

  it("网络瞬断重试三次后成功，响应结构错误不重试", async () => {
    let calls = 0;
    const transport: DictionaryHttpTransport = {
      get: async (source) => {
        if (source === "wiktionary") throw new DictionaryLookupResponseError("无结果");
        calls += 1;
        if (calls < 4) throw new DictionaryLookupNetworkError("瞬断");
        return youdaoBody;
      },
    };
    const result = await createConcurrentOnlineDictionary(transport).lookup("abandon");
    expect(result.provider).toBe("有道词典");
    expect(calls).toBe(4);
  });

  it("全部失败按 V1 优先级暴露有道错误，非法键不发网络请求", async () => {
    const get = vi.fn(async (source: string) => {
      if (source === "youdao") throw new DictionaryLookupNetworkError("有道断网");
      throw new DictionaryLookupResponseError("维基无结果");
    });
    const dictionary = createConcurrentOnlineDictionary({ get } as DictionaryHttpTransport);
    await expect(dictionary.lookup("abandon")).rejects.toThrow("有道断网");
    await expect(dictionary.lookup("Abandon")).rejects.toThrow("规范键");
    expect(get).toHaveBeenCalledTimes(5);
  });
});

function cacheRecord(id: string, wordId: string, fetchedAt: string): DictionaryCacheRecord {
  return {
    id, wordId, provider: "有道词典", normalizedWord: "abandon",
    definitions: [{ partOfSpeech: "v.", definition: "放弃" }],
    rawResponseSummary: "1 个义项", fetchedAt, cacheStatus: "有效",
  };
}

describe("V1 词典成功缓存", () => {
  it("SQLite 每词只保留最新成功结果，重开仍可命中，按字节上限淘汰最旧", () => {
    const db = openClientDatabase(":memory:");
    try {
      const store = new SqliteDictionaryCacheStore(db);
      store.replace(cacheRecord("a", "word-1", "2026-07-18T09:00:00Z"));
      store.replace(cacheRecord("b", "word-1", "2026-07-18T10:00:00Z"));
      store.replace(cacheRecord("c", "word-2", "2026-07-18T11:00:00Z"));
      expect(store.get("word-1")?.id).toBe("b");
      const reopenedStore = new SqliteDictionaryCacheStore(db);
      expect(reopenedStore.get("word-2")?.provider).toBe("有道词典");
      reopenedStore.pruneBySize(1);
      expect(reopenedStore.get("word-1")).toBeNull();
      expect(reopenedStore.get("word-2")).toBeNull();
    } finally { db.close(); }
  });
});
