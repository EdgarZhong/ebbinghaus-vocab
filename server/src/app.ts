/**
 * Fastify 应用组合根：插件、鉴权、统一错误处理与路由注册。
 *
 * buildApp 与进程入口（index.ts）分离的原因：测试需要在不监听端口、不读环境
 * 变量的前提下构建完整应用（fastify.inject），组合根只依赖注入项（库句柄、
 * token、时钟），生产与测试共享同一条组装路径，杜绝"测试专用第二套逻辑"。
 *
 * 库句柄（better-sqlite3）的生命周期归调用方：buildApp 不负责关闭数据库——
 * 测试在 app.close() 后仍需读库断言，进程入口在信号处理中自行收尾。
 */

import Fastify, { type FastifyInstance } from "fastify";
import compress from "@fastify/compress";
import type Database from "better-sqlite3";

import { errorCodes } from "@ebbinghaus/protocol";

import { requireBearerToken } from "./auth.ts";
import { ApiError, validationFailedError } from "./errors.ts";
import { createSyncStore } from "./store.ts";
import { registerHealthRoutes } from "./routes/health.ts";
import { registerSettingsRoutes } from "./routes/settings.ts";
import { registerSyncRoutes } from "./routes/sync.ts";

/** buildApp 可注入项。 */
export interface BuildAppOptions {
  /** 已打开并完成迁移的 SQLite 权威库句柄（生命周期归调用方）。 */
  readonly db: Database.Database;
  /** Bearer 访问令牌（启动配置提供；测试注入随机 token）。 */
  readonly authToken: string;
  /** 可注入时钟：received_at / server_updated_at / health.now 统一取自这里。 */
  readonly now?: () => Date;
  /** 请求体上限（字节）。 */
  readonly bodyLimit?: number;
  /** Fastify 日志开关（生产入口开启，测试保持安静）。 */
  readonly logger?: boolean;
}

/** 请求体上限默认 16 MiB：push 整批事务要求一次收全一批事件，Fastify 默认 1 MiB
 *  会在大批次上截断并破坏"整批原子"的重试语义；个人自用规模 16 MiB 足够宽松。 */
const DEFAULT_BODY_LIMIT_BYTES = 16 * 1024 * 1024;

/** 构建完整 Fastify 应用（不监听端口；listen 由进程入口或集成测试负责）。 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const now = options.now ?? (() => new Date());

  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: options.bodyLimit ?? DEFAULT_BODY_LIMIT_BYTES,
  });

  // 传输压缩：threshold 0 让任意大小的响应都按 Accept-Encoding 压缩，保证弱网
  // 优化在测试中可断言（判断文件 D4）。带 Content-Encoding: gzip 的请求体由本
  // 插件解压后再交给 JSON 解析器。
  // 必须 await：fastify 插件是异步装载的，未等待时 inject/请求可能在压缩与解压
  // hook 生效前被处理（实测导致 gzip 请求 400、响应不压缩的静默失效）。
  await app.register(compress, { threshold: 0 });

  // 鉴权：除 /health 外全部路由要求 Bearer token（D1）。鉴权在全局 onRequest
  // hook 实施，未匹配路由同样先鉴权再 404——避免未授权方借 404 差异探测路径。
  app.addHook("onRequest", async (request, _reply) => {
    const url = request.routeOptions.url;
    if (url === "/health") {
      return;
    }
    requireBearerToken(request.headers.authorization, options.authToken);
  });

  // 统一错误形态 { error: { code, message } }（B7）。
  // Fastify 5.12 的错误处理器把 error 声明为 unknown，这里统一收窄为最小错误视图。
  app.setErrorHandler((error, request, reply) => {
    const asError = error as { statusCode?: number; code?: string; message?: string };
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message },
      });
    }

    // JSON 请求体损坏/为空：本质是"内容未通过校验"，按 B7 归入 400 VALIDATION_FAILED。
    // （Fastify 5 的 JSON 解析错误码为 FST_ERR_CTP_INVALID_JSON_BODY；旧码一并保留
    // 以防不同小版本间码值漂移。）
    const parseErrorCodes = new Set([
      "FST_ERR_CTP_INVALID_JSON",
      "FST_ERR_CTP_INVALID_JSON_BODY",
      "FST_ERR_CTP_EMPTY_JSON_BODY",
    ]);
    if (parseErrorCodes.has(asError.code ?? "")) {
      const apiError = validationFailedError(asError.message ?? "请求体不是合法 JSON");
      return reply.code(apiError.statusCode).send({
        error: { code: apiError.code, message: apiError.message },
      });
    }

    const statusCode = asError.statusCode ?? 500;
    if (statusCode >= 500) {
      // 内部错误只回通用文案，细节进日志（防实现细节外泄）。
      request.log.error(error);
      return reply.code(500).send({
        error: { code: errorCodes.internal, message: "服务器内部错误" },
      });
    }

    // 其余 Fastify 4xx（415 不支持的媒体类型、413 请求体过大等）保持状态码，
    // 统一形态输出；code 用 Fastify 内建错误码，兜底 HTTP_<status>。
    return reply.code(statusCode).send({
      error: {
        code: asError.code ?? `HTTP_${statusCode}`,
        message: asError.message ?? `请求处理失败（HTTP ${statusCode}）`,
      },
    });
  });

  // 404 也统一形态（提示 method 与 path 便于排障；鉴权 hook 已先行把关）。
  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send({
      error: { code: "NOT_FOUND", message: `路径不存在：${request.method} ${request.url}` },
    });
  });

  // 路由注册：存取层在组合根创建并共享同一库句柄。
  const store = createSyncStore(options.db);
  registerHealthRoutes(app, { now });
  registerSyncRoutes(app, { db: options.db, store, now });
  registerSettingsRoutes(app, { db: options.db, store, now });

  return app;
}
