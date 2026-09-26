/**
 * @ebbinghaus/protocol 统一出口。
 *
 * 本包是双端（client / server）共享的同步协议唯一来源：事件 schema、设置 KV
 * schema、API 契约 schema 与领域重放排序。消费方（后续的 packages/domain、
 * packages/application、server、app）一律从包根导入，禁止深入 src/ 内部文件
 * 路径，保证内部结构调整不破坏消费方。
 */

export * from "./events.ts";
export * from "./settings.ts";
export * from "./sync.ts";
export * from "./ordering.ts";
export * from "./content.ts";
