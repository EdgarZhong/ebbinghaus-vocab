/**
 * Bearer token 鉴权（判断文件 D1 + B7）。
 *
 * 单用户静态 token：启动配置提供，除 /health 外全部路由必须携带
 * `Authorization: Bearer <token>`。比较使用 timingSafeEqual 防时序侧信道——
 * 个人自用场景风险低，但实现成本近零，防御性收下。长度不等时直接判否：
 * timingSafeEqual 要求等长输入，长度差异本身泄露的信息量（token 长度）可接受。
 *
 * 错误响应固定 401 + 固定文案：绝不回显请求中携带的 token（哪怕它格式错误），
 * 防止凭证碎片进入响应体、代理日志与错误追踪。
 */

import { timingSafeEqual } from "node:crypto";

import { unauthorizedError } from "./errors.ts";

/** Bearer 前缀（大小写不敏感是 HTTP 惯例，scheme 名不区分大小写）。 */
const BEARER_PREFIX = "bearer ";

/**
 * 校验 Authorization 头。通过则返回；失败抛 401 ApiError。
 * expectedToken 是启动配置中的权威 token，绝不参与错误消息拼装。
 */
export function requireBearerToken(
  authorizationHeader: string | undefined,
  expectedToken: string,
): void {
  if (
    authorizationHeader === undefined ||
    !authorizationHeader.toLowerCase().startsWith(BEARER_PREFIX)
  ) {
    throw unauthorizedError();
  }

  const presented = authorizationHeader.slice(BEARER_PREFIX.length).trim();
  const expected = Buffer.from(expectedToken, "utf8");
  const candidate = Buffer.from(presented, "utf8");

  if (expected.length !== candidate.length || !timingSafeEqual(expected, candidate)) {
    throw unauthorizedError();
  }
}
