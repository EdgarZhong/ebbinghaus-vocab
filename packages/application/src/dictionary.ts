/**
 * 在线词典用例：与 V1 一样把网络查询和短事务缓存分开。
 * 查询只把小写英文规范键送到词典源；Word 的手录义项始终留在内容目录，既不上传
 * 也不被补充释义覆盖。失败不写缓存，因此再次打开无缓存的词条会重新尝试查询。
 */
import type {
  Clock, DictionaryCacheRecord, DictionaryCacheStore, DictionaryDefinition,
  IdGenerator, LearningEventStore, OnlineDictionaryPort, UnitOfWork, WordContentStore,
} from "./ports.ts";
import type { LearningEventRecorder } from "./eventRecorder.ts";
import { DictionaryLookupCancelledError, DictionaryLookupResponseError } from "./errors.ts";

export const DICTIONARY_CACHE_MAX_BYTES = 100 * 1024 * 1024;

export interface DictionarySnapshot {
  readonly status: "未查询" | "有效" | "查询失败";
  readonly provider: string;
  readonly fetchedAt: string | null;
  readonly definitions: readonly DictionaryDefinition[];
  readonly message: string;
  readonly needsRefresh: boolean;
}

export interface DictionaryServiceDeps {
  readonly wordContentStore: WordContentStore;
  readonly cacheStore: DictionaryCacheStore;
  readonly dictionary: OnlineDictionaryPort;
  readonly eventStore: LearningEventStore;
  readonly eventRecorder: LearningEventRecorder;
  readonly unitOfWork: UnitOfWork;
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
}

function cachedSnapshot(record: DictionaryCacheRecord): DictionarySnapshot {
  // V1 历史库可能带“失效”状态；已有成功内容仍视为可用，不因时间触发自动刷新。
  return {
    status: "有效", provider: record.provider, fetchedAt: record.fetchedAt,
    definitions: record.definitions, message: "已命中本地缓存", needsRefresh: false,
  };
}

/** 只接受 V1 支持的单个小写英文词，避免把手录中文或任意上下文送到第三方。 */
function assertNormalizedWord(normalizedWord: string): void {
  if (!/^[a-z]+$/.test(normalizedWord)) {
    throw new Error("在线词典只接受小写英文规范键");
  }
}

export class DictionaryService {
  constructor(private readonly deps: DictionaryServiceDeps) {}

  getSnapshot(wordId: string): DictionarySnapshot {
    if (this.deps.wordContentStore.getEntry(wordId) === null) {
      throw new Error("词条不存在");
    }
    const cached = this.deps.cacheStore.get(wordId);
    if (cached !== null) return cachedSnapshot(cached);
    return {
      status: "未查询", provider: "在线词典", fetchedAt: null, definitions: [],
      message: "尚未查询在线补充释义", needsRefresh: true,
    };
  }

  /**
   * 页面打开详情或测试揭示答案时调用。缓存命中不联网；force 仅供用户显式重新查询。
   * 失败返回临时快照并记一次失败事件；取消只结束当前请求，绝不产生事件或缓存。
   */
  async load(
    wordId: string,
    options: { readonly force?: boolean; readonly isCancelled?: () => boolean; readonly auditFailure?: boolean } = {},
  ): Promise<DictionarySnapshot> {
    const word = this.deps.wordContentStore.getEntry(wordId);
    if (word === null || word.removed) throw new Error("词条不存在");
    const existing = this.deps.cacheStore.get(wordId);
    if (existing !== null && !options.force) return cachedSnapshot(existing);
    assertNormalizedWord(word.normalizedKey);
    if (options.isCancelled?.()) throw new DictionaryLookupCancelledError("在线词典查询已取消");

    let result;
    try {
      result = await this.deps.dictionary.lookup(word.normalizedKey, {
        isCancelled: options.isCancelled,
      });
      if (options.isCancelled?.()) throw new DictionaryLookupCancelledError("在线词典查询已取消");
      this.validateResult(result, word.normalizedKey);
    } catch (error) {
      if (error instanceof DictionaryLookupCancelledError || options.isCancelled?.()) {
        throw new DictionaryLookupCancelledError("在线词典查询已取消");
      }
      const message = error instanceof Error ? error.message : "在线词典查询失败";
      // V1 测试页预拉失败完全静默，不污染学习审计；词汇详情显式查询失败才记录。
      if (options.auditFailure !== false) {
        this.deps.unitOfWork.run(() => {
          this.deps.eventStore.appendEvents([this.deps.eventRecorder.record({
            eventType: "dictionaryFetchFailed", targetType: "Word", targetId: wordId,
            source: "在线词典", metadata: { message },
          })]);
        });
      }
      // 显式重查失败时保留原有成功释义；仅无内容时呈现 V1 的失败及重试入口。
      if (existing !== null) return cachedSnapshot(existing);
      return {
        status: "查询失败", provider: "在线词典", fetchedAt: this.deps.clock.now().toISOString(),
        definitions: [], message, needsRefresh: true,
      };
    }

    // 网络等待期间词内容可能已被编辑或软移除；旧词结果绝不可写到新词身份上。
    const current = this.deps.wordContentStore.getEntry(wordId);
    if (current === null || current.removed || current.normalizedKey !== word.normalizedKey) {
      throw new DictionaryLookupCancelledError("词条已变更，取消旧在线词典结果");
    }
    const record: DictionaryCacheRecord = {
      id: this.deps.idGenerator.nextId(), wordId,
      provider: result.provider, normalizedWord: result.normalizedWord,
      definitions: result.definitions, rawResponseSummary: result.rawResponseSummary,
      fetchedAt: this.deps.clock.now().toISOString(), cacheStatus: "有效",
    };
    this.deps.unitOfWork.run(() => {
      this.deps.eventStore.appendEvents([this.deps.eventRecorder.record({
        eventType: "dictionaryFetched", targetType: "Word", targetId: wordId,
        source: record.provider, metadata: { definitionCount: record.definitions.length },
      })]);
      this.deps.cacheStore.replace(record);
      this.deps.cacheStore.pruneBySize(DICTIONARY_CACHE_MAX_BYTES);
    });
    return cachedSnapshot(record);
  }

  private validateResult(result: import("./ports.ts").DictionaryLookupPayload, requestedWord: string): void {
    if (!result.provider?.trim() || result.normalizedWord !== requestedWord ||
        !result.rawResponseSummary?.trim() || !Array.isArray(result.definitions) ||
        result.definitions.length === 0 ||
        result.definitions.some((item) => !item.partOfSpeech?.trim() || !item.definition?.trim())) {
      throw new DictionaryLookupResponseError("词典适配器返回结果不符合应用契约");
    }
  }
}
