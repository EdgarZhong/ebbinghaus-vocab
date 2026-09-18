import type { LearningEvent, LearningEventType, StoredLearningEvent } from "../src/events.ts";

/**
 * 测试共享 fixture：合法事件信封基线与各事件类型的合法 metadata 样例。
 *
 * 样例字段取自 V1 实际事件构造（packages/protocol/src/events.ts 注释中逐类标注
 * 了 V1 来源），保证测试数据与真实历史数据形态一致，而不是拍脑袋的占位值。
 */

/** 合法 UUIDv4 样例（版本位 4、变体位 8/9，可通过 z.uuid v4 校验）。 */
export const SAMPLE_EVENT_ID = "a3f1c2d4-e5b6-4c7d-8a9b-0c1d2e3f4a5b";
export const SAMPLE_DEVICE_ID = "b7e2f3a4-1c5d-4e8f-9a0b-2c3d4e5f6a7b";

/** 合法 UTC 时刻样例。 */
export const SAMPLE_OCCURRED_AT = "2026-09-19T12:30:00Z";
/** 合法学习日样例。 */
export const SAMPLE_LEARNING_DAY = "2026-09-19";

/** 词书模式 Word 状态快照（V1 review_testing.py `_word_state` 形态）。 */
export const BOOK_WORD_STATE = {
  shortTermPassCount: 1,
  masteryStatus: "未掌握",
  t0: "2026-09-17T08:00:00Z",
  t1: "2026-09-19T08:00:00Z",
  t2: null,
};

/** 各事件类型按 V1 实际构造整理的合法 metadata 样例。 */
export const VALID_METADATA_SAMPLES: Record<LearningEventType, Record<string, unknown>> = {
  firstPassRecorded: {
    workload: 1,
    wordCount: 5,
    draftId: "draft-20260919-1",
    removedExistingWords: [],
    skippedIncomingWords: [],
  },
  reviewOnlyCompleted: {
    taskId: "task-1",
    taskType: "仅复习",
    workload: 2,
    reviewDemandKeys: ["word-1|仅复习|2026-09-19"],
  },
  testFollowedByReviewCompleted: {
    taskId: "task-1",
    taskType: "短期测试",
    workload: 2,
    reviewDemandKeys: [],
  },
  testAnswered: {
    sessionId: "session-1",
    taskId: "task-1",
    plannedTestAt: "2026-09-19T08:00:00Z",
    initialJudgement: "认识",
    finalJudgement: "认识",
    answerRevised: false,
    beforeState: BOOK_WORD_STATE,
    afterState: { ...BOOK_WORD_STATE, shortTermPassCount: 2 },
    algorithmVersion: "scheduler-v1",
  },
  answerRevised: {
    sessionId: "session-1",
    taskId: "task-1",
    plannedTestAt: "2026-09-19T08:00:00Z",
    initialJudgement: "认识",
    finalJudgement: "不认识",
    answerRevised: true,
    beforeState: BOOK_WORD_STATE,
    afterState: { ...BOOK_WORD_STATE, shortTermPassCount: 0 },
    algorithmVersion: "scheduler-v1",
  },
  shortTermPassCountChanged: {
    sessionId: "session-1",
    taskId: "task-1",
    plannedTestAt: "2026-09-19T08:00:00Z",
    initialJudgement: "认识",
    finalJudgement: "认识",
    answerRevised: false,
    beforeState: BOOK_WORD_STATE,
    afterState: { ...BOOK_WORD_STATE, shortTermPassCount: 2 },
    algorithmVersion: "scheduler-v1",
  },
  listSynchronized: {
    taskId: "task-1",
    taskType: "短期测试",
    workload: 2,
    reviewDemandKeys: [],
  },
  longTermValidationCompleted: {
    sessionId: "session-1",
    taskId: "task-1",
    plannedTestAt: "2026-09-19T08:00:00Z",
    initialJudgement: "认识",
    finalJudgement: "认识",
    answerRevised: false,
    beforeState: BOOK_WORD_STATE,
    afterState: { ...BOOK_WORD_STATE, masteryStatus: "已掌握" },
    algorithmVersion: "scheduler-v1",
  },
  wordMastered: {
    sessionId: "session-1",
    taskId: "task-1",
    plannedTestAt: "2026-09-19T08:00:00Z",
    initialJudgement: "认识",
    finalJudgement: "认识",
    answerRevised: false,
    beforeState: BOOK_WORD_STATE,
    afterState: { ...BOOK_WORD_STATE, masteryStatus: "已掌握" },
    algorithmVersion: "scheduler-v1",
  },
  listMastered: {
    taskId: "task-1",
    taskType: "长期验证",
    workload: 1,
    reviewDemandKeys: [],
  },
  // taskDeferred 在 V1 中只有枚举定义、无构造点，metadata 结构未知，任意对象均合法。
  taskDeferred: { anyFutureField: 1 },
  testSessionPaused: { taskId: "task-1" },
  testSessionResumed: { taskId: "task-1" },
  dictionaryFetched: { definitionCount: 3 },
  dictionaryFetchFailed: { message: "词典服务网络超时" },
  wordAdded: { listId: "list-1", normalizedKey: "apple" },
  wordContentUpdated: { normalizedKey: "apple" },
  wordRemoved: { listId: "list-1", normalizedKey: "apple", reason: "重复录入冲突，用户选择从 List 中删除" },
};

