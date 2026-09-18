/**
 * 健康检查路由。
 *
 * /health 免鉴权（唯一例外）：供部署侧探活与客户端连通性自检；只返回服务器
 * 当前时刻，不参与任何领域语义（protocol healthResponseSchema 注释同口径）。
 */

import type { FastifyInstance } from "fastify";

import { parseOutgoingContract } from "../contract.ts";
import { healthResponseSchema } from "@ebbinghaus/protocol";

/** 注册 GET /health。now 为可注入时钟（与业务路由共享同一注入点）。 */
export function registerHealthRoutes(
  app: FastifyInstance,
  deps: { now: () => Date },
): void {
  app.get("/health", async () => {
    return parseOutgoingContract(
      healthResponseSchema,
      { status: "ok", now: deps.now().toISOString() },
    );
  });
}
