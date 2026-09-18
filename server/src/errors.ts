/**
 * 统一错误语义（docs/V2首轮自主判断与口径收敛.md B7）。
 *
 * 口径：
 * - 401 = Bearer 鉴权失败；400 = schema 校验失败（附 Zod 摘要）或查询参数非法。
 * - push 中重复 event_id 不是错误（幂等成功，逐事件 duplicated 回执），不用 409/416。
 * - 所有错误响应统一 `{ error: { code, message } }` 形态（protocol errorResponseSchema）。
 *   code 取值集合以 protocol errorCodes 建议值为基准（协议 schema 只约束非空字符串，
 *   服务器额外使用 NOT_FOUND / METHOD_NOT_ALLOWED / UNSUPPORTED_MEDIA_TYPE 等传输层
 *   错误码，同样落在统一形态内，客户端可按 code 单点处理）。
 * - 401 的 message 必须是固定文案：绝不能回显请求中携带的 token（哪怕格式错误的
 *   token），避免把凭证碎片写进响应体与访问日志。
 */

import { errorCodes } from "@ebbinghaus/protocol";

/** 服务器内部可控错误：handler 与 hook 主动抛出，由 app.ts 的错误处理器渲染为统一形态。 */
export class ApiError extends Error {
  /** HTTP 状态码。 */
  readonly statusCode: number;
  /** 稳定错误码（客户端与日志按此定位，不依赖 message 文案）。 */
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** 401：Bearer 鉴权失败。message 固定文案，不回显请求中的任何凭证内容。 */
export function unauthorizedError(): ApiError {
  return new ApiError(
    401,
    errorCodes.unauthorized,
    "缺少或无效的 Bearer 访问令牌",
  );
}

/**
 * 400：请求体 schema 校验失败。
 * summary 是 Zod 错误摘要（多行），必须足够让客户端定位是哪个事件/哪个字段非法。
 */
export function validationFailedError(summary: string): ApiError {
  return new ApiError(
    400,
    errorCodes.validationFailed,
    `请求体校验失败：\n${summary}`,
  );
}

/** 400：查询参数非法（after_seq/limit 非数字、负数、越界等）。 */
export function invalidQueryError(message: string): ApiError {
  return new ApiError(400, errorCodes.invalidQuery, message);
}
