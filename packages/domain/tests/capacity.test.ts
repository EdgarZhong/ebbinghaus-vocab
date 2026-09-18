/**
 * 滚动时域容量预测的确定性、风险输出与软建议规则测试
 * （映射 V1 tests/unit/domain/test_capacity.py，逐函数对应）。
 *
 * 随机源差异说明：V1 使用 Python MT19937，V2 使用 mulberry32（见 capacity.ts 文件头），
 * 因此本文件不与 Python 的具体点值对齐，只固化行为契约：确定性、固定项精确、
 * 风险指标形态与建议规则。
 */
import { describe, expect, it } from "vitest";

import {
  CAPACITY_ALGORITHM_VERSION,
  createCandidateListProfile,
  createCapacityPredictionRequest,
  createFixedWorkload,
  createInMemoryCapacityPlanCache,
  computeCapacityInputFingerprint,
  deterministicForwardPrediction,
  predictCapacity,
  simpleSubtractionSuggestion,
  type CapacityPredictionRequest,
  type FixedWorkload,
} from "../src/capacity.ts";
import { addLearningDays } from "../src/learningDay.ts";

const TODAY = "2026-07-15";

/** 使用小样本构造快速但包含失败分支的可复现测试输入（对应 V1 _request）。 */
function request(overrides?: Partial<CapacityPredictionRequest>): CapacityPredictionRequest {
  const fixedWorkloads: FixedWorkload[] = [
    createFixedWorkload({ taskId: "today-review", learningDay: TODAY, workload: 1 }),
    createFixedWorkload({
      taskId: "tomorrow-test",
      learningDay: addLearningDays(TODAY, 1),
      workload: 2,
    }),
  ];
  return createCapacityPredictionRequest({
    today: TODAY,
    targetCapacity: 8,
    recentActualDailyCapacity: 7.0,
    fixedWorkloads,
    maximumNewLists: 3,
    horizonDays: 14,
    riskQuantile: 0.85,
    reserveWorkload: 1,
    sampleCount: 40,
    randomSeed: 20260715,
    candidateProfile: createCandidateListProfile({
      activeWordCount: 4,
      shortTermSuccessProbability: 0.65,
      waitingCheckSuccessProbability: 0.75,
      longTermSuccessProbability: 0.6,
    }),
    ...overrides,
  });
}

describe("容量预测 capacity-monte-carlo-v2", () => {
  it("同种子同输入产生完全一致的预测，输出完整可解释指标", () => {
    const first = predictCapacity(request());
    const second = predictCapacity(request());

    expect(first).toEqual(second);
    expect(first.algorithmVersion).toBe(CAPACITY_ALGORITHM_VERSION);
    expect(first.candidates).toHaveLength(4);
    expect(first.candidates[0]?.expectedWorkloadByDay).toHaveLength(14);
  });

  it("确定任务不随机化；调用方输入排序不改变固定种子对应的结果", () => {
    const first = predictCapacity(request());
    const reversedWorkloads = [...request().fixedWorkloads].reverse();
    const second = predictCapacity(request({ fixedWorkloads: reversedWorkloads }));

    expect(second).toEqual(first);
    const zeroCandidate = first.candidates[0];
    expect(zeroCandidate?.expectedWorkloadByDay[0]).toBe(1);
    expect(zeroCandidate?.expectedWorkloadByDay[1]).toBe(2);
    expect(zeroCandidate?.riskQuantileWorkloadByDay[0]).toBe(1);
    expect(zeroCandidate?.riskQuantileWorkloadByDay[1]).toBe(2);
  });

  it("随机前瞻必须提供负荷、超载、积压和清空指标，不能退化为今日简单相减", () => {
    const prediction = predictCapacity(request());
    const candidate = prediction.candidates[prediction.candidates.length - 1];

    expect(candidate?.expectedWorkloadByDay[0]).toBe(4); // 今日确定任务 1 + 三个首过。
    expect(candidate?.expectedWorkloadByDay.slice(1).some((value) => value > 0)).toBe(true);
    expect(candidate?.overloadProbability).toBeGreaterThanOrEqual(0);
    expect(candidate?.overloadProbability).toBeLessThanOrEqual(1);
    expect(candidate?.expectedMaxBacklog).toBeGreaterThanOrEqual(0);
    expect(candidate?.riskQuantileMaxBacklog).toBeDefined();
    expect(candidate?.expectedClearanceDays).toBeGreaterThanOrEqual(0);
  });

  it("逾期工作量达到每日目标时建议新增 0；目标仍原样展示", () => {
    const prediction = predictCapacity(request({ overdueWorkload: 8 }));

    expect(prediction.suggestedFirstPassCount).toBe(0);
    expect(prediction.targetCapacity).toBe(8);
    expect(prediction.recentActualDailyCapacity).toBe(7);
    expect(prediction.riskCapacity).toBe(7);
  });

  it("最近实际日均能力只收紧风险评估，不能静默改写每日目标", () => {
    const prediction = predictCapacity(request({ recentActualDailyCapacity: 4.0 }));

    expect(prediction.targetCapacity).toBe(8);
    expect(prediction.riskCapacity).toBe(4);
  });

  it("14/21/28 天窗口都能生成稳定、长度正确的逐日输出", () => {
    for (const horizon of [14, 21, 28]) {
      const horizonRequest = request({ horizonDays: horizon, sampleCount: 20 });
      const first = predictCapacity(horizonRequest);
      const second = predictCapacity(horizonRequest);
      expect(second).toEqual(first);
      expect(first.candidates[0]?.expectedWorkloadByDay).toHaveLength(horizon);
    }
  });

  it("简单相减、理想前瞻和随机前瞻形成可量化对照", () => {
    const strategyRequest = request({ maximumNewLists: 6 });
    const simple = simpleSubtractionSuggestion({
      targetCapacity: strategyRequest.targetCapacity,
      dueWorkload: 1,
      overdueWorkload: strategyRequest.overdueWorkload,
      maximumNewLists: strategyRequest.maximumNewLists,
    });
    const deterministic = deterministicForwardPrediction(strategyRequest);
    const stochastic = predictCapacity(strategyRequest);

    expect(simple).toBe(6); // 今日剩余 7，但候选上限为 6，完全忽略未来测试与复习。
    expect(deterministic.suggestedFirstPassCount).toBeGreaterThanOrEqual(0);
    expect(deterministic.suggestedFirstPassCount).toBeLessThanOrEqual(simple);
    expect(stochastic.suggestedFirstPassCount).toBeGreaterThanOrEqual(0);
    expect(stochastic.suggestedFirstPassCount).toBeLessThanOrEqual(simple);
    expect(deterministic.candidates).not.toEqual(stochastic.candidates);
  });
});

describe("容量预测输入指纹与缓存接口", () => {
  it("指纹不变时缓存命中且返回完全相同的对象", () => {
    const cache = createInMemoryCapacityPlanCache();
    const first = request();
    const fingerprint = computeCapacityInputFingerprint(first);

    expect(cache.get(fingerprint)).toBeUndefined();
    const prediction = predictCapacity(first);
    cache.set(fingerprint, prediction);
    expect(cache.get(fingerprint)).toBe(prediction);

    // 输入不变 → 指纹不变；任何输入变化（如逾期工作量）→ 指纹变化。
    expect(computeCapacityInputFingerprint(request())).toBe(fingerprint);
    expect(computeCapacityInputFingerprint(request({ overdueWorkload: 3 }))).not.toBe(fingerprint);
  });
});
