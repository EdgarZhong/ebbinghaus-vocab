/**
 * 核心领域实体与状态不变量测试（映射 V1 tests/unit/domain/test_entities.py）。
 *
 * 说明：V1 的 LearningEvent 实体校验（不可变、metadata 必须是 JSON 对象）与
 * TestSession/TestAnswer 的持久化行形态已由 packages/protocol 的事件 schema 与
 * 后续应用层承接；本文件只映射其中仍属于领域层的构造不变量与规则函数，
 * 不得为测试复制第二套事件实体（架构铁律）。
 */
import { describe, expect, it } from "vitest";

import {
  createSpace,
  createStudyUnit,
  createWord,
  createWordList,
  spaceDisplayName,
  validateJudgementRevision,
  validateTestSessionProgress,
} from "../src/entities.ts";
import { LearningMode, MasteryStatus, SpaceKind, TestJudgement } from "../src/enums.ts";

describe("Space 实体", () => {
  it("三个默认词频板块保持稳定，并允许具名的自定义 Space", () => {
    const defaultSpace = createSpace({
      id: "space-required",
      kind: SpaceKind.Required,
      displayOrder: 1,
    });
    const customSpace = createSpace({
      id: "space-custom",
      kind: null,
      displayOrder: 4,
      name: "  核心词汇  ",
    });
    expect(spaceDisplayName(defaultSpace)).toBe("必考词");
    // 名称在领域入口统一去除首尾空白，避免界面、唯一索引和比较口径不一致。
    expect(spaceDisplayName(customSpace)).toBe("核心词汇");
  });

  it("非法的板块取值被拒绝", () => {
    expect(() =>
      createSpace({
        id: "space-bad",
        // 模拟绕过类型系统的运行时脏输入（V1 以 isinstance 校验同类问题）。
        kind: "冷门词" as typeof SpaceKind.Required,
        displayOrder: 1,
      }),
    ).toThrow(/Space 类型/);
  });

  it("自定义 Space 必须提供名称", () => {
    expect(() =>
      createSpace({ id: "space-empty", kind: null, displayOrder: 4 }),
    ).toThrow(/必须提供名称/);
  });

  it("空白名称视为未提供名称", () => {
    expect(() =>
      createSpace({ id: "space-blank", kind: null, displayOrder: 4, name: "   " }),
    ).toThrow(/Space 名称不能为空/);
  });

  it("学习模式默认词书模式且取值封闭", () => {
    const space = createSpace({ id: "space-mode", kind: null, displayOrder: 1, name: "n" });
    expect(space.learningMode).toBe(LearningMode.Book);
    expect(() =>
      createSpace({
        id: "space-mode-bad",
        kind: null,
        displayOrder: 1,
        name: "n",
        learningMode: "随便模式" as typeof LearningMode.Book,
      }),
    ).toThrow(/学习模式/);
  });
});

describe("编号实体：Unit 与 List", () => {
  it("Unit 与 List 编号必须大于 0", () => {
    expect(() => createStudyUnit({ id: "unit", spaceId: "space", number: 0 })).toThrow(
      /Unit 编号必须大于 0/,
    );
    expect(() =>
      createWordList({ id: "list", unitId: "unit", number: -1 }),
    ).toThrow(/List 编号必须大于 0/);
  });

  it("进入长期验证必须永久锁定新增", () => {
    expect(() =>
      createWordList({ id: "list", unitId: "unit", number: 1, stage: "长期验证" }),
    ).toThrow(/永久锁定新增/);
  });

  it("已掌握 List 的聚合状态必须为已掌握", () => {
    expect(() =>
      createWordList({
        id: "list",
        unitId: "unit",
        number: 1,
        stage: "已掌握",
        additionsLocked: true,
        aggregateStatus: MasteryStatus.Unmastered,
      }),
    ).toThrow(/聚合状态/);
  });
});