/** 各事件类型在 V1 中的目标类型（targetType）与目标 ID 语义。 */
const TARGET_SAMPLES: Record<LearningEventType, { targetType: string; targetId: string }> = {
  firstPassRecorded: { targetType: "List", targetId: "list-1" },
  reviewOnlyCompleted: { targetType: "List", targetId: "list-1" },
  testFollowedByReviewCompleted: { targetType: "List", targetId: "list-1" },
  testAnswered: { targetType: "Word", targetId: "word-1" },
  answerRevised: { targetType: "Word", targetId: "word-1" },
  shortTermPassCountChanged: { targetType: "Word", targetId: "word-1" },
  listSynchronized: { targetType: "List", targetId: "list-1" },
  longTermValidationCompleted: { targetType: "Word", targetId: "word-1" },
  wordMastered: { targetType: "Word", targetId: "word-1" },
  listMastered: { targetType: "List", targetId: "list-1" },
  taskDeferred: { targetType: "List", targetId: "list-1" },
  testSessionPaused: { targetType: "TestSession", targetId: "session-1" },
  testSessionResumed: { targetType: "TestSession", targetId: "session-1" },
  dictionaryFetched: { targetType: "Word", targetId: "word-1" },
  dictionaryFetchFailed: { targetType: "Word", targetId: "word-1" },
  wordAdded: { targetType: "Word", targetId: "word-2" },
  wordContentUpdated: { targetType: "Word", targetId: "word-1" },
  wordRemoved: { targetType: "Word", targetId: "word-1" },
};

/** 各事件类型在 V1 中的 source 样例（稳定人类可读描述；词典事件记提供方）。 */
const SOURCE_SAMPLES: Partial<Record<LearningEventType, string>> = {
  firstPassRecorded: "首过预览保存",
  testAnswered: "仅复习与逐词测试",
  dictionaryFetched: "维基词典",
  dictionaryFetchFailed: "维基词典",
  wordContentUpdated: "Word 内容维护",
};

/** 构造某事件类型的合法 push 载荷事件（可覆盖任意字段用于构造反例）。 */
export function makeEvent(
  eventType: LearningEventType,
  overrides: Partial<Record<string, unknown>> = {},
): LearningEvent {
  const target = TARGET_SAMPLES[eventType];
  return {
    eventId: SAMPLE_EVENT_ID,
    eventType,
    targetType: target.targetType,
    targetId: target.targetId,
    occurredAt: SAMPLE_OCCURRED_AT,
    learningDay: SAMPLE_LEARNING_DAY,
    source: SOURCE_SAMPLES[eventType] ?? "测试来源",
    deviceId: SAMPLE_DEVICE_ID,
    deviceSeq: 1,
    metadata: VALID_METADATA_SAMPLES[eventType],
    ...overrides,
  } as LearningEvent;
}

/** 构造某事件类型的合法"服务器已存储事件"（在 push 载荷上补 serverSeq）。 */
export function makeStoredEvent(
  eventType: LearningEventType,
  overrides: Partial<Record<string, unknown>> = {},
): StoredLearningEvent {
  return { ...makeEvent(eventType), serverSeq: 42, ...overrides } as StoredLearningEvent;
}
