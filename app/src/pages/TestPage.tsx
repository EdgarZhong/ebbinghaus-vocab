/**
 * 测试页（功能完整）：任务列表 + 常规模式逐词测试会话。
 *
 * 交互语义对应界面设计规格第 10 章与需求规格 6.5/6.8：
 * - 任务列表与今日看板共用同一模式分发数据源（DashboardService.taskItemsPage）；
 *   常规模式按当日临时测试组展示（每组条目数从 Space 设置集中读取），词书模式
 *   按 Unit/List 展示。测试与复习始终分开，本页只承担软件逐词测试。
 * - 逐词会话（常规模式）：开始/暂停/恢复、作答前"认识/不认识"两档、揭示答案、
 *   改判单向（初判认识可"标记为忘记"，绝不提供从不认识改回认识的路径）、完成后
 *   按剩余任务给下一步文案。
 * - 键盘（规格 14.4）：Enter 表达"认识/下一个/确认不认识"，Backspace 只表达
 *   "不认识/标记为忘记"；仅在会话视图且不处于文本输入状态时生效。
 * - 词书逐词测试会话用例尚未在应用层交付（bookReview.ts 如实记录），任务行点击
 *   显示如实占位说明，不伪造会话能力。
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { TestJudgement, type TestJudgement as TestJudgementType } from "@ebbinghaus/domain";
import type { TaskItemSnapshot, TestSessionSnapshot } from "@ebbinghaus/application";
import { navigate, routes } from "../router.tsx";
import { useActiveSpace, useServices } from "../services/servicesContext.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { PageShell } from "../ui/PageShell.tsx";
import { formatDueLabel } from "../ui/display.ts";

/** 会话视图的本地交互状态：会话快照 + 当前条目的答案揭示状态。 */
interface SessionViewState {
  readonly snapshot: TestSessionSnapshot;
  /** null=作答前；否则为初判结果（答案已揭示，等待最终确认）。 */
  readonly revealed: TestJudgementType | null;
}

