/**
 * 学习事件工厂：应用层全部事件的唯一产生入口。
 *
 * 业务原因：
 * - 事件是 V2 的权威事实，信封字段（eventId/deviceId/deviceSeq/occurredAt/learningDay）
 *   来自四个可注入端口（ID 生成、设备身份、设备序号、时钟），任何用例都不得绕过
 *   本工厂自行拼事件，否则"事件必过协议校验、序号必单调、时间必经时钟"三条铁律
 *   就会在某个调用点被破坏。
 * - 每个事件在产生处立即过 `learningEventSchema` 校验（fail fast）：产生非法事件的
 *   是编程错误，绝不允许带病流入存储与同步通道。
 * - learningDay 由当前用户设置（时区 + 换日时间）从 occurredAt 投影，保证同一事实
 *   在任何设备上按各自设置解析出一致的学习日标签。
 *
 * 另提供 `deriveListTaskId`：词书计划任务的稳定标识。V1 用 uuid5（SHA-1 摘要）；
 * V2 应用层禁止直接调用 crypto（架构守卫），改用 FNV-1a 多盐摘要拼装成 UUIDv4
 * 形态——只要输入（算法版本、List、任务类型、计划日）相同，跨刷新、跨重启得到
 * 同一标识，满足"重复刷新不产生第二个任务"的幂等语义。标识值本身与 V1 不同：
 * 任务 ID 是内部引用键，不做跨版本数据迁移。
 */

import { learningEventSchema, type LearningEventType } from "@ebbinghaus/protocol";
import {
  resolveLearningDay,
  type LearningDay,
  type LearningDaySettings,
} from "@ebbinghaus/domain";
import type {
  ApplicationEvent,
  DeviceIdentityProvider,
  DeviceSeqAllocator,
  IdGenerator,
} from "./ports.ts";

/** 事件工厂依赖：全部经组合根注入，测试注入确定性假实现。 */
export interface LearningEventRecorderDeps {
  readonly clock: import("@ebbinghaus/domain").Clock;
  readonly idGenerator: IdGenerator;
  readonly deviceIdentity: DeviceIdentityProvider;
  readonly deviceSeqAllocator: DeviceSeqAllocator;
  /** 读取当前学习日设置（时区 + 换日时间）；通常绑定到 SettingsService。 */
  readonly readLearningDaySettings: () => LearningDaySettings;
}

export class LearningEventRecorder {
  private readonly deps: LearningEventRecorderDeps;

  constructor(deps: LearningEventRecorderDeps) {
    this.deps = deps;
  }

  /**
   * 构造并校验一个学习事件。
   *
   * @param input.eventType     协议 18 类事件类型之一。
   * @param input.targetType    目标类型（"Word" | "List" | "TestSession" | "条目"）。
   * @param input.targetId      目标实体标识。
   * @param input.source        事件来源的稳定人类可读描述（审计用）。
   * @param input.metadata      按事件类型的 metadata 负载（协议 looseObject 校验）。
   * @param input.occurredAt    显式发生时刻；省略时取时钟当前时刻。
   */
  record(input: {
    readonly eventType: LearningEventType;
    readonly targetType: string;
    readonly targetId: string;
    readonly source: string;
    readonly metadata: Record<string, unknown>;
    readonly occurredAt?: Date;
  }): ApplicationEvent {
    const occurredAt = input.occurredAt ?? this.deps.clock.now();
    const occurredAtIso = occurredAt.toISOString();
    const learningDay: LearningDay = resolveLearningDay(
      occurredAt,
      this.deps.readLearningDaySettings(),
    );
    const candidate = {
      eventId: this.deps.idGenerator.nextId(),
      eventType: input.eventType,
      targetType: input.targetType,
      targetId: input.targetId,
      occurredAt: occurredAtIso,
      learningDay,
      source: input.source,
      deviceId: this.deps.deviceIdentity.getDeviceId(),
      deviceSeq: this.deps.deviceSeqAllocator.nextSeq(),
      metadata: input.metadata,
    };
    const parsed = learningEventSchema.safeParse(candidate);
    if (!parsed.success) {
      const summary = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      throw new Error(`产生的事件未通过协议 schema 校验，禁止入库：${summary}`);
    }
    // 协议输出类型因 Zod 工厂泛型退化带索引签名；字段集合已由 strictObject 校验，
    // 这里收窄为应用层结构化视图（见 ports.ts ApplicationEvent 说明）。
    return parsed.data as unknown as ApplicationEvent;
  }
}

// ---------------------------------------------------------------------------
// 确定性摘要与任务标识
// ---------------------------------------------------------------------------

/** FNV-1a 32 位摘要（与 domain/capacity.ts 指纹同族；只用于相等性，不承担密码学职责）。 */
export function hashTextFnv1a(text: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 把 32 位摘要格式化为 8 位十六进制。 */
function hex32(value: number): string {
  return value.toString(16).padStart(8, "0");
}

/**
 * 派生词书计划任务的稳定标识（UUIDv4 形态，事件与任务引用处处可校验）。
 *
 * 幂等语义：同一（算法版本, List, 任务类型, 计划日）重复刷新必然得到同一标识，
 * 上游据此实现"重复刷新不插入第二个任务"；逾期不改写计划日，因此逾期任务的
 * 标识也保持稳定。
 */
export function deriveListTaskId(input: {
  readonly algorithmVersion: string;
  readonly listId: string;
  readonly taskType: string;
  readonly scheduledDay: string;
}): string {
  const source = `${input.algorithmVersion}|${input.listId}|${input.taskType}|${input.scheduledDay}`;
  // 四个不同盐的摘要拼成 128 位，再按 RFC 9522 设置 v4 版本位与 10xx 变体位，
  // 使任务标识可以直接通过协议 uuidV4Schema 校验。
  const h1 = hex32(hashTextFnv1a(source));
  const h2 = hex32(hashTextFnv1a(source, 0x01000193));
  const h3 = hex32(hashTextFnv1a(source, 0x9747b28c));
  const h4 = hex32(hashTextFnv1a(source, 0x85ebca6b));
  const versioned = `4${h3.slice(1)}`;
  const variant = `8${h4.slice(1)}`;
  return `${h1}-${h2.slice(0, 4)}-${versioned.slice(0, 4)}-${variant.slice(0, 4)}-${h2.slice(4)}${h4.slice(0, 8)}`.slice(
    0,
    36,
  );
}
