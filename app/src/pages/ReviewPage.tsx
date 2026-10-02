/**
 * 复习页（功能完整）：词书模式纸质复习确认 + 常规模式只读朗读分组。
 *
 * 交互语义对应界面设计规格第 9 章与需求规格 6.4/6.8：
 * - 词书模式：仅复习到期任务与软件测试完成的"等待纸质复习"任务都在此按
 *   List 展示；主要按钮始终为"完成纸质复习"，完成反馈与按钮同名。
 * - 常规模式：说明改为"查看今天已经测试过的条目，方便朗读和背诵"；只展示当天
 *   已有最终测试结果的条目，最终"不认识"置顶并标注"刚刚忘记"；无完成/确认/
 *   推迟操作，关闭页面不产生任何学习事件。
 * - 逾期行使用左侧强调线 + 文字标注表达，不使用整张红色背景（规格 9.2）。
 */

import { useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import type { BookReviewTaskView, RegularReviewGroupView } from "../services/learningViews.ts";
import { useActiveSpace, useServices } from "../services/servicesContext.tsx";
import { formatManualMeaning } from "../ui/meaningDisplay.ts";
import { useToast } from "../shell/ToastContext.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { PageShell } from "../ui/PageShell.tsx";

export function ReviewPage(): ReactNode {
  const services = useServices();
  const activeSpace = useActiveSpace();
  const version = useSyncExternalStore(services.subscribeChanged, services.getVersion, services.getVersion);

  const isRegularMode = activeSpace?.learningMode === "常规模式";

  const bookTasks = useMemo(() => {
    if (activeSpace === null || activeSpace.learningMode !== "词书模式") {
      return [] as BookReviewTaskView[];
    }
    return services.learningViews.listBookReviewTasks(activeSpace.id);
    // eslint 语义：version 变化意味着任务（派生态）可能已更新。
  }, [services, version, activeSpace]);

  const regularGroups = useMemo(() => {
    if (activeSpace === null || activeSpace.learningMode !== "常规模式") {
      return [] as RegularReviewGroupView[];
    }
    return services.learningViews.listRegularReviewGroups(activeSpace.id);
  }, [services, version, activeSpace]);

  if (activeSpace === null) {
    return (
      <PageShell title="复习" description="按 List 翻开纸质词书复习。">
        <EmptyState title="还没有选择 Space" description="从侧边栏顶部选择一个 Space，再回到这里安排复习。" />
      </PageShell>
    );
  }

  return isRegularMode ? (
    <RegularReviewView groups={regularGroups} />
  ) : (
    <BookReviewView tasks={bookTasks} />
  );
}

// ---------------------------------------------------------------------------
// 词书模式：纸质复习确认
// ---------------------------------------------------------------------------

function BookReviewView({ tasks }: { tasks: readonly BookReviewTaskView[] }): ReactNode {
  const services = useServices();
  const { showToast } = useToast();
  /** 展开词清单的任务（规格 9.1：展开只用于翻书提示，不提供逐词勾选）。 */
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** 行内完成失败信息（附着到对应任务卡，不建全局日志区）。 */
  const [taskError, setTaskError] = useState<{ taskId: string; message: string } | null>(null);

  const completeReview = (view: BookReviewTaskView): void => {
    setTaskError(null);
    try {
      services.bookReview.completePaperReview({
        task: view.task,
        answeredPlannedDays: view.answeredPlannedDays,
        learningDaySettings: services.settings.getLearningDaySettings(),
      });
      services.notifyChanged();
      showToast(`${view.title} 已完成复习。`);
    } catch (cause) {
      // 前置状态不满足（如软件测试未完成）时展示用例给定的用户可读原因。
      setTaskError({ taskId: view.taskId, message: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  return (
    <PageShell title="复习" description="按 List 翻开纸质词书复习。">
      {tasks.length === 0 ? (
        <EmptyState title="今天没有需要复习的 List" description="有新的复习任务时，会显示在这里。" />
      ) : (
        <div className="row-list" data-testid="review-task-list">
          {tasks.map((view) => {
            const expanded = expandedId === view.taskId;
            return (
              <div
                className={`task-row${view.dueLabel !== "今天到期" ? " overdue" : ""}`}
                key={view.taskId}
                data-testid={`review-task-${view.title}`}
              >
                <div className="task-row-main">
                  <span className="task-row-title">{view.title}</span>
                  <span className="task-row-meta">
                    {view.dueLabel !== "今天到期" ? (
                      <span className="badge badge-overdue">{view.dueLabel}</span>
                    ) : (
                      <span className="badge">{view.dueLabel}</span>
                    )}
                    {view.words.length > 0 ? (
                      <span>{view.words.length} 个词需要复习</span>
                    ) : (
                      <span>请使用纸质书复习本 List</span>
                    )}
                  </span>
                </div>
                <div className="task-row-actions">
                  {view.words.length > 0 ? (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      aria-expanded={expanded}
                      onClick={() => setExpandedId((current) => (current === view.taskId ? null : view.taskId))}
                      data-testid={`review-expand-${view.title}`}
                    >
                      {expanded ? "收起词清单" : `查看这 ${view.words.length} 个词`}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => completeReview(view)}
                    data-testid={`review-complete-${view.title}`}
                  >
                    完成纸质复习
                  </button>
                </div>
                {taskError !== null && taskError.taskId === view.taskId ? (
                  <p className="field-error" role="alert" data-testid="review-task-error">
                    {taskError.message}
                  </p>
                ) : null}
                {expanded ? (
                  <ul className="word-hint-list" data-testid={`review-words-${view.title}`}>
                    {view.words.map((word) => (
                      <li key={word.wordId}>
                        <span className="word-hint-term">{word.originalSpelling}</span>
                        <span className="word-hint-meaning">{formatManualMeaning(word.manualMeaning, word.meanings, "；")}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// 常规模式：只读朗读分组
// ---------------------------------------------------------------------------

function RegularReviewView({ groups }: { groups: readonly RegularReviewGroupView[] }): ReactNode {
  const [expandedId, setExpandedId] = useState<number | null>(null);

  return (
    <PageShell title="复习" description="查看今天已经测试过的条目，方便朗读和背诵。">
      {groups.length === 0 ? (
        <EmptyState
          title="今天还没有已测试的条目"
          description="在测试页完成逐词测试后，可以在这里朗读刚刚测试过的内容。"
        />
      ) : (
        <div className="row-list" data-testid="review-group-list">
          {groups.map((group) => {
            const expanded = expandedId === group.ordinal;
            return (
              <div className="task-row" key={group.ordinal} data-testid={`review-group-${group.ordinal}`}>
                <div className="task-row-main">
                  <span className="task-row-title">第 {group.ordinal} 组 · 已测试 {group.testedCount} 个条目</span>
                  <span className="task-row-meta">
                    {group.forgottenCount > 0 ? (
                      <span className="badge badge-overdue">刚刚忘记 {group.forgottenCount} 个</span>
                    ) : null}
                  </span>
                </div>
                <div className="task-row-actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    aria-expanded={expanded}
                    onClick={() => setExpandedId((current) => (current === group.ordinal ? null : group.ordinal))}
                    data-testid={`review-group-expand-${group.ordinal}`}
                  >
                    {expanded ? "收起" : `查看这 ${group.testedCount} 个条目`}
                  </button>
                </div>
                {expanded ? (
                  <div className="review-reading-body">
                    {group.forgotten.length > 0 ? (
                      <>
                        <h4 className="review-reading-title">刚刚忘记</h4>
                        <ul className="word-hint-list">
                          {group.forgotten.map((entry) => (
                            <li key={entry.wordId} className="word-hint-forgotten">
                              <span className="word-hint-marker" aria-hidden="true">!</span>
                              <span className="word-hint-term">{entry.originalSpelling}</span>
                              <span className="word-hint-meaning">{formatManualMeaning(entry.manualMeaning, entry.meanings, "；")}</span>
                              <span className="badge badge-overdue">刚刚忘记</span>
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                    {group.others.length > 0 ? (
                      <>
                        <h4 className="review-reading-title">其余已测试条目</h4>
                        <ul className="word-hint-list">
                          {group.others.map((entry) => (
                            <li key={entry.wordId}>
                              <span className="word-hint-term">{entry.originalSpelling}</span>
                              <span className="word-hint-meaning">{formatManualMeaning(entry.manualMeaning, entry.meanings, "；")}</span>
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </PageShell>
  );
}
