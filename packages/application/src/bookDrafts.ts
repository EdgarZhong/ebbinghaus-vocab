/**
 * 首过草稿应用门面：原始转写、候选预览与失败原因在正式首过确认前持久保留。
 * 同一毫秒连续编辑使用单调 updatedAt，避免云端 LWW 把较早字段覆盖较晚字段。
 * 草稿内容含用户原文，任何方法都不得记录正文或整理证据到日志。
 */
import type {
  Clock, DeviceIdentityProvider, FirstPassDraftRecord, FirstPassDraftStore, IdGenerator,
} from "./ports.ts";

export interface BookDraftServiceDeps {
  readonly clock: Clock;
  readonly deviceIdentity: DeviceIdentityProvider;
  readonly idGenerator: IdGenerator;
  readonly drafts: FirstPassDraftStore;
}

export class BookDraftService {
  private lastUpdatedAtMs = Number.NEGATIVE_INFINITY;
  constructor(private readonly deps: BookDraftServiceDeps) {}

  listOpenDrafts(spaceId: string): readonly FirstPassDraftRecord[] {
    return this.deps.drafts.listOpenDrafts(spaceId);
  }

  getDraft(id: string): FirstPassDraftRecord | null {
    return this.deps.drafts.getDraft(id);
  }

  /** 每次输入变化保存当前草稿；原文尚未整理时候选与审计保持已有值或 null。 */
  saveDraft(input: {
    readonly id?: string | null;
    readonly spaceId: string;
    readonly unitNumber: number;
    readonly listNumber: number;
    readonly rawText: string;
    readonly useLanguageModel: boolean;
    readonly status?: FirstPassDraftRecord["status"];
    readonly lastError?: string | null;
    readonly candidatesJson?: string | null;
    readonly auditJson?: string | null;
    readonly unresolvedDescription?: string | null;
  }): FirstPassDraftRecord {
    if (!Number.isSafeInteger(input.unitNumber) || input.unitNumber < 1 || !Number.isSafeInteger(input.listNumber) || input.listNumber < 1) {
      throw new Error("Unit 和 List 编号必须是正整数");
    }
    const existing = input.id === undefined || input.id === null ? null : this.deps.drafts.getDraft(input.id);
    if (existing !== null && existing.spaceId !== input.spaceId) throw new Error("草稿与当前 Space 不匹配");
    if (existing?.status === "已确认") throw new Error("已确认的草稿不得重新编辑");
    const status = input.status ?? existing?.status ?? "草稿";
    if (status === "已确认") throw new Error("请在正式首过保存后确认草稿");
    const record: FirstPassDraftRecord = {
      id: existing?.id ?? this.deps.idGenerator.nextId(),
      spaceId: input.spaceId, unitNumber: input.unitNumber, listNumber: input.listNumber,
      rawText: input.rawText, useLanguageModel: input.useLanguageModel,
      status, lastError: input.lastError ?? null,
      candidatesJson: input.candidatesJson === undefined ? existing?.candidatesJson ?? null : input.candidatesJson,
      auditJson: input.auditJson === undefined ? existing?.auditJson ?? null : input.auditJson,
      unresolvedDescription: input.unresolvedDescription === undefined ? existing?.unresolvedDescription ?? null : input.unresolvedDescription,
      updatedAt: this.nextUpdatedAt(), deviceId: this.deps.deviceIdentity.getDeviceId(),
    };
    this.deps.drafts.upsertDraft(record);
    return record;
  }

  /** 正式首过事件和内容目录写入成功后，把草稿标为已确认墓碑。 */
  confirmDraft(id: string): void {
    const existing = this.deps.drafts.getDraft(id);
    if (existing === null) throw new Error("首过草稿不存在");
    if (existing.status === "已确认") return;
    this.deps.drafts.upsertDraft({ ...existing, status: "已确认", lastError: null, updatedAt: this.nextUpdatedAt(), deviceId: this.deps.deviceIdentity.getDeviceId() });
  }

  private nextUpdatedAt(): string {
    const nowMs = this.deps.clock.now().getTime();
    this.lastUpdatedAtMs = Math.max(nowMs, this.lastUpdatedAtMs + 1);
    return new Date(this.lastUpdatedAtMs).toISOString();
  }
}