export function TestPage(): ReactNode {
  const services = useServices();
  const activeSpace = useActiveSpace();
  const version = useSyncExternalStore(services.subscribeChanged, services.getVersion, services.getVersion);

  // 切换 Space 时退出会话视图：会话属于 Space 上下文，跨 Space 继续是错误语义。
  useEffect(() => {
    setSession(null);
    setRevealed(null);
    setTaskError(null);
  }, [activeSpace?.id]);

  // 离开会话视图时无需清理：暂停是显式动作，直接关闭页面保留进行中的会话
  //（会话是设备本地执行状态，下次进入经任务行"继续测试"恢复）。

  const [session, setSession] = useState<TestSessionSnapshot | null>(null);
  const [revealed, setRevealed] = useState<TestJudgementType | null>(null);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [bookHint, setBookHint] = useState<string | null>(null);

  const tasksPage = useMemo(() => {
    if (activeSpace === null) {
      return null;
    }
    try {
      return services.dashboard.taskItemsPage();
    } catch {
      return null;
    }
    // eslint 语义：version 变化意味着需要重读任务列表。
  }, [services, version, activeSpace]);

  const startTask = (task: TaskItemSnapshot): void => {
    setTaskError(null);
    setBookHint(null);
    try {
      const snapshot = services.regularLearning.startOrResumeRegularTest({ taskId: task.taskId });
      setSession(snapshot);
      setRevealed(null);
    } catch (cause) {
      // 常规模式任务开始失败（如该组已无到期条目）就地展示原因。
      setTaskError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (activeSpace === null || tasksPage === null) {
    return (
      <PageShell title="测试" description="在软件里逐词检查记忆，完成后再翻开纸质词书复习。">
        <EmptyState
          title="还没有选择 Space"
          description="从侧边栏顶部选择一个 Space，再回到这里开始测试。"
        />
      </PageShell>
    );
  }

  const isRegularMode = tasksPage.learningMode === "常规模式";
  const tasks = tasksPage.tasks;
  const remainingOf = (task: TaskItemSnapshot): number => Math.max(0, task.totalCount - task.completedCount);
  const isResumable = (task: TaskItemSnapshot): boolean =>
    task.completedCount > 0 || task.sessionStatus !== null;
  const hasOtherPending = tasks.some((task) => remainingOf(task) > 0);

  // ---- 会话完成视图 ----
  if (session !== null && session.currentWord === null) {
    return (
      <PageShell title="测试" description={isRegularMode ? "完成一组再进入下一组，或到复习页朗读。" : undefined}>
        <section className="card test-completed" data-testid="test-completed">
          <p className="empty-state-title">今天的测试完成了</p>
          <p className="empty-state-description">
            {hasOtherPending
              ? "这一组测试完成了。可以继续下一组，或到复习页朗读刚刚测试过的条目。"
              : "可以到复习页朗读刚刚测试过的条目。"}
          </p>
          <div className="modal-actions">
            {hasOtherPending ? (
              <button
                type="button"
                className="btn btn-primary"
                data-testid="test-continue-next-group"
                onClick={() => {
                  setSession(null);
                  setRevealed(null);
                }}
              >
                继续下一组
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-primary"
              data-testid="test-go-review"
              onClick={() => navigate(routes.review)}
            >
              去复习
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              data-testid="test-back-to-list"
              onClick={() => {
                setSession(null);
                setRevealed(null);
              }}
            >
              返回测试
            </button>
          </div>
        </section>
      </PageShell>
    );
  }

  // ---- 逐词测试会话视图（常规模式） ----
  if (session !== null && session.currentWord !== null) {
    return (
      <RegularSessionView
        view={{ snapshot: session, revealed }}
        onChange={(next) => {
          setSession(next.snapshot);
          setRevealed(next.revealed);
        }}
        onExit={() => {
          setSession(null);
          setRevealed(null);
        }}
      />
    );
  }

  // ---- 任务列表视图 ----
  return (
    <PageShell
      title="测试"
      description="在软件里逐词检查记忆，完成后再翻开纸质词书复习。"
    >
      {tasks.length === 0 ? (
        <EmptyState title="今天没有需要测试的 List" description="新的测试到期后，会显示在这里。" />
      ) : (
        <div className="row-list" data-testid="test-task-list">
          {tasks.map((task) => {
            const title = isRegularMode
              ? `第 ${task.listNumber} 组 · ${task.totalCount} 个条目`
              : `Unit ${task.unitNumber} · List ${task.listNumber}`;
            const testId = isRegularMode ? `test-group-${task.listNumber}` : `test-task-${task.listId}`;
            return (
              <div className={`task-row${task.overdueDays > 0 ? " overdue" : ""}`} key={task.taskId} data-testid={testId}>
                <div className="task-row-main">
                  <span className="task-row-title">{title}</span>
                  <span className="task-row-meta">
                    {task.overdueDays > 0 ? <span className="badge badge-overdue">{formatDueLabel(task.overdueDays)}</span> : <span className="badge">今天到期</span>}
                    <span>
                      {isRegularMode
                        ? remainingOf(task) > 0
                          ? `${remainingOf(task)} 个条目待测`
                          : "继续未完成的会话"
                        : sessionMatchesTask(task)
                          ? `本 List 尚余 ${remainingOf(task)} 个词`
                          : `本 List 有 ${task.totalCount} 个词`}
                    </span>
                  </span>
                </div>
                {isRegularMode ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => startTask(task)}
                    data-testid={`test-start-${task.listNumber}`}
                  >
                    {isResumable(task) ? "继续测试" : "开始测试"}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() =>
                      setBookHint(
                        "逐词测试将在后续更新中提供。当前版本请先在复习页完成纸质复习任务。",
                      )
                    }
                    data-testid={`test-start-${task.listId}`}
                  >
                    开始测试
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {taskError === null ? null : (
        <p className="field-error" role="alert" data-testid="test-task-error">
          {taskError}
        </p>
      )}
      {bookHint === null ? null : (
        <p className="field-hint" role="status" data-testid="test-book-hint">
          {bookHint}
        </p>
      )}
    </PageShell>
  );

  /** 词书任务是否已有绑定该任务的开放会话（决定"尚余"口径）。 */
  function sessionMatchesTask(task: TaskItemSnapshot): boolean {
    return task.sessionStatus !== null || task.completedCount > 0;
  }
}

// ---------------------------------------------------------------------------
// 常规模式逐词测试会话视图
// ---------------------------------------------------------------------------

function RegularSessionView({
  view,
  onChange,
  onExit,
}: {
  view: SessionViewState;
  onChange(next: SessionViewState): void;
  onExit(): void;
}): ReactNode {
  const services = useServices();
  const { snapshot, revealed } = view;
  const currentWord = snapshot.currentWord;
  const remaining = Math.max(0, snapshot.totalCount - snapshot.currentPosition);
  /** 会话操作失败的就地错误（如重复确认同一词条），不中断会话视图。 */
  const [sessionError, setSessionError] = useState<string | null>(null);

  // 会话被外部清空（理论不可达）时的防御：立即回到列表由上层处理。
  useEffect(() => {
    if (currentWord === null) {
      onExit();
    }
  }, [currentWord, onExit]);

  const confirmAnswer = useCallback(
    (initial: TestJudgementType, final: TestJudgementType) => {
      try {
        const next = services.regularLearning.confirmRegularTestAnswer({
          sessionId: snapshot.sessionId,
          initialJudgement: initial,
          finalJudgement: final,
        });
        services.notifyChanged();
        // 最终判断完成：进入下一词；会话完成时 currentWord 为 null，上层渲染完成视图。
        onChange({ snapshot: next, revealed: null });
        setSessionError(null);
      } catch (cause) {
        // 会话状态异常（如重复确认）：就地展示原因，不静默吞错。
        setSessionError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [services, snapshot, onChange],
  );

  const pause = useCallback(() => {
    try {
      services.regularLearning.pauseRegularTest({ sessionId: snapshot.sessionId });
      services.notifyChanged();
    } catch (cause) {
      setSessionError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    onExit();
  }, [services, snapshot.sessionId, onExit]);

  // 初判：作答前选择"认识/不认识"，只揭示答案，不写任何学习事件。
  const initial = useCallback(
    (judgement: TestJudgementType) => {
      onChange({ snapshot, revealed: judgement });
    },
    [snapshot, onChange],
  );

  // 键盘（规格 10.2/10.3/14.4）：Enter=认识/下一个/确认不认识；Backspace=不认识/标记为忘记。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target !== null && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) {
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        if (revealed === null) {
          initial(TestJudgement.Recognized);
        } else if (revealed === TestJudgement.Recognized) {
          confirmAnswer(TestJudgement.Recognized, TestJudgement.Recognized);
        } else {
          confirmAnswer(TestJudgement.NotRecognized, TestJudgement.NotRecognized);
        }
      } else if (event.key === "Backspace") {
        event.preventDefault();
        if (revealed === null) {
          initial(TestJudgement.NotRecognized);
        } else if (revealed === TestJudgement.Recognized) {
          // 唯一允许的改判方向：初判认识 → 最终不认识（单向，规格 10.3）。
          confirmAnswer(TestJudgement.Recognized, TestJudgement.NotRecognized);
        }
        // 初判不认识后 Backspace 无新语义：保持揭示状态等待确认。
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [revealed, initial, confirmAnswer]);

  if (currentWord === null) {
    return null;
  }

  return (
    <PageShell title="逐词测试" description={`第 ${snapshot.listNumber ?? 1} 组`}>
      <div className="test-session" data-testid="test-session">
        <p className="test-session-remaining" data-testid="test-session-remaining">
          本组尚余 {remaining} 个条目
        </p>
        <p className="test-session-word" data-testid="session-word">
          {currentWord.originalSpelling}
        </p>
        {revealed === null ? (
          <div className="test-session-body">
            <div className="test-session-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => initial(TestJudgement.NotRecognized)}
                data-testid="session-not-recognized"
              >
                不认识（Backspace）
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => initial(TestJudgement.Recognized)}
                data-testid="session-recognized"
              >
                认识（Enter）
              </button>
            </div>
            <button type="button" className="btn btn-secondary" onClick={pause} data-testid="session-pause">
              暂停并返回
            </button>
          </div>
        ) : (
          <div className="test-session-body">
            <div className="test-session-answer">
              <h3 className="card-section-title">你的释义</h3>
              <p className="test-session-meaning" data-testid="session-meaning">
                {currentWord.manualMeaning}
              </p>
            </div>
            <div className="test-session-actions">
              {revealed === TestJudgement.Recognized ? (
                <>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => confirmAnswer(TestJudgement.Recognized, TestJudgement.NotRecognized)}
                    data-testid="session-mark-forgot"
                  >
                    标记为忘记（Backspace）
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => confirmAnswer(TestJudgement.Recognized, TestJudgement.Recognized)}
                    data-testid="session-next"
                  >
                    下一个（Enter）
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => confirmAnswer(TestJudgement.NotRecognized, TestJudgement.NotRecognized)}
                  data-testid="session-confirm-not-recognized"
                >
                  确认不认识，下一个（Enter）
                </button>
              )}
            </div>
            <button type="button" className="btn btn-secondary" onClick={pause} data-testid="session-pause">
              暂停并返回
            </button>
          </div>
        )}
        {sessionError === null ? null : (
          <p className="field-error" role="alert" data-testid="session-error">
            {sessionError}
          </p>
        )}
      </div>
    </PageShell>
  );
}
