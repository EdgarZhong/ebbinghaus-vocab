/**
 * 词汇页（功能完整）：全宽单列 Word 卡片 + 词条详情 + 查询过滤。
 *
 * 交互语义对应界面设计规格第 12 章与需求规格 6.6/6.8：
 * - 默认占满主内容区的单列卡片：未掌握固定排在已掌握前，同一状态内最新录入在
 *   最上方（排序在组合根视图完成）；第二行显示录入日期与当前状态。
 * - 点击整卡打开详情（不新开窗口、不覆盖侧边栏、不改变导航选中）：桌面端从主
 *   内容区右侧滑出并排面板（列表收窄为三行重排）；移动端（≤900px）改为底部
 *   浮动 sheet 毛玻璃覆盖层（第二轮重构：旧版铺满整行会把列表顶出视口）。
 *   两种形态都只通过"收起"按钮或 Escape 关闭，点击详情外其他区域不收起。
 * - 筛选面板位于标题区下方、列表上方；搜索框输入即实时搜索，同时匹配英文词条
 *   与中文释义，与掌握状态筛选组合生效；筛选与详情完全解耦（被过滤掉才收起）。
 * - 掌握标记与删除词条依赖的应用层用例（手动标记事件、软移除独立用例）尚未
 *   交付（协议枚举待晨审），本页如实不提供对应按钮，不伪造功能。
 *
 * 性能与渲染口径（第二轮 React 重构）：卡片提取为 memo 组件（稳定 props）；
 * 详情可见性在渲染期派生（选中项被过滤掉即渲染期调整，不经 effect 同步）；
 * 长列表用 content-visibility 跳过屏外渲染（DOM 保持挂载，不用虚拟列表）。
 */

