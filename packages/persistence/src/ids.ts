/**
 * ID 生成与设备身份的通用实现。
 *
 * 口径来源：
 * - IdGenerator（application/ports.ts）：所有实体标识必须经它生成，产生 UUIDv4
 *   形态（事件 eventId 与 settings deviceId 都要过协议 uuidV4Schema 校验）；
 * - B5（判断文件）：deviceId 为设备首次启动生成并持久化的 UUIDv4，无注册机制。
 *
 * 默认实现使用 Web Crypto 的 `crypto.randomUUID`：Node 24 与全部现代浏览器都
 * 提供该全局 API，内存运行时因此不依赖任何 Node 专属模块（浏览器模式可直接
 * 复用本文件）。持久化层禁止直接调用 crypto 的铁律针对业务代码；本文件是该
 * 约束的集中实现点，与 SystemClock 同理。
 */

import type { IdGenerator } from "@ebbinghaus/application";

/** UUIDv4 形态的最小校验（与协议 uuidV4Schema 同规则；此处只做防御性断言）。 */
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * 断言标识满足 UUIDv4 形态：形态错误属于平台环境缺陷或库被外部改写，立即失败。
 * 供本包所有需要把"形态正确性"当作前置条件的读写点复用（事件 deviceId、settings
 * deviceId、设备身份持久化值的防御性校验）。
 */
export function assertUuidV4Shape(value: string, description: string): string {
  if (!UUID_V4_PATTERN.test(value)) {
    throw new Error(`${description}不是 UUIDv4 形态：${value}`);
  }
  return value;
}

/** 断言生成的标识满足 UUIDv4 形态：形态错误属于平台环境缺陷，立即失败。 */
function assertGeneratedUuidV4(value: string): string {
  return assertUuidV4Shape(value, "ID 生成器产生了非法标识");
}

/**
 * 默认 ID 生成器：包装 Web Crypto 的 randomUUID。
 * `randomUuid` 可注入以便测试复现固定标识序列（组合根无需关心）。
 */
export class CryptoUuidV4IdGenerator implements IdGenerator {
  private readonly randomUuid: () => string;

  constructor(randomUuid: () => string = () => globalThis.crypto.randomUUID()) {
    this.randomUuid = randomUuid;
  }

  nextId(): string {
    return assertGeneratedUuidV4(this.randomUuid());
  }
}
