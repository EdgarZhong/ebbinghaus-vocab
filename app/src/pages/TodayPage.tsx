/**
 * 今日页（功能完整）。
 *
 * 交互语义对应界面设计规格第 8 章（词书 8.2-8.4 / 常规 8.5）与需求规格 6.1/6.7：
 * - 页面只回答一件事："我现在先做什么"。下一步卡片按"测试 → 复习 → 首过"优先级
 *   给出唯一视觉最强操作；三类任务都为空时显示完成状态，不制造虚假任务。
 * - 任务清单与测试页共用同一模式分发数据源（DashboardService），测试/复习分开
 *   展示；到期任务 ≤2 次点击进入（下一步"开始测试" → 测试页"开始测试"）。
 * - 容量两段式（AGENTS.md 固定交互）：读侧只取缓存视图，绝不阻塞等待蒙特卡洛；
 *   stale 时后台刷新完成后刷新界面，期间显示最近缓存结果与轻提示。
 * - 每日目标属于当前活动 Space，从今日看板调整（规格 6.7），按模式切换计量文案。
 * - 全程行为语言：不出现容量、风险分位数、算法版本、T0/T1/T2 等内部术语（第 15 章）。
 */

import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import type { TaskItemSnapshot } from "@ebbinghaus/application";
import { navigate, routes } from "../router.tsx";
import { useActiveSpace, useServices } from "../services/servicesContext.tsx";
import { useToast } from "../shell/ToastContext.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { PageShell } from "../ui/PageShell.tsx";
import { StepperInput } from "../ui/StepperInput.tsx";
import { formatTodayTitle } from "../ui/display.ts";

