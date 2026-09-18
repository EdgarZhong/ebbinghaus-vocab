/**
 * 协议契约自校验辅助。
 *
 * 服务器是 protocol 的第一消费方：不仅请求要先过 protocol Zod schema，服务器自己
 * 构造的响应也回过头过一遍 protocol schema 再发送。这样做的业务原因：
 * - 服务器与客户端共享同一份契约，一旦服务器实现与协议漂移（字段改名、形态变化），
 *   响应自校验会在服务器侧立刻炸出，而不是等客户端解析时才发现；
 * - "哑服务器"的铁律是只传输协议允许的形态，自校验是这一铁律的机器断言。
 * 响应自校验失败属于服务器编程错误（不是客户端错误），因此抛出普通 Error 走 500。
 */

import { z } from "zod";

/** 用指定 schema 校验一个"应当已经符合契约"的值（服务器出站响应），失败即抛错。 */
export function parseOutgoingContract<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `服务器出站响应违反 protocol 契约，属于服务器实现缺陷：\n${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}
