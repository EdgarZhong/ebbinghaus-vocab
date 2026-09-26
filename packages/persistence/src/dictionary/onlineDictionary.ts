/** V1 有道与中文维基在线词典适配：同一英文规范键并发请求，首个成功返回。 */
import {
  DictionaryLookupCancelledError, DictionaryLookupNetworkError,
  DictionaryLookupResponseError, DictionaryLookupTimeoutError,
  type DictionaryDefinition, type DictionaryLookupPayload, type OnlineDictionaryPort,
} from "@ebbinghaus/application";

export type DictionarySource = "youdao" | "wiktionary";
export interface DictionaryHttpTransport {
  get(source: DictionarySource, normalizedWord: string, timeoutMs: number, signal: AbortSignal): Promise<string>;
}

const RETRY_DELAYS_MS = [200, 500, 1000] as const;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const WIKI_PARTS_OF_SPEECH = new Set([
  "名词", "名詞", "专有名词", "專有名詞", "动词", "動詞", "形容词", "形容詞",
  "副词", "副詞", "代词", "代詞", "介词", "介詞", "连词", "連詞",
  "感叹词", "感嘆詞", "限定词", "限定詞", "数词", "數詞", "冠词", "冠詞",
  "分词", "分詞", "短语", "片語", "词组", "詞組", "缩写", "縮寫",
]);

/** 浏览器模式的真实传输实现；测试可以注入确定性的 transport 复用同一解析逻辑。 */
export function createFetchDictionaryTransport(fetchImpl: typeof fetch = fetch): DictionaryHttpTransport {
  return {
    async get(source, normalizedWord, timeoutMs, signal) {
      const url = source === "youdao"
        ? `https://dict.youdao.com/jsonapi?q=${encodeURIComponent(normalizedWord)}`
        : `https://zh.wiktionary.org/w/api.php?${new URLSearchParams({
          action: "parse", page: normalizedWord, prop: "wikitext", format: "json", formatversion: "2",
        })}`;
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(abort, timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: "GET", headers: { Accept: "application/json" }, signal: controller.signal,
        });
        if (!response.ok) throw new DictionaryLookupNetworkError(`词典返回 HTTP ${response.status}`);
        const body = await response.arrayBuffer();
        if (body.byteLength > MAX_RESPONSE_BYTES) {
          throw new DictionaryLookupResponseError("词典响应超过安全大小上限");
        }
        return new TextDecoder().decode(body);
      } catch (error) {
        if (signal.aborted) throw new DictionaryLookupCancelledError("在线词典查询已取消");
        if (error instanceof DictionaryLookupNetworkError || error instanceof DictionaryLookupResponseError) throw error;
        if (controller.signal.aborted) throw new DictionaryLookupTimeoutError("在线词典查询超时");
        throw new DictionaryLookupNetworkError("无法连接在线词典");
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
      }
    },
  };
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return text.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|[a-z]+);/gi, (full, entity: string) => {
    if (entity.startsWith("#")) {
      const hex = entity[1]?.toLowerCase() === "x";
      const value = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : full;
    }
    return named[entity.toLowerCase()] ?? full;
  });
}

function cleanText(text: string): string {
  return decodeEntities(text.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim().replace(/^[ ；;,，]+|[ ；;,，]+$/g, "");
}

function flatten(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flatten).join("");
  if (value !== null && typeof value === "object") return Object.values(value).map(flatten).join("");
  return "";
}

export function parseYoudaoDefinitions(payload: unknown): DictionaryDefinition[] {
  const root = payload as { ec?: { word?: unknown } } | null;
  const words = root?.ec?.word;
  if (!Array.isArray(words) || words.length === 0) return [];
  const trs = (words[0] as { trs?: unknown } | null)?.trs;
  if (!Array.isArray(trs)) return [];
  const definitions: DictionaryDefinition[] = [];
  for (const item of trs) {
    const tr = (item as { tr?: unknown } | null)?.tr;
    if (!Array.isArray(tr)) continue;
    const text = cleanText(tr.map((node) => flatten((node as { l?: { i?: unknown } } | null)?.l?.i)).join(""));
    if (!text) continue;
    const match = /^(?:[a-zA-Z]{1,6}\.|短语|词组)\s*/.exec(text);
    const body = match === null ? text : text.slice(match[0].length).trim();
    definitions.push({ partOfSpeech: match !== null && body ? match[0].trim() : "释义", definition: body || text });
  }
  return definitions;
}

function cleanWikitext(value: string): string {
  let text = value;
  // 模板可以嵌套；重复删除最内层，避免把模板参数误当释义。
  while (/\{\{[^{}]*\}\}/.test(text)) text = text.replace(/\{\{[^{}]*\}\}/g, "");
  return cleanText(text.replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, "$1")
    .replace(/\[\[([^\]]+)\]\]/g, "$1").replace(/'{2,3}/g, ""));
}

