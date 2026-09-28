import { describe, expect, it, vi } from "vitest";
import type {
  DictionaryCacheRecord, DictionaryCacheStore, OnlineDictionaryPort,
  UnitOfWork, WordContentRecord, WordContentStore,
} from "../src/ports.ts";
import { DictionaryService } from "../src/dictionary.ts";
import { DictionaryLookupCancelledError, DictionaryLookupNetworkError } from "../src/errors.ts";

const word: WordContentRecord = {
  wordId: "word-1", listId: null, spaceId: "space-1", originalSpelling: "Abandon",
  normalizedKey: "abandon", manualMeaning: "放弃", meanings: [], removed: false,
  recordedAt: "2026-07-18T09:00:00.000Z",
};

function setup(lookup: OnlineDictionaryPort["lookup"]) {
  const words = new Map([[word.wordId, { ...word }]]);
  const caches = new Map<string, DictionaryCacheRecord>();
  const wordContentStore = {
    getEntry: (id: string) => words.get(id) ?? null,
  } as WordContentStore;
  const cacheStore: DictionaryCacheStore = {
    get: (id) => caches.get(id) ?? null,
    replace: (record) => { caches.set(record.wordId, record); },
    pruneBySize: vi.fn(),
  };
  let sequence = 0;
  const idGenerator = { nextId: vi.fn(() => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`) };
  const clock = { now: () => new Date("2026-07-18T10:00:00.000Z") };
  const unitOfWork = { run: vi.fn((write: () => void) => write()) } as UnitOfWork;
  const service = new DictionaryService({
    wordContentStore, cacheStore, dictionary: { lookup }, idGenerator, clock,
    unitOfWork,
  });
  return { service, words, caches, idGenerator, unitOfWork, cacheStore };
}

describe("在线词典本机补充释义语义", () => {
  it("成功只上传英文规范键，写一条本机缓存，不生成学习事件或改手录释义", async () => {
    const lookup = vi.fn(async () => ({ provider: "有道词典", normalizedWord: "abandon",
      definitions: [{ partOfSpeech: "v.", definition: "放弃" }], rawResponseSummary: "1 个义项" }));
    const { service, words, caches, idGenerator, unitOfWork } = setup(lookup);
    expect(service.getSnapshot("word-1").needsRefresh).toBe(true);
    const snapshot = await service.load("word-1");
    expect(lookup).toHaveBeenCalledWith("abandon", expect.any(Object));
    expect(snapshot.definitions).toEqual([{ partOfSpeech: "v.", definition: "放弃" }]);
    expect(words.get("word-1")?.manualMeaning).toBe("放弃");
    expect(caches.size).toBe(1);
    // 词典用例只分配一枚本机缓存 ID；没有事件工厂/事件端口，事务也只用于缓存。
    expect(idGenerator.nextId).toHaveBeenCalledTimes(1);
    expect(unitOfWork.run).toHaveBeenCalledTimes(1);
    await service.load("word-1");
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(idGenerator.nextId).toHaveBeenCalledTimes(1);
  });

  it("无缓存联网失败只给临时重试状态，再打开仍可联网并写本机缓存", async () => {
    const lookup = vi.fn().mockRejectedValueOnce(new DictionaryLookupNetworkError("断网"))
      .mockResolvedValueOnce({ provider: "维基词典", normalizedWord: "abandon",
        definitions: [{ partOfSpeech: "动词", definition: "放弃" }], rawResponseSummary: "1 个义项" });
    const { service, caches, idGenerator, unitOfWork } = setup(lookup);
    expect((await service.load("word-1")).status).toBe("查询失败");
    expect(caches.size).toBe(0);
    expect(idGenerator.nextId).not.toHaveBeenCalled();
    expect(unitOfWork.run).not.toHaveBeenCalled();
    expect(service.getSnapshot("word-1").status).toBe("未查询");
    expect((await service.load("word-1")).status).toBe("有效");
    expect(idGenerator.nextId).toHaveBeenCalledTimes(1);
    expect(caches.size).toBe(1);
  });

  it("页面取消与查询期间词条变更均不写缓存", async () => {
    const cancelled = setup(async () => { throw new DictionaryLookupCancelledError("取消"); });
    await expect(cancelled.service.load("word-1")).rejects.toBeInstanceOf(DictionaryLookupCancelledError);
    expect(cancelled.idGenerator.nextId).not.toHaveBeenCalled();
    const edited = setup(async () => {
      edited.words.set("word-1", { ...word, normalizedKey: "different" });
      return { provider: "有道词典", normalizedWord: "abandon",
        definitions: [{ partOfSpeech: "v.", definition: "放弃" }], rawResponseSummary: "1 个义项" };
    });
    await expect(edited.service.load("word-1")).rejects.toBeInstanceOf(DictionaryLookupCancelledError);
    expect(edited.caches.size).toBe(0);
    expect(edited.idGenerator.nextId).not.toHaveBeenCalled();
  });
});