describe("Word 实体：T0/T1/T2 状态起点不变量", () => {
  it("未掌握新 Word 保存带时区的绝对 T0", () => {
    const t0 = "2026-07-15T09:00:00Z";
    const word = createWord({
      id: "word",
      listId: "list",
      originalSpelling: "abandon",
      normalizedKey: "abandon",
      manualMeaning: "放弃",
      shortTermPassCount: 0,
      masteryStatus: MasteryStatus.Unmastered,
      shortTermCycleStartedAt: t0,
    });
    expect(word.shortTermCycleStartedAt).toBe(t0);
    expect(word.shortTermPassCount).toBe(0);
  });

  it("无时区的本地时间必须拒绝，保证历史可跨时区回放", () => {
    expect(() =>
      createWord({
        id: "word-naive",
        listId: "list",
        originalSpelling: "abandon",
        normalizedKey: "abandon",
        manualMeaning: "放弃",
        shortTermPassCount: 0,
        masteryStatus: MasteryStatus.Unmastered,
        shortTermCycleStartedAt: "2026-07-15T09:00:00",
      }),
    ).toThrow(/带时区/);
  });

  it("短期通过次数为 1 时必须能追溯到对应的 T1", () => {
    expect(() =>
      createWord({
        id: "word-one",
        listId: "list",
        originalSpelling: "abandon",
        normalizedKey: "abandon",
        manualMeaning: "放弃",
        shortTermPassCount: 1,
        masteryStatus: MasteryStatus.Unmastered,
        shortTermCycleStartedAt: "2026-07-15T09:00:00Z",
      }),
    ).toThrow(/短期通过次数为 1 时必须保存 T1/);
  });

  it("短期通过次数为 2 时必须保存 T2", () => {
    expect(() =>
      createWord({
        id: "word-two",
        listId: "list",
        originalSpelling: "abandon",
        normalizedKey: "abandon",
        manualMeaning: "放弃",
        shortTermPassCount: 2,
        masteryStatus: MasteryStatus.Unmastered,
      }),
    ).toThrow(/短期通过次数为 2 时必须保存 T2/);
  });

  it("义项快照必须与结构化义项一致", () => {
    expect(() =>
      createWord({
        id: "word-mismatch",
        listId: "list",
        originalSpelling: "abandon",
        normalizedKey: "abandon",
        manualMeaning: "与结构不一致",
        shortTermPassCount: 0,
        masteryStatus: MasteryStatus.Unmastered,
        shortTermCycleStartedAt: "2026-07-15T09:00:00Z",
        meanings: [{ partOfSpeech: null, definition: "放弃", usage: null }],
      }),
    ).toThrow(/快照必须与结构化义项一致/);
  });
});

describe("测试判断改判规则（原 TestAnswer 实体承载）", () => {
  it("初判不认识不得改回认识", () => {
    expect(() =>
      validateJudgementRevision({
        initialJudgement: TestJudgement.NotRecognized,
        finalJudgement: TestJudgement.Recognized,
        answerRevised: true,
      }),
    ).toThrow(/不得改回认识/);
  });

  it("改判标记必须与初判和最终判断一致", () => {
    expect(() =>
      validateJudgementRevision({
        initialJudgement: TestJudgement.Recognized,
        finalJudgement: TestJudgement.Recognized,
        answerRevised: true,
      }),
    ).toThrow(/改判标记/);
    expect(() =>
      validateJudgementRevision({
        initialJudgement: TestJudgement.Recognized,
        finalJudgement: TestJudgement.NotRecognized,
        answerRevised: false,
      }),
    ).toThrow(/改判标记/);
    expect(() =>
      validateJudgementRevision({
        initialJudgement: TestJudgement.Recognized,
        finalJudgement: TestJudgement.NotRecognized,
        answerRevised: true,
      }),
    ).not.toThrow();
  });
});

describe("测试会话进度不变量（原 TestSession 实体承载）", () => {
  it("未完成全部 Word 时不得进入待纸质复习或完成状态", () => {
    // 快照含 2 个词但只确认 1 个：任何调用方都不能跳过剩余测试。
    expect(() =>
      validateTestSessionProgress({ currentPosition: 1, totalWords: 2, status: "待纸质复习" }),
    ).toThrow(/未完成全部 Word/);
    expect(() =>
      validateTestSessionProgress({ currentPosition: 2, totalWords: 2, status: "已完成" }),
    ).not.toThrow();
  });
});