import { memo, useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { MasteryStatus } from "@ebbinghaus/domain";
import type { VocabularyEntryView } from "../services/learningViews.ts";
import { useActiveSpace, useServices } from "../services/servicesContext.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { PageShell } from "../ui/PageShell.tsx";
import { formatUserDate } from "../ui/display.ts";

/** 掌握状态筛选值；常规模式额外提供"今天待测试"。 */
type StatusFilter = "全部" | "今天待测试" | "学习中" | "已掌握";

/** 面向用户的状态文本：已掌握 / 今天待测试 / 学习中（规格 12.5）。 */
function statusLabel(entry: VocabularyEntryView, nowMs: number): string {
  if (entry.masteryStatus === MasteryStatus.Mastered) {
    return "已掌握";
  }
  if (entry.nextDueAt !== null && Date.parse(entry.nextDueAt) <= nowMs) {
    return "今天待测试";
  }
  return "学习中";
}

/**
 * 单词卡片（rerender-memo）：60 词长列表中，筛选输入每敲一键都会重渲染整页；
 * 卡片 props 全部是稳定值（entry 引用来自 useMemo 的 entries、label/录入日期
 * 是纯字符串、selected 布尔、onSelect 是 useCallback 固定引用），memo 命中后
 * 未变化的卡片跳过整段子树渲染。
 */
const VocabCard = memo(function VocabCard({
  entry,
  label,
  recordedLabel,
  selected,
  onSelect,
}: {
  readonly entry: VocabularyEntryView;
  /** 已算好的状态文案（已掌握 / 今天待测试 / 学习中）。 */
  readonly label: string;
  /** 已格式化的录入日期前缀（如"3 天前"），不含"录入"后缀。 */
  readonly recordedLabel: string;
  readonly selected: boolean;
  readonly onSelect: (wordId: string) => void;
}): ReactNode {
  const mastered = label === "已掌握";
  return (
    <button
      type="button"
      className={`vocab-card${mastered ? " mastered" : ""}${selected ? " selected" : ""}`}
      onClick={() => onSelect(entry.wordId)}
      data-testid={`vocab-card-${entry.originalSpelling}`}
    >
      <span className="vocab-card-row">
        <span className="vocab-card-term">
          {entry.originalSpelling}
          {mastered ? (
            <span className="mastered-check" role="img" aria-label="已掌握">
              ✓
            </span>
          ) : null}
        </span>
        <span className="vocab-card-meaning">{entry.manualMeaning}</span>
        <span className="vocab-card-arrow" aria-hidden="true">
          ›
        </span>
      </span>
      <span className="vocab-card-row meta">
        <span>{recordedLabel}录入</span>
        <span>{label}</span>
      </span>
    </button>
  );
});

export function VocabularyPage(): ReactNode {
  const services = useServices();
  const activeSpace = useActiveSpace();
  const version = useSyncExternalStore(services.subscribeChanged, services.getVersion, services.getVersion);

  const [filterOpen, setFilterOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("全部");
  const [query, setQuery] = useState("");
  const [detailWordId, setDetailWordId] = useState<string | null>(null);

  const entries = useMemo(() => {
    if (activeSpace === null) {
      return [] as VocabularyEntryView[];
    }
    return services.learningViews.listVocabularyEntries(activeSpace.id);
    // eslint 语义：version 变化意味着需要重读列表。
  }, [services, version, activeSpace]);

  const isRegularMode = activeSpace?.learningMode === "常规模式";
  // "今天待测试"到期判断与"录入日期"同年判断统一使用组合根注入时钟（测试为固定
  // 时钟），禁止直读系统时间；version 变化时重取，保证事件写入后状态即时刷新。
  const referenceNow = useMemo(() => services.clock.now(), [services, version]);
  const nowMs = referenceNow.getTime();

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return entries.filter((entry) => {
      const label = statusLabel(entry, nowMs);
      if (statusFilter === "已掌握" && label !== "已掌握") {
        return false;
      }
      if (statusFilter === "学习中" && label !== "学习中") {
        return false;
      }
      if (statusFilter === "今天待测试" && label !== "今天待测试") {
        return false;
      }
      if (keyword === "") {
        return true;
      }
      if (entry.originalSpelling.toLowerCase().includes(keyword)) {
        return true;
      }
      // 中文释义模糊匹配：任一义项命中即保留。
      return entry.meanings.some((meaning) => meaning.definition.includes(keyword) || meaning.definition.includes(query.trim()));
    });
  }, [entries, query, statusFilter, nowMs]);

  // 详情与筛选解耦（规格 12.1）：选中词条被过滤掉时详情收起。
  // rerender-derived-state-no-effect：不做"effect 监听 filtered → 回写 state"的
  // 同步回路，改为渲染期派生调整——渲染中发现选中项已不在筛选结果内，立即
  // setState 清空选中；React 会丢弃本次渲染输出、携带新状态立刻重渲染，
  // 详情不会闪出一帧。语义与原 effect 完全一致（选中永久清除，而非暂隐）。
  if (detailWordId !== null && !filtered.some((entry) => entry.wordId === detailWordId)) {
    setDetailWordId(null);
  }

  // Escape 收起详情（规格 12.2）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && detailWordId !== null) {
        event.stopPropagation();
        setDetailWordId(null);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [detailWordId]);

  // 卡片选中回调：setState 函数引用天然稳定，useCallback 空依赖保证 VocabCard
  // 的 memo props 不因父级重渲染而失效。
  const selectCard = useCallback((wordId: string): void => {
    setDetailWordId(wordId);
  }, []);

  if (activeSpace === null) {
    return (
      <PageShell title="词汇" description="先处理仍在学习的词。">
        <EmptyState title="还没有选择 Space" description="从侧边栏顶部选择一个 Space，再回到这里查看词汇。" />
      </PageShell>
    );
  }

  const detailEntry = detailWordId === null ? null : (entries.find((entry) => entry.wordId === detailWordId) ?? null);
  const statusOptions: readonly StatusFilter[] = isRegularMode
    ? ["全部", "今天待测试", "学习中", "已掌握"]
    : ["全部", "学习中", "已掌握"];

  return (
    <PageShell
      title="词汇"
      description="先处理仍在学习的词。"
      actions={
        <button
          type="button"
          className="btn btn-secondary"
          aria-expanded={filterOpen}
          onClick={() => setFilterOpen((open) => !open)}
          data-testid="vocabulary-filter-toggle"
        >
          筛选
        </button>
      }
    >
      {filterOpen ? (
        <section className="card filter-panel" data-testid="vocabulary-filter-panel">
          <div className="field">
            <label className="field-label" htmlFor="vocabulary-status-filter">
              状态
            </label>
            <select
              id="vocabulary-status-filter"
              className="field-input"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
              data-testid="vocabulary-status-filter"
            >
              {statusOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
          <div className="field filter-search">
            <label className="field-label" htmlFor="vocabulary-search">
              搜索
            </label>
            <input
              id="vocabulary-search"
              className="field-input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="搜索词条或释义"
              data-testid="vocabulary-search"
            />
          </div>
        </section>
      ) : null}

      {entries.length === 0 ? (
        <EmptyState
          title="还没有录入任何词"
          description="在录入中添加重点词后，会显示在这里。"
        />
      ) : filtered.length === 0 ? (
        <EmptyState title="没有匹配的词" description="换个关键词，或清除筛选后再试。" />
      ) : (
        <div className={`vocab-layout${detailEntry === null ? "" : " with-detail"}`}>
          <div className={`vocab-list${detailEntry === null ? "" : " narrow"}`} data-testid="vocabulary-list">
            {filtered.map((entry) => (
              <VocabCard
                key={entry.wordId}
                entry={entry}
                label={statusLabel(entry, nowMs)}
                recordedLabel={formatUserDate(entry.recordedAt, referenceNow)}
                selected={detailWordId === entry.wordId}
                onSelect={selectCard}
              />
            ))}
          </div>
          {detailEntry === null ? null : (
            <aside className="vocab-detail" data-testid="vocabulary-detail">
              <div className="vocab-detail-header">
                <h2 className="vocab-detail-title">
                  {detailEntry.originalSpelling}
                  {detailEntry.masteryStatus === MasteryStatus.Mastered ? (
                    <span className="mastered-check" role="img" aria-label="已掌握">
                      ✓
                    </span>
                  ) : null}
                </h2>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setDetailWordId(null)}
                  aria-label="收起词汇详情"
                  data-testid="vocabulary-detail-close"
                >
                  收起
                </button>
              </div>
              <p className="vocab-detail-meta" data-testid="vocabulary-detail-meta">
                {formatUserDate(detailEntry.recordedAt, referenceNow)}录入 · {statusLabel(detailEntry, nowMs)}
              </p>
              <section className="vocab-detail-section">
                <h3 className="card-section-title">你的释义</h3>
                {detailEntry.meanings.map((meaning, index) => (
                  <p className="vocab-meaning-line" key={index} data-testid={`vocabulary-meaning-${index}`}>
                    {meaning.partOfSpeech === null ? null : <span className="meaning-pos-text">{meaning.partOfSpeech} </span>}
                    {meaning.definition}
                    {meaning.usage === null ? null : <span className="meaning-usage-text">（{meaning.usage}）</span>}
                  </p>
                ))}
              </section>
              <section className="vocab-detail-section" data-testid="vocabulary-detail-progress">
                <h3 className="card-section-title">学习进度</h3>
                <p className="vocab-progress-line">
                  {detailEntry.lastJudgement === null
                    ? "还没有测试记录。"
                    : `最近一次测试：${detailEntry.lastJudgement}。`}
                  {detailEntry.nextDueAt !== null
                    ? ` 下次测试：${formatUserDate(detailEntry.nextDueAt, referenceNow)}。`
                    : null}
                </p>
              </section>
            </aside>
          )}
        </div>
      )}
    </PageShell>
  );
}
