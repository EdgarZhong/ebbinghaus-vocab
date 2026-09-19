/**
 * 持久化层统一错误类型。
 *
 * 设计原则与 packages/application/src/errors.ts 一致：错误信息全部是可定位问题的
 * 中文文案；所有错误继承 Error，保持 `instanceof` 可判定。同步错误家族刻意与
 * 应用层错误分离——它们表达的是传输/存储基础设施的失败，应用层按类型决定"提示
 * 用户"还是"静默退避"，绝不解析错误消息文本。
 */

/** 重复追加已存在的事件（append-only 铁律被编程性破坏）。 */
export class DuplicateEventError extends Error {
  /** 重复的事件标识。 */
  public readonly eventId: string;

  constructor(eventId: string) {
    super(`事件 ${eventId} 已存在于本地事件存储，append-only 禁止重复追加`);
    this.name = "DuplicateEventError";
    this.eventId = eventId;
  }
}

// ---------------------------------------------------------------------------
// 同步错误家族（SyncEngine 与 HttpSyncGateway 的失败语义）
// ---------------------------------------------------------------------------

/** 同步错误基类：网络、HTTP 与协议契约三类失败共同继承，便于统一判定。 */
export class SyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncError";
  }
}

/**
 * 网络层失败：连接被拒、DNS 解析失败、请求中途断开等 fetch 抛出的传输错误。
 * 语义上属于"可退避重试"的暂时性失败（断线不改变应用模式，AGENTS.md）。
 */
export class SyncNetworkError extends SyncError {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message);
    this.name = "SyncNetworkError";
    this.cause = options?.cause;
  }
}

/**
 * 服务器返回了非 2xx 状态：401 鉴权失败、400 校验失败、5xx 内部错误等。
 * 服务器错误响应统一为 { error: { code, message } }（协议 B7），字段在此结构化
 * 保留，供调用方区分"重试有望解决"（5xx/网络）与"必须人工介入"（400/401）。
 */
export class SyncHttpError extends SyncError {
  public readonly statusCode: number;
  /** 服务器错误码（errorCodes 家族）；无法解析响应体时为 null。 */
  public readonly code: string | null;

  constructor(statusCode: number, code: string | null, message: string) {
    super(`同步服务器返回 HTTP ${statusCode}${code === null ? "" : `（${code}）`}：${message}`);
    this.name = "SyncHttpError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * 服务器响应不符合协议契约（schema 校验失败）。
 * 双端共享同一 protocol 包，走到这里说明某端实现漂移，属于必须暴露的缺陷，
 * 绝不允许静默采用未校验数据污染本地事件流。
 */
export class SyncContractError extends SyncError {
  constructor(message: string) {
    super(message);
    this.name = "SyncContractError";
  }
}
