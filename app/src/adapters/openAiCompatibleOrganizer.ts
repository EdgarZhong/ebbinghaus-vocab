/**
 * V1 智能整理的网络适配器：Chat Completions 只产生待复验 JSON，领域校验器才有权
 * 把它变为可编辑候选。原文、模型响应和密钥只在本次请求的内存中流转，不写日志。
 */
import { invoke } from "@tauri-apps/api/core";
import {
  identifyLlmProvider, LanguageModelCancelledError, LanguageModelNotConfiguredError,
  LanguageModelOrganizationError, LlmProvider,
  type LanguageModelOrganizerPort,
  type LlmConnectivityProbe,
} from "@ebbinghaus/application";
import {
  EntryOrganizingValidationError, renderIssue, validateEntryOrganizerPayload,
  type EntryOrganizationResult, type EntryOrganizingIssue,
} from "@ebbinghaus/domain";

export const ENTRY_ORGANIZER_PROMPT_VERSION = "entry-organizer-v3-system-prompt-v2";
const MAX_INTERACTIONS = 3;

/**
 * V1 提示词的业务约束。证据引用、订正警告及字段结构与原版一致；领域层继续逐字段
 * 校验，模型输出即使符合 JSON 格式也不能绕过证据检查。
 */
const SYSTEM_PROMPT = `You organize raw speech transcripts into structured English-learning entries.
Return exactly one JSON object for entry-organizer-v3, without Markdown or extra properties.
The object has schema_version="entry-organizer-v3", global_warning (Simplified Chinese string or null), and entries array.
Each entry has term {value, source_excerpt, optional warning} and meanings array.
Each meaning has part_of_speech {value, source_excerpt, optional warning}, definition {value, source_excerpt, optional warning}, and usage (null or {value, source_excerpt, optional warning}).
Allowed part_of_speech values: n., v., vt., vi., a., ad., prep., pron., conj., num., art., aux., modal., interj., det., or null.
Required structure: every term and non-null usage node has non-empty value and exact non-empty source_excerpt. Every definition node has non-empty value and source_excerpt that is either non-empty or null with a warning. Every part_of_speech node has value in the allowed set or null, source_excerpt as non-empty or null, and a warning whenever value or source_excerpt is null due to model inference. Each entry must have at least one meaning. Omit warning only when no correction or completion occurred.
Create entries only for English terms present in the transcript. One term may have several meanings. Preserve every explicit term, part of speech, Chinese definition, collocation, and example. A meaning is a complete semantic unit; spoken numbering or another repeated part of speech can mark a separate meaning. Keep each definition within 50 Chinese characters.
Completeness comes first: warnings explain corrections, completions, or uncertainty; they never replace field content. Even when a portion is uncertain, fill every part that can be determined. Do not drop a meaning or shrink a definition just to pass validation. A Chinese definition may contain several words such as “差别区分”; do not split it merely because it contains synonyms. Repeated parts of speech, spoken numbering, and “another meaning” mark distinct meanings even when the part of speech is the same.
Normalize spoken parts of speech into the allowed abbreviations. If the transcript states a part of speech for an entry, fill each meaning-level part of speech when it can be determined reliably. Inferred parts of speech use source_excerpt null and a same-node warning. If no part of speech is spoken for the entire entry, null is allowed.
If a spoken English term has no usable Chinese definition, supply its most common meaning, set source_excerpt to null on the supplied fields, and explain this in the same field's warning. Never invent a term, collocation, or example.
Every non-null source_excerpt must be an exact continuous substring of the user transcript, with original characters and punctuation. The same excerpt may support several fields. If you correct an obvious speech-recognition error, put the corrected text in value, preserve the original excerpt, and explain the correction in that same node's warning. Do not restore a known-wrong value or delete content to evade validation. Ordinary case, whitespace, Chinese punctuation form, and part-of-speech abbreviation do not require warnings.
Correct certainly-wrong tokens even when another portion remains uncertain; keep the closest plausible reading and explain the remaining uncertainty. source_excerpt is always original transcript text, never a corrected or fabricated quotation. Content with no original evidence uses null source_excerpt and a local warning. Do not fabricate evidence.
Usage belongs to one meaning. Put collocation first, then English example, then a concise Chinese translation in one string; translated content is allowed without a warning. If no usage exists, use null.
All warnings must be in Simplified Chinese and addressed to the user. global_warning is only for a whole-response issue that cannot be attached to a node.
When asked to repair numbered entries, respond with {"schema_version":"entry-organizer-v3","repaired_entries":[{"entry_index":0,"entry":{...}}]}. Regenerate only requested entries; preserve all others.
Example: "extension，名次，延期扩大，名词，伸展" has one entry and two meanings. Correct the first "名次" to n., quote "名次" unchanged as source_excerpt, and explain the correction in that part_of_speech node's warning.
Example: "distinction，名词，差别区分，名词，荣誉" has one distinction entry with two meanings; “差别区分” stays one definition and each occurrence of “名词” supports its own meaning.
Example: "conjunction，名词，同时发生，in conjunction with，Guilt emerges in conjunction with a child's growing grasp of moral norms" keeps the collocation and example in the same meaning's usage and adds a concise Chinese translation. The collocation does not become a separate term.
Example: "constitute，动词，组成,构成" may normalize the definition to "组成，构成" while quoting "组成,构成" exactly, without a warning.`;