export function parseWiktionaryDefinitions(wikitext: string): DictionaryDefinition[] {
  const lines = wikitext.split(/\r?\n/);
  let inEnglish = false;
  let partOfSpeech: string | null = null;
  const definitions: DictionaryDefinition[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^==\s*(?:英语|英語)\s*==$/.test(line)) { inEnglish = true; partOfSpeech = null; continue; }
    if (inEnglish && /^==[^=].*==$/.test(line)) break;
    if (!inEnglish) continue;
    const heading = /^===\s*([^=\n]+?)\s*===$/.exec(line);
    if (heading !== null) {
      const candidate = heading[1]?.trim() ?? "";
      partOfSpeech = WIKI_PARTS_OF_SPEECH.has(candidate) ? candidate : null;
      continue;
    }
    if (partOfSpeech !== null && /^#(?![#*:])/.test(line)) {
      const definition = cleanWikitext(line.slice(1));
      if (definition) definitions.push({ partOfSpeech, definition });
    }
  }
  return definitions;
}

function parseResponse(source: DictionarySource, normalizedWord: string, text: string): DictionaryLookupPayload {
  if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) {
    throw new DictionaryLookupResponseError("词典响应超过安全大小上限");
  }
  let payload: unknown;
  try { payload = JSON.parse(text); }
  catch { throw new DictionaryLookupResponseError("在线词典未返回有效 JSON"); }
  if (source === "youdao") {
    const definitions = parseYoudaoDefinitions(payload);
    if (definitions.length === 0) throw new DictionaryLookupResponseError("有道词典词条没有可识别的英汉释义");
    return { provider: "有道词典", normalizedWord, definitions,
      rawResponseSummary: `有道词典英汉释义：${definitions.length} 个义项` };
  }
  const wikitext = (payload as { parse?: { wikitext?: unknown } } | null)?.parse?.wikitext;
  if (typeof wikitext !== "string" || !wikitext.trim()) {
    throw new DictionaryLookupResponseError("维基词典响应缺少词条原文");
  }
  const definitions = parseWiktionaryDefinitions(wikitext);
  if (definitions.length === 0) throw new DictionaryLookupResponseError("维基词典词条没有可识别的英语中文释义");
  return { provider: "维基词典", normalizedWord, definitions,
    rawResponseSummary: `中文维基词典英语段落：${definitions.length} 个义项` };
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new DictionaryLookupCancelledError("在线词典查询已取消");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, ms);
    const cancel = () => { clearTimeout(timer); reject(new DictionaryLookupCancelledError("在线词典查询已取消")); };
    signal.addEventListener("abort", cancel, { once: true });
  });
}

async function lookupOne(
  source: DictionarySource, word: string, transport: DictionaryHttpTransport,
  signal: AbortSignal, isCancelled?: () => boolean,
): Promise<DictionaryLookupPayload> {
  const timeoutMs = source === "youdao" ? 6000 : 8000;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (signal.aborted || isCancelled?.()) throw new DictionaryLookupCancelledError("在线词典查询已取消");
    try {
      const text = await transport.get(source, word, timeoutMs, signal);
      if (signal.aborted || isCancelled?.()) throw new DictionaryLookupCancelledError("在线词典查询已取消");
      return parseResponse(source, word, text);
    } catch (error) {
      if (!(error instanceof DictionaryLookupNetworkError || error instanceof DictionaryLookupTimeoutError)
          || attempt === RETRY_DELAYS_MS.length) throw error;
      await delay(RETRY_DELAYS_MS[attempt]!, signal);
    }
  }
  throw new DictionaryLookupNetworkError("在线词典查询失败");
}

/** 两源并发、首个成功；全部失败时沿用 V1 的有道优先错误语义。 */
export function createConcurrentOnlineDictionary(transport: DictionaryHttpTransport): OnlineDictionaryPort {
  return {
    async lookup(normalizedWord, options) {
      if (!/^[a-z]+$/.test(normalizedWord)) throw new Error("在线词典只接受小写英文规范键");
      if (options?.isCancelled?.()) throw new DictionaryLookupCancelledError("在线词典查询已取消");
      const controllers = [new AbortController(), new AbortController()];
      const sources: readonly DictionarySource[] = ["youdao", "wiktionary"];
      const promises = sources.map((source, index) => lookupOne(
        source, normalizedWord, transport, controllers[index]!.signal, options?.isCancelled,
      ).then((result) => ({ index, result })));
      try {
        const winner = await Promise.any(promises);
        controllers.forEach((controller, index) => { if (index !== winner.index) controller.abort(); });
        return winner.result;
      } catch (error) {
        if (options?.isCancelled?.()) throw new DictionaryLookupCancelledError("在线词典查询已取消");
        if (error instanceof AggregateError) throw error.errors[0] as Error;
        throw error;
      }
    },
  };
}
