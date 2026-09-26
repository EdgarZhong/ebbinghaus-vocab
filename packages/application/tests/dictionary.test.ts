import { describe, expect, it, vi } from "vitest";
import type {
  DictionaryCacheRecord, DictionaryCacheStore, LearningEventStore, OnlineDictionaryPort,
  UnitOfWork, WordContentRecord, WordContentStore,
} from "../src/ports.ts";
import { DictionaryService } from "../src/dictionary.ts";
import { DictionaryLookupCancelledError, DictionaryLookupNetworkError } from "../src/errors.ts";
import { LearningEventRecorder } from "../src/eventRecorder.ts";
import { LEARNING_DAY_SETTINGS } from "./helpers/assemble.ts";

const word: WordContentRecord = {
  wordId: "word-1", listId: null, spaceId: "space-1", originalSpelling: "Abandon",
  normalizedKey: "abandon", manualMeaning: "放弃", meanings: [], removed: false,
  recordedAt: "2026-07-18T09:00:00.000Z",
};

function setup(lookup: OnlineDictionaryPort["lookup"]) {
  const words = new Map([[word.wordId, { ...word }]]);
  const caches = new Map<string, DictionaryCacheRecord>();
  const events: import("../src/ports.ts").ApplicationEvent[] = [];
  const wordContentStore = {
    getEntry: (id: string) => words.get(id) ?? null,
  } as WordContentStore;
  const cacheStore: DictionaryCacheStore = {
    get: (id) => caches.get(id) ?? null,
    replace: (record) => { caches.set(record.wordId, record); },
    pruneBySize: vi.fn(),
  };
  let sequence = 0;
  const idGenerator = { nextId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}` };
  const clock = { now: () => new Date("2026-07-18T10:00:00.000Z") };
  const recorder = new LearningEventRecorder({
    clock, idGenerator, deviceIdentity: { getDeviceId: () => "00000000-0000-4000-8000-000000000099" },
    deviceSeqAllocator: { nextSeq: () => sequence + 1 },
    readLearningDaySettings: () => LEARNING_DAY_SETTINGS,
  });
  const service = new DictionaryService({
    wordContentStore, cacheStore, dictionary: { lookup }, idGenerator, clock,
    eventRecorder: recorder,
    eventStore: { appendEvents: (batch) => { events.push(...batch); } } as LearningEventStore,
    unitOfWork: { run: (write) => write() } as UnitOfWork,
  });
  return { service, words, caches, events, cacheStore };
}

describe("V1 在线词典应用语义", () => {
  it("成功只上传英文规范键，写一条缓存与成功审计，绝不改手录释义", async () => {
    const lookup = vi.fn(async () => ({ provider: "有道词典", normalizedWord: "abandon",
      definitions: [{ partOfSpeech: "v.", definition: "放弃" }], rawResponseSummary: "1 个义项" }));
    const { service, words, caches, events } = setup(lookup);
    expect(service.getSnapshot("word-1").needsRefresh).toBe(true);
    const snapshot = await service.load("word-1");
    expect(lookup).toHaveBeenCalledWith("abandon", expect.any(Object));
    expect(snapshot.definitions).toEqual([{ partOfSpeech: "v.", definition: "放弃" }]);
    expect(words.get("word-1")?.manualMeaning).toBe("放弃");
    expect(caches.size).toBe(1);
    expect(events.map((event) => event.eventType)).toEqual(["dictionaryFetched"]);
    await service.load("word-1");
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("无缓存联网失败只记事件并给临时重试状态，再打开仍可联网", async () => {
    const lookup = vi.fn().mockRejectedValueOnce(new DictionaryLookupNetworkError("断网"))
      .mockResolvedValueOnce({ provider: "维基词典", normalizedWord: "abandon",
        definitions: [{ partOfSpeech: "动词", definition: "放弃" }], rawResponseSummary: "1 个义项" });
    const { service, caches, events } = setup(lookup);
    expect((await service.load("word-1")).status).toBe("查询失败");
    expect(caches.size).toBe(0);
    expect(service.getSnapshot("word-1").status).toBe("未查询");
    expect((await service.load("word-1")).status).toBe("有效");
    expect(events.map((event) => event.eventType)).toEqual(["dictionaryFetchFailed", "dictionaryFetched"]);
  });

  it("页面取消与查询期间词条变更均不写缓存或审计", async () => {
    const cancelled = setup(async () => { throw new DictionaryLookupCancelledError("取消"); });
    await expect(cancelled.service.load("word-1")).rejects.toBeInstanceOf(DictionaryLookupCancelledError);
    expect(cancelled.events).toHaveLength(0);
    const edited = setup(async () => {
      edited.words.set("word-1", { ...word, normalizedKey: "different" });
      return { provider: "有道词典", normalizedWord: "abandon",
        definitions: [{ partOfSpeech: "v.", definition: "放弃" }], rawResponseSummary: "1 个义项" };
    });
    await expect(edited.service.load("word-1")).rejects.toBeInstanceOf(DictionaryLookupCancelledError);
    expect(edited.caches.size).toBe(0);
    expect(edited.events).toHaveLength(0);
  });
});