export interface OrganizerConfiguration {
  readonly baseUrl: string;
  readonly modelName: string;
  readonly apiKey: string | null;
  readonly thinkingEnabled: boolean;
}

export interface CompletionRequest {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly body: string;
  readonly signal: AbortSignal;
}

/** 网络出口可替换，测试仅拦截请求；正式桌面端使用 Tauri Rust 命令跨过 WebView CORS。 */
export interface CompletionTransport {
  post(request: CompletionRequest): Promise<string>;
}

/** 同一请求的取消标识传入 Rust；即使前一轮晚返回，JS 层也会拒绝其结果。 */
export const tauriCompletionTransport: CompletionTransport = {
  async post(request) {
    const requestId = crypto.randomUUID();
    const abort = () => { void invoke("llm_http_cancel", { requestId }); };
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) {
      request.signal.removeEventListener("abort", abort);
      throw new LanguageModelCancelledError("用户已取消大语言模型整理请求");
    }
    try {
      const response = await invoke<string>("llm_http_post", {
        requestId, endpoint: request.endpoint, apiKey: request.apiKey, body: request.body,
      });
      if (request.signal.aborted) throw new LanguageModelCancelledError("用户已取消大语言模型整理请求");
      return response;
    } catch (cause) {
      if (request.signal.aborted) throw new LanguageModelCancelledError("用户已取消大语言模型整理请求");
      // Rust 仅返回分类错误，不回传请求体、密钥或远端响应正文。
      const message = String(cause);
      throw new LanguageModelOrganizationError(message.startsWith("llm:") ? message.slice(4) : "无法连接大语言模型服务");
    } finally {
      request.signal.removeEventListener("abort", abort);
    }
  },
};

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
type JsonObject = Record<string, unknown>;

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 仅从固定响应槽读取正文；空正文、非正常停止均是失败，不把推理文本当结果。 */
function completionContent(raw: string): { content: string; truncated: boolean } {
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { throw new LanguageModelOrganizationError("大语言模型 HTTP 响应不是 JSON 对象"); }
  const choices = object(payload) ? payload["choices"] : null;
  const choice = Array.isArray(choices) ? choices[0] : null;
  if (!object(choice)) throw new LanguageModelOrganizationError("大语言模型 HTTP 响应缺少 choices");
  const finishReason = choice["finish_reason"];
  if (finishReason !== "stop" && finishReason !== "length") {
    throw new LanguageModelOrganizationError("大语言模型整理未完整结束");
  }
  const message = choice["message"];
  const content = object(message) ? message["content"] : null;
  if (typeof content !== "string" || content.trim() === "") {
    throw new LanguageModelOrganizationError("大语言模型返回了空整理内容");
  }
  return { content: content.trim(), truncated: finishReason === "length" };
}

/** V1 局部修复：只能替换本地校验列出的词条；已通过词条不受模型后续回复影响。 */
function mergeRepair(base: JsonObject, raw: string, issues: readonly EntryOrganizingIssue[]): JsonObject {
  let repair: unknown;
  try { repair = JSON.parse(raw); } catch { throw new Error("修复响应不是 JSON 对象"); }
  if (!object(repair) || !Array.isArray(base["entries"])) throw new Error("修复响应缺少词条");
  const expected = new Set(issues.map((issue) => issue.entryIndex).filter((index): index is number => index !== null));
  const fullEntries = repair["entries"];
  const repaired = Array.isArray(repair["repaired_entries"])
    ? repair["repaired_entries"]
    : Array.isArray(fullEntries)
      ? [...expected].map((index) => ({ entry_index: index, entry: fullEntries[index] }))
      : null;
  if (repaired === null) throw new Error("修复响应缺少 repaired_entries");
  const entries = [...base["entries"]];
  for (const item of repaired) {
    if (!object(item) || !Number.isInteger(item["entry_index"]) || !object(item["entry"])) {
      throw new Error("修复响应的词条格式无效");
    }
    const index = item["entry_index"] as number;
    if (!expected.has(index) || index < 0 || index >= entries.length) throw new Error("修复响应包含未指定词条");
    entries[index] = item["entry"];
  }
  return {
    ...base,
    entries,
    ...(repair["schema_version"] === undefined ? {} : { schema_version: repair["schema_version"] }),
    ...(repair["global_warning"] === undefined ? {} : { global_warning: repair["global_warning"] }),
  };
}

/**
 * 只在组合根持有密钥；每次请求独立 AbortController，旧请求收尾不能取消新请求。
 * 三轮均失败时抛错并保留最后的未验证 payload 作草稿审计，不交付为学习数据。
 */
export class OpenAiCompatibleOrganizer implements LanguageModelOrganizerPort {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion = ENTRY_ORGANIZER_PROMPT_VERSION;
  lastInteractionCount = 0;
  private active: AbortController | null = null;

