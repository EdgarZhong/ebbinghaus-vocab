/**
 * HTTP 同步网关：SyncGateway 端口的 fetch 实现（Node 18+ 与现代浏览器通用）。
 *
 * 设计要点：
 * - **传输与引擎分离**：SyncEngine 只依赖 SyncGateway 接口，测试注入假网关即可
 *   覆盖全部失败语义；本实现是唯一接触 HTTP 细节的地方。
 * - **gzip 请求体**（技术决策附录"弱网传输"硬性要求）：push/put 载荷用
 *   CompressionStream 压缩（Node 24 与现代浏览器均内置），环境不支持时优雅降级
 *   明文——服务器两种形态都接受（@fastify/compress）。
 * - **错误翻译**：网络层失败 → SyncNetworkError（可重试，进退避）；HTTP 非 2xx →
 *   SyncHttpError（携带服务器统一错误形态 { error: { code, message } } 的 code）；
 *   4xx 契约错误与 5xx/网络错误对引擎来说都只是"本轮失败"，但 code 保留观测价值。
 * - 响应体逐个过 protocol 响应 schema：绝不把未校验的线上数据写进本地库——
 *   服务器是哑的，客户端不能假设网络对端永远可信。
 */

import {
  settingsGetResponseSchema,
  settingsPutRequestSchema,
  settingsPutResponseSchema,
  syncPullQuerySchema,
  syncPullResponseSchema,
  syncPushRequestSchema,
  syncPushResponseSchema,
  type SettingEntry,
} from "@ebbinghaus/protocol";
import type { ApplicationEvent } from "@ebbinghaus/application";

import { SyncHttpError, SyncNetworkError } from "../errors.ts";

/** 同步网关端口：SyncEngine 的传输依赖（测试用内存假实现）。 */
export interface SyncGateway {
  push(events: readonly ApplicationEvent[]): Promise<ReadonlySet<string>>;
  pull(afterSeq: number, limit: number): Promise<{
    readonly events: readonly (ApplicationEvent & { readonly serverSeq: number })[];
    readonly nextCursor: number;
    readonly hasMore: boolean;
  }>;
  getSettings(): Promise<{ readonly settings: readonly SettingEntry[] }>;
  putSettings(entries: readonly SettingEntry[]): Promise<{ readonly settings: readonly SettingEntry[] }>;
}

interface BuildSyncGatewayOptions {
  readonly baseUrl: string;
  readonly authToken: string;
  /** 可注入 fetch（测试重定向/录制）；缺省用全局 fetch。 */
  readonly fetchImpl?: typeof fetch;
}

/** push/pull 分页上限与服务器策略一致（server/routes/sync.ts：默认 500 上限 2000）。 */
const PULL_PAGE_LIMIT = 500;

export function buildHttpSyncGateway(options: BuildSyncGatewayOptions): SyncGateway {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? fetch;

  /** 统一请求：Bearer 鉴权 + JSON/gzip + 错误翻译；返回已解析 JSON。 */
  async function requestJson(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${options.authToken}`,
    };
    let bodyPayload: string | ArrayBuffer | undefined;
    if (body !== undefined) {
      const json = JSON.stringify(body);
      if (typeof CompressionStream !== "undefined") {
        // gzip 请求体（弱网硬性要求）：CompressionStream 在 Node 24/现代浏览器可用。
        const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"));
        bodyPayload = await new Response(stream).arrayBuffer();
        headers["Content-Encoding"] = "gzip";
      } else {
        bodyPayload = json;
      }
      headers["Content-Type"] = "application/json";
    }
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: bodyPayload,
      });
    } catch (cause) {
      // fetch 对断网/DNS 失败/连接拒绝统一 throw：翻译为可重试的网络错误。
      throw new SyncNetworkError(`同步请求失败：${method} ${path}`, { cause });
    }
    if (!response.ok) {
      let code: string | null = null;
      let message = `同步服务器返回 ${response.status}`;
      try {
        const parsed = (await response.json()) as { error?: { code?: string; message?: string } };
        if (typeof parsed.error?.code === "string") code = parsed.error.code;
        if (typeof parsed.error?.message === "string") message = parsed.error.message;
      } catch {
        // 错误响应体不是 JSON：保留默认 message，code 为 null。
      }
      throw new SyncHttpError(response.status, code, message);
    }
    return response.json() as Promise<unknown>;
  }

  return {
    async push(events) {
      const requestBody = { events };
      const parsedRequest = syncPushRequestSchema.safeParse(requestBody);
      if (!parsedRequest.success) {
        // 客户端产生的事件在事件工厂已过协议校验；此处兜底防御（fail fast）。
        throw new SyncNetworkError("push 载荷未通过协议校验，拒绝发送");
      }
      const parsed = syncPushResponseSchema.parse(
        await requestJson("POST", "/sync/push", parsedRequest.data),
      );
      // accepted 与 duplicated 都意味着服务器已持久化（幂等成功），对账为已同步集合。
      const acknowledged = new Set<string>();
      for (const receipt of [...parsed.accepted, ...parsed.duplicated]) {
        acknowledged.add(receipt.eventId);
      }
      return acknowledged;
    },

    async pull(afterSeq, limit) {
      const query = syncPullQuerySchema.parse({
        after_seq: afterSeq,
        limit: Math.min(limit, PULL_PAGE_LIMIT),
      });
      const parsed = syncPullResponseSchema.parse(
        await requestJson("GET", `/sync/pull?after_seq=${query.after_seq}&limit=${query.limit}`),
      );
      return {
        // 协议 schema 已校验信封字段；metadata 在协议侧是开放记录（unknown 形态），
        // 与 ApplicationEvent 的 Record<string, unknown> 在运行时同形，这里统一收窄。
        events: parsed.events.map(
          (event) => event as unknown as ApplicationEvent & { readonly serverSeq: number },
        ),
        nextCursor: parsed.nextCursor,
        hasMore: parsed.hasMore,
      };
    },

    async getSettings() {
      return settingsGetResponseSchema.parse(await requestJson("GET", "/settings"));
    },

    async putSettings(entries) {
      const parsedRequest = settingsPutRequestSchema.parse({ settings: entries });
      const parsed = settingsPutResponseSchema.parse(
        await requestJson("PUT", "/settings", parsedRequest),
      );
      return parsed;
    },
  };
}