export function TodayPage(): ReactNode {
  const services = useServices();
  const activeSpace = useActiveSpace();
  const { showToast } = useToast();
  // 版本号订阅：本页或其它页面（录入、测试、Space 切换）改变数据后整体重读。
  const version = useSyncExternalStore(services.subscribeChanged, services.getVersion, services.getVersion);

  const isRegularMode = activeSpace?.learningMode === "常规模式";

  // ---- 数据读取（内存运行时同步快照） ----
  const snapshot = useMemo(() => {
    if (activeSpace === null) {
      return null;
    }
    try {
      return services.dashboard.dashboardSnapshot();
    } catch {
      return null;
    }
    // eslint 语义：version 变化意味着需要重读快照。
  }, [services, version, activeSpace]);

  // ---- 容量两段式：复用本次渲染的缓存快照，空闲时再刷新 ----
  useEffect(() => {
    if (activeSpace === null || snapshot === null || !snapshot.capacityStale) return;
    let cancelled = false;
    const refresh = (): void => {
      if (cancelled) return;
      try {
        services.dashboard.refreshCapacity();
        services.notifyChanged();
      } catch {
        // 容量预测失败只保留最近缓存，不妨碍今日页学习入口。
      }
    };
    // 切页先完成骨架和缓存视图的绘制，蒙特卡洛在浏览器空闲时执行。
    // WebKit 旧版本没有 requestIdleCallback，延迟计时器保持相同语义。
    const idle = window.requestIdleCallback?.(refresh, { timeout: 2000 });
    const timer = idle === undefined ? window.setTimeout(refresh, 250) : null;
    return () => {
      cancelled = true;
      if (idle !== undefined) window.cancelIdleCallback?.(idle);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [services, snapshot, activeSpace]);

  const regularReviewGroups = useMemo(() => {
    if (activeSpace === null || activeSpace.learningMode !== "常规模式") {
      return [];
    }
    return services.learningViews.listRegularReviewGroups(activeSpace.id);
  }, [services, version, activeSpace]);

  // ---- 每日目标草稿（从看板调整，规格 6.7） ----
  const [targetDraft, setTargetDraft] = useState<string | null>(null);
  const targetValue = targetDraft ?? String(snapshot?.targetCapacity ?? 0);
  const [targetError, setTargetError] = useState<string | null>(null);

  const saveDailyTarget = (): void => {
    const parsed = Number.parseInt(targetValue, 10);
    if (Number.isNaN(parsed) || parsed < 0 || String(parsed) !== targetValue.trim()) {
      setTargetError("每日学习目标必须是不小于 0 的整数。");
      return;
    }
    try {
      services.dashboard.saveActiveSpaceDailyTarget(parsed);
      services.notifyChanged();
      setTargetDraft(null);
      setTargetError(null);
      showToast("每日目标已更新。");
    } catch (cause) {
      setTargetError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (activeSpace === null || snapshot === null) {
    return (
      <PageShell title="今日" description="选择一个 Space 后查看今天最优先的学习动作。">
        <EmptyState
          title="还没有选择 Space"
          description="从侧边栏顶部选择一个 Space，再回到这里安排今天的学习。"
          action={
            <button type="button" className="btn btn-primary" onClick={() => navigate(routes.spaces)}>
              打开 Space 管理
            </button>
          }
        />
      </PageShell>
    );
  }

  // ---- 任务分类（复习不是任务：入口行固定为浏览文案，规格 8.2） ----
  const testTasks = snapshot.tasks;
  const remainingOf = (task: TaskItemSnapshot): number => Math.max(0, task.totalCount - task.completedCount);
  const isResumable = (task: TaskItemSnapshot): boolean =>
    task.completedCount > 0 || task.sessionStatus !== null;

  const countLabel = isRegularMode ? "个条目" : "个 List";
  const suggestedCount = snapshot.suggestedFirstPassCount;
  const capacityLoading = snapshot.capacityStale && snapshot.capacityAlgorithmVersion === "";
  const capacityRefreshing = snapshot.capacityStale && snapshot.capacityAlgorithmVersion !== "";
  const workloadUnit = isRegularMode ? "个条目" : "份学习";

  // ---- 下一步选择（规格 8.3：测试 → 首过 → 完成；复习是浏览入口，不再是任务） ----
  const nextTest = testTasks[0];
  const noSample = snapshot.recentActualSampleCount === 0;

  const todayTitle = formatTodayTitle(services.settings.getLearningScheduleSettings().timezoneName, services.clock.now());

  return (
    <PageShell
      title={todayTitle}
      description={
        isRegularMode
          ? "以条目测试为主，朗读复习是可选的辅助入口。"
          : "先完成测试，再浏览今天关注的词，最后根据建议决定是否首过新 List。"
      }
    >
      {nextTest === undefined && suggestedCount <= 0 ? (
        // 测试与建议都为空：完成状态，不制造虚假任务（规格 8.3 规则 5/6；
        // 复习是浏览入口，不进入下一步优先级）。
        <EmptyState
          title={isRegularMode ? "今天的测试完成了" : "今天的任务完成了"}
          description={
            isRegularMode
              ? "可以朗读今天的条目，或自行录入新内容。"
              : "可以休息，或自行学习新的 List。测试到期后会显示在这里。"
          }
          action={
            <button type="button" className="btn btn-primary" onClick={() => navigate(routes.firstPass)}>
              {isRegularMode ? "录入新条目" : "录入新 List"}
            </button>
          }
        />
      ) : (
        <section className="card next-step-card" aria-label="下一步" data-testid="today-next-step">
          {nextTest !== undefined ? (
            <>
              <div className="next-step-main">
                <h2 className="next-step-title" data-testid="today-next-title">
                  {isRegularMode
                    ? `测试第 ${nextTest.listNumber} 组 · ${nextTest.totalCount} 个条目`
                    : `测试 Unit ${nextTest.unitNumber} · List ${nextTest.listNumber}`}
                </h2>
                <p className="next-step-description" data-testid="today-next-description">
                  {isRegularMode
                    ? `还有 ${remainingOf(nextTest)} 个条目待测试。${nextTest.overdueDays > 0 ? `其中 ${nextTest.overdueDays} 天前到期。` : ""}`
                    : `还有 ${remainingOf(nextTest)} 个词。`}
                </p>
              </div>
              <button
                type="button"
                className="btn btn-primary"
                data-testid="today-start-test"
                onClick={() => navigate(routes.test)}
              >
                {isResumable(nextTest) ? "继续测试" : "开始测试"}
              </button>
            </>
          ) : (
            <>
              <div className="next-step-main">
                <h2 className="next-step-title" data-testid="today-next-title">
                  {isRegularMode ? "今天可以录入新条目" : "今天可以学习新 List"}
                </h2>
                <p className="next-step-description" data-testid="today-next-description">
                  {noSample
                    ? `建议新增 ${suggestedCount} ${countLabel}。暂无近期完成记录，先按你的每日目标估算。`
                    : `建议新增 ${suggestedCount} ${countLabel}。`}
                </p>
              </div>
              <button
                type="button"
                className="btn btn-primary"
                data-testid="today-start-first-pass"
                onClick={() => navigate(routes.firstPass)}
              >
                {isRegularMode ? "录入条目" : "开始录入"}
              </button>
            </>
          )}
        </section>
      )}

      <section className="card section" aria-label="今天的学习顺序">
        <h2 className="card-section-title">{isRegularMode ? "今天的学习" : "今天的学习顺序"}</h2>
        {/* order-list：序号由 CSS 计数器以装饰伪元素生成（pages.css），DOM 与文案不变。 */}
        <div className="row-list order-list">
          <div className="order-row" data-testid="today-order-test">
            <span className="order-row-name">测试</span>
            <span className="order-row-meta">
              {testTasks.length === 0
                ? "暂无待测任务"
                : isRegularMode
                  ? `${testTasks.length} 组 · 共 ${testTasks.reduce((sum, task) => sum + remainingOf(task), 0)} 个条目待测试`
                  : `${testTasks.length} 个 List 待测试`}
            </span>
            <button type="button" className="btn btn-secondary" onClick={() => navigate(routes.test)}>
              查看测试
            </button>
          </div>
          <div className="order-row" data-testid="today-order-review">
            <span className="order-row-name">复习</span>
            <span className="order-row-meta">
              {isRegularMode
                ? regularReviewGroups.length === 0
                  ? "暂无可朗读条目"
                  : `今天已有 ${regularReviewGroups.reduce((sum, group) => sum + group.testedCount, 0)} 个条目可朗读，不计入工作量`
                : /* 词书模式：复习入口不再是任务，固定浏览文案（规格 8.2）。 */
                  "浏览今天关注的词"}
            </span>
            <button type="button" className="btn btn-secondary" onClick={() => navigate(routes.review)}>
              查看复习
            </button>
          </div>
          <div className="order-row" data-testid="today-order-first-pass">
            <span className="order-row-name">{isRegularMode ? "录入" : "首过"}</span>
            <span className="order-row-meta" data-testid="today-suggested-count">
              {capacityLoading
                ? "正在准备今日建议……"
                : suggestedCount > 0
                  ? `今天建议新增 ${suggestedCount} ${countLabel}`
                  : "今天不建议新增"}
            </span>
            <button type="button" className="btn btn-secondary" onClick={() => navigate(routes.firstPass)}>
              {isRegularMode ? "录入条目" : "开始录入"}
            </button>
          </div>
        </div>
      </section>

      <section className="card section" aria-label="每日目标" data-testid="today-target-section">
        <h2 className="card-section-title">每日目标</h2>
        <div className="settings-row">
          <StepperInput
            id="today-daily-target"
            label={isRegularMode ? "每天希望完成（个条目）" : "每天希望完成（份学习）"}
            value={targetValue}
            onValueChange={(value) => {
              setTargetDraft(value);
              setTargetError(null);
            }}
            min={0}
            error={targetError}
            hint={
              isRegularMode
                ? /* 常规模式计量口径：录入 1、测试 1、朗读 0（需求规格 6.8）。 */
                  "录入和测试各算 1 个条目；复习只供朗读，不计入工作量。"
                : /* 词书模式计量口径（2026-10-02）：首过 1、每个已确认词测试判断 1、纸质复习 0。 */
                  "首过算 1 份；每个词的测试判断算 1 份；纸质复习计 0 份。"
            }
            testId="today-daily-target"
          />
          <button type="button" className="btn btn-primary" onClick={saveDailyTarget} data-testid="today-save-target">
            保存目标
          </button>
        </div>
        <p className="field-hint" data-testid="today-capacity-note">
          {capacityLoading
            ? "正在根据你的学习记录准备今日建议，完成后自动更新。"
            : capacityRefreshing
              ? "学习情况有更新，建议正在后台刷新，先显示最近一次结果。"
              : `按你的每日目标，今天适合新增 ${suggestedCount} ${countLabel}。未来一周的压力已一并考虑。`}
        </p>
        {snapshot.overdueWorkload > 0 ? (
          <p className="field-hint" data-testid="today-overdue-note">
            有相当于 {snapshot.overdueWorkload} {workloadUnit}的逾期任务，完成后建议才会恢复准确。
          </p>
        ) : null}
      </section>
    </PageShell>
  );
}