  constructor(private readonly configuration: OrganizerConfiguration, private readonly transport: CompletionTransport) {
    this.provider = identifyLlmProvider(configuration.baseUrl);
    this.model = configuration.modelName;
    const endpoint = new URL(configuration.baseUrl);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error("大语言模型基础地址必须使用 HTTPS");
    }
  }

  prepareCancellation(): void { /* 每次请求自有控制器，无需清理共享取消位。 */ }
  cancel(): void { this.active?.abort(); }

  async organize(rawText: string): Promise<EntryOrganizationResult> {
    const apiKey = this.configuration.apiKey?.trim();
    if (!apiKey) throw new LanguageModelNotConfiguredError("未配置大语言模型 API Key");
    const operation = new AbortController();
    this.active = operation;
    this.lastInteractionCount = 0;
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT }, { role: "user", content: rawText },
    ];
    let base: JsonObject | null = null;
    let issues: readonly EntryOrganizingIssue[] = [];
    let lastProblem = "整理结果无效";
    try {
      for (let turn = 1; turn <= MAX_INTERACTIONS; turn += 1) {
        this.lastInteractionCount = turn;
        if (operation.signal.aborted) throw new LanguageModelCancelledError("用户已取消大语言模型整理请求");
        const endpoint = `${this.configuration.baseUrl.replace(/\/+$/, "")}/chat/completions`;
        const provider = identifyLlmProvider(this.configuration.baseUrl);
        const deepseekOfficial = new URL(this.configuration.baseUrl).hostname === "api.deepseek.com";
        const body: Record<string, unknown> = {
          model: this.configuration.modelName, messages, temperature: 0, max_tokens: 32767,
          stream: false, response_format: { type: "json_object" },
        };
        if (provider === LlmProvider.AliyunBailian) {
          body["enable_thinking"] = this.configuration.thinkingEnabled;
          if (this.configuration.modelName === "deepseek-v4-flash-0731") delete body["response_format"];
        } else if (deepseekOfficial) {
          body["thinking"] = { type: this.configuration.thinkingEnabled ? "enabled" : "disabled" };
        } else {
          body["reasoning_effort"] = this.configuration.thinkingEnabled ? "high" : "none";
        }
        const response = await this.transport.post({ endpoint, apiKey, body: JSON.stringify(body), signal: operation.signal });
        if (operation.signal.aborted) throw new LanguageModelCancelledError("用户已取消大语言模型整理请求");
        const { content, truncated } = completionContent(response);
        if (!truncated) {
          try {
            if (base === null || !issues.some((issue) => issue.entryIndex !== null)) {
              const parsed: unknown = JSON.parse(content);
              if (!object(parsed)) throw new Error("整理结果不是 JSON 对象");
              base = parsed;
            } else {
              base = mergeRepair(base, content, issues);
            }
            return validateEntryOrganizerPayload(rawText, base);
          } catch (cause) {
            if (cause instanceof EntryOrganizingValidationError) {
              issues = cause.issues;
              lastProblem = issues.map(renderIssue).join("；").slice(0, 1000);
            } else {
              lastProblem = cause instanceof Error ? cause.message : "整理结果格式无效";
              // 无法合并的修复不覆盖上一轮基线；下一轮仍指向相同问题词条。
            }
          }
        } else {
          lastProblem = "模型输出已截断";
        }
        if (turn === MAX_INTERACTIONS) break;
        messages.push({ role: "assistant", content });
        const indices = [...new Set(issues.map((issue) => issue.entryIndex).filter((index): index is number => index !== null))];
        const repairInstruction = base !== null && indices.length > 0
          ? `entry-organizer-v3 校验失败。仅重写词条编号 ${indices.join(", ")}，返回 repaired_entries 信封。问题：${lastProblem}。不要改动其他词条，不要清空证据或删除义项。`
          : `entry-organizer-v3 结果无效：${lastProblem}。重新返回完整且未截断的 JSON 证据树。`;
        messages.push({ role: "user", content: repairInstruction });
      }
      throw new LanguageModelOrganizationError(`大语言模型整理结果连续三轮未通过本地校验：${lastProblem}`, { partialPayload: base });
    } finally {
      if (this.active === operation) this.active = null;
    }
  }
}

/** 设置保存后的下一次请求使用新配置；正式端在组合根注入本工厂。 */
export function createTauriOrganizer(configuration: OrganizerConfiguration): OpenAiCompatibleOrganizer {
  return new OpenAiCompatibleOrganizer(configuration, tauriCompletionTransport);
}

/** 与 V1 一致：GET /models 仅验证已保存连接和密钥，不发送原始转写。 */
export const tauriConnectivityProbe: LlmConnectivityProbe = {
  async probe(baseUrl, _modelName, apiKey) {
    if (!apiKey?.trim()) throw new LanguageModelNotConfiguredError("未配置大语言模型 API Key");
    const endpoint = `${baseUrl.replace(/\/+$/, "")}/models`;
    try {
      await invoke("llm_http_probe", { endpoint, apiKey });
    } catch (cause) {
      const message = String(cause);
      throw new LanguageModelOrganizationError(message.startsWith("llm:") ? message.slice(4) : "无法连接大语言模型服务");
    }
  },
};
