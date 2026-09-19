/**
 * 测试种子辅助：为 UI 测试构造"已存在学习事实"的服务状态。
 *
 * 种子一律走组合根暴露的应用层用例与事件工厂（eventRecorder），不绕过协议
 * 校验，保证种子数据与真实写入路径完全同构。时间经 createMutableClock 控制：
 * 服务创建时注入可变时钟 → 在过去播种学习事实 → 把时钟拨回 FIXED_NOW。
 * 全部用例与运行时端口共享同一 clock 引用，拨动立即全局生效。
 */

import { ConfirmedEntry, type Clock, type DeviceLocalStore } from "@ebbinghaus/application";
import { createStudyUnit } from "@ebbinghaus/domain";
import { createAppServices, type AppServices } from "../src/composition.ts";
import { FIXED_NOW, MemoryDeviceLocalStore, createSequenceIdGenerator } from "./helpers.tsx";

export { createMutableClock } from "./helpers.tsx";
import { createMutableClock } from "./helpers.tsx";

/** 用指定时钟创建测试服务（组合根全链路共享该引用）。 */
export function createTestServicesWithClock(clock: Clock, deviceLocal?: DeviceLocalStore): AppServices {
  return createAppServices({
    clock,
    deviceLocal: deviceLocal ?? new MemoryDeviceLocalStore(),
    idGenerator: createSequenceIdGenerator(),
  });
}

/** 含一条中文义项的确认条目（种子通用形态）。 */
function seedEntry(term: string): ConfirmedEntry {
  return new ConfirmedEntry(term, [{ partOfSpeech: "v.", definition: `释义：${term}`, usage: null }]);
}

/**
 * 一站式常规模式种子：创建常规模式 Space 并在 daysAgo 天前录入条目，随后把
 * 时钟拨回 FIXED_NOW——条目资格日（录入日 + 1）已过，新卡天然到期可测。
 * 返回服务实例与 Space 标识，调用方直接 renderApp(services)。
 */
export function seedRegularDueServices(
  terms: readonly string[],
  options: { readonly daysAgo?: number; readonly spaceName?: string } = {},
): { services: AppServices; spaceId: string } {
  const daysAgo = options.daysAgo ?? 2;
  const mutable = createMutableClock(new Date(FIXED_NOW.getTime() - daysAgo * 86_400_000));
  const services = createTestServicesWithClock(mutable.clock);
  const space = services.spaces.createAndActivate({
    name: options.spaceName ?? "种子积累",
    learningMode: "常规模式",
  });
  if (terms.length > 0) {
    services.regularLearning.recordEntries({
      spaceId: space.id,
      entries: terms.map((term) => seedEntry(term)),
    });
  }
  mutable.setNow(FIXED_NOW);
  return { services, spaceId: space.id };
}

/**
 * 词书模式种子：Unit 1 · List 4 仅含一个词，首过发生在 3 天前（T0），2 天前
 * 完成第一次短期测试（认识，0→1，新周期起点 T1）→ T1 + 1 的仅复习需求今天已
 * 逾期，而 T1 + 3 晋级测试（= T0 + 4）尚未到期 → 派生任务类型为"仅复习"，
 * 可直接确认纸质复习。
 */
export function seedBookSpaceWithReviewOnlyTask(services: AppServices): string {
  const space = services.spaces.createAndActivate({ name: "种子词书", learningMode: "词书模式" });
  const unitId = "seed-unit-1";
  const listId = "seed-list-4";
  services.runtime.bookCatalogStore.addUnit(createStudyUnit({ id: unitId, spaceId: space.id, number: 1 }));
  services.runtime.bookCatalogStore.addList({
    listId,
    spaceId: space.id,
    unitId,
    unitNumber: 1,
    listNumber: 4,
  });
  const firstPassedAt = new Date(FIXED_NOW.getTime() - 3 * 86_400_000);
  const testedAt = new Date(FIXED_NOW.getTime() - 2 * 86_400_000);
  const wordId = "seed-word-1";
  services.runtime.wordContentStore.upsertEntries([
    {
      wordId,
      listId,
      spaceId: null,
      originalSpelling: "abandon",
      normalizedKey: "abandon",
      manualMeaning: "v. 放弃",
      meanings: [{ partOfSpeech: "v." as const, definition: "放弃", usage: null }],
      removed: false,
      recordedAt: firstPassedAt.toISOString(),
    },
  ]);
  const firstPassEvent = services.eventRecorder.record({
    eventType: "firstPassRecorded",
    targetType: "List",
    targetId: listId,
    source: "测试种子",
    occurredAt: firstPassedAt,
    metadata: { workload: 1, wordCount: 1 },
  });
  const testEvent = services.eventRecorder.record({
    eventType: "testAnswered",
    targetType: "Word",
    targetId: wordId,
    source: "测试种子",
    occurredAt: testedAt,
    metadata: {
      sessionId: "seed-session-1",
      initialJudgement: "认识",
      finalJudgement: "认识",
      answerRevised: false,
      beforeState: { shortTermPassCount: 0, masteryStatus: "未掌握", t0: firstPassedAt.toISOString(), t1: null, t2: null },
      afterState: {
        shortTermPassCount: 1,
        masteryStatus: "未掌握",
        t0: firstPassedAt.toISOString(),
        t1: testedAt.toISOString(),
        t2: null,
      },
      algorithmVersion: "seed-v1",
    },
  });
  services.runtime.eventStore.appendEvents([firstPassEvent, testEvent]);
  return space.id;
}
