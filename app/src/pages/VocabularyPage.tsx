/**
 * 词汇页（功能完整）：全宽单列 Word 卡片 + 词条详情 + 查询过滤。
 *
 * 交互语义对应界面设计规格第 12 章与需求规格 6.6/6.8：
 * - 默认占满主内容区的单列卡片：未掌握固定排在已掌握前，同一状态内最新录入在
 *   最上方（排序在组合根视图完成）；折叠态只展示英文、手录释义和展开箭头。
 * - 点击整卡打开详情（不新开窗口、不覆盖侧边栏、不改变导航选中）：桌面端从主
 *   内容区右侧滑出并排面板（列表收窄为三行重排）；移动端（≤900px）改为底部
 *   浮动 sheet 毛玻璃覆盖层（第二轮重构：旧版铺满整行会把列表顶出视口）。
 *   两种形态均可通过"收起"按钮、Escape 或主内容区的非卡片空白处关闭；
 *   点击其他词卡替换详情，左侧导航栏不参与这一交互。
 * - 筛选面板位于标题区下方、列表上方；搜索框输入即实时搜索，同时匹配英文词条
 *   与中文释义，与掌握状态筛选组合生效；筛选与详情完全解耦（被过滤掉才收起）。
 * - 双向掌握直接提交事件；详情删除为“删除词条→确认删除”，卡片右滑后露出删除。
 * - 卡片只负责选中；掌握切换放在详情中。悬停时临时出现的卡片按钮曾在窄屏
 *   点击中央时抢走点击并误改掌握状态，属于用户旅程错误，不能保留。
 *
 * 性能与渲染口径：卡片提取为 memo 组件（稳定 props）；详情可见性在渲染期
 * 派生；列表与目录批量读取。旧版 content-visibility 曾使快速滚动后的可见卡片
 * 短暂空白，因此保持完整绘制。
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { MasteryStatus } from "@ebbinghaus/domain";
import type { DictionarySnapshot } from "@ebbinghaus/application";
import type { VocabularyEntryView } from "../services/learningViews.ts";
import { useActiveSpace, useServices } from "../services/servicesContext.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { PageShell } from "../ui/PageShell.tsx";
import { useToast } from "../shell/ToastContext.tsx";
import { formatUserDate } from "../ui/display.ts";
import { formatManualMeaning } from "../ui/meaningDisplay.ts";

/** V1 词汇页只按领域掌握状态过滤；今天是否到期属于“测试”页。 */
type StatusFilter = "全部掌握状态" | "未掌握" | "已掌握";

/**
 * 单词卡片（rerender-memo）：60 词长列表中，筛选输入每敲一键都会重渲染整页；
 * 卡片 props 全部是稳定值（entry 引用来自 useMemo 的 entries、label/录入日期
 * 是纯字符串、selected 布尔、onSelect 是 useCallback 固定引用），memo 命中后
 * 未变化的卡片跳过整段子树渲染。
 */
const VocabCard = memo(function VocabCard({
  entry,
  selected,
  onSelect,
  onRemove,
}: {
  readonly entry: VocabularyEntryView;
  readonly selected: boolean;
  readonly onSelect: (wordId: string) => void;
  readonly onRemove: (wordId: string) => void;
}): ReactNode {
  const mastered = entry.masteryStatus === MasteryStatus.Mastered;
  const [swiped, setSwiped] = useState(false);
  const pointerStart = useRef<number | null>(null);
  const swiping = useRef(false);
  const select = (): void => {
    if (swiped) { setSwiped(false); return; }
    if (!swiping.current) onSelect(entry.wordId);
  };
  return (
    <div className={`vocab-card-row-wrap${swiped ? " swiped" : ""}`}>
      <button type="button" className="vocab-swipe-delete" onClick={() => onRemove(entry.wordId)} aria-label={`删除 ${entry.originalSpelling}`} data-testid={`vocab-swipe-delete-${entry.originalSpelling}`}>删除</button>
      <div
        role="button"
        tabIndex={0}
        className={`vocab-card${mastered ? " mastered" : ""}${selected ? " selected" : ""}`}
        onClick={select}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); } }}
        onPointerDown={(event) => { pointerStart.current = event.clientX; swiping.current = false; }}
        onPointerMove={(event) => { if (pointerStart.current !== null && event.clientX - pointerStart.current > 24) swiping.current = true; }}
        onPointerUp={(event) => { if (pointerStart.current !== null && event.clientX - pointerStart.current > 42 && !selected) setSwiped(true); pointerStart.current = null; }}
        data-testid={`vocab-card-${entry.originalSpelling}`}
        aria-label={`查看 ${entry.originalSpelling}${entry.unitNumber === null ? "" : `，Unit ${entry.unitNumber}，List ${entry.listNumber}`}`}
      >
        <span className="vocab-card-row">
          <span className="vocab-card-term">{entry.originalSpelling}</span>
          {mastered ? <span className="mastered-check" role="img" aria-label="已掌握">✓</span> : null}
          <span className="vocab-card-meaning">{formatManualMeaning(entry.manualMeaning, entry.meanings, "；")}</span>
          <span className="vocab-card-arrow" aria-hidden="true">›</span>
        </span>
        <span className="vocab-card-row meta">{entry.unitNumber === null ? entry.masteryStatus : `Unit ${entry.unitNumber} · List ${entry.listNumber}`}</span>
      </div>
    </div>
  );
});

export function VocabularyPage(): ReactNode {
  const services = useServices();
  const { showToast } = useToast();
  const activeSpace = useActiveSpace();
  const version = useSyncExternalStore(services.subscribeChanged, services.getVersion, services.getVersion);

  const [filterOpen, setFilterOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("全部掌握状态");
  const [unitFilter, setUnitFilter] = useState(0);
  const [listFilter, setListFilter] = useState(0);
  const [query, setQuery] = useState("");
  const [selectedWordId, setSelectedWordId] = useState<string | null>(null);
  const [detailWordId, setDetailWordId] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [detailDeleteArmed, setDetailDeleteArmed] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [dictionaryView, setDictionaryView] = useState<{ wordId: string; snapshot: DictionarySnapshot } | null>(null);
  const [dictionaryBusy, setDictionaryBusy] = useState(false);

  const entries = useMemo(() => {
    if (activeSpace === null) {
      return [] as VocabularyEntryView[];
    }
    return services.learningViews.listVocabularyEntries(activeSpace.id);
    // eslint 语义：version 变化意味着需要重读列表。
  }, [services, version, activeSpace]);

  const isRegularMode = activeSpace?.learningMode === "常规模式";
  // 学习记录日期使用注入时钟做同年判断，避免测试或跨时区展示随系统时钟漂移。
  const referenceNow = useMemo(() => services.clock.now(), [services, version]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (statusFilter !== "全部掌握状态" && entry.masteryStatus !== statusFilter) return false;
      if (unitFilter > 0 && entry.unitNumber !== unitFilter) return false;
      if (listFilter > 0 && entry.listNumber !== listFilter) return false;
      if (keyword === "") {
        return true;
      }
      if (entry.originalSpelling.toLowerCase().includes(keyword)) {
        return true;
      }
      // 中文释义模糊匹配：任一义项命中即保留。
      return entry.meanings.some((meaning) => meaning.definition.includes(keyword) || meaning.usage?.toLowerCase().includes(keyword));
    });
  }, [entries, query, statusFilter, unitFilter, listFilter]);

  // 详情与筛选解耦（规格 12.1）：选中词条被过滤掉时详情收起。
  // rerender-derived-state-no-effect：不做"effect 监听 filtered → 回写 state"的
  // 同步回路，改为渲染期派生调整——渲染中发现选中项已不在筛选结果内，立即
  // setState 清空选中；React 会丢弃本次渲染输出、携带新状态立刻重渲染，
  // 详情不会闪出一帧。语义与原 effect 完全一致（选中永久清除，而非暂隐）。
  if (detailWordId !== null && !filtered.some((entry) => entry.wordId === detailWordId)) {
    setDetailWordId(null);
  }
  if (selectedWordId !== null && !filtered.some((entry) => entry.wordId === selectedWordId)) {
    setSelectedWordId(null);
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
    setSelectedWordId(wordId);
    setDetailWordId(wordId);
    setDetailDeleteArmed(false);
    setTimelineOpen(false);
  }, []);

  const closeDetail = useCallback((): void => {
    setDetailWordId(null);
    setSelectedWordId(null);
    setDetailDeleteArmed(false);
  }, []);

  useEffect(() => {
    if (detailWordId === null) return;
    // PageShell 有最大宽度；监听它只能覆盖页内间隙，无法接到主内容区两侧
    // 的留白点击。将委托绑定到本页所在的 main，路由离开或详情收起时即移除，
    // 避免影响导航栏及其他页面。卡片、详情、筛选面板和功能控件保留原动作。
    const main = document.querySelector<HTMLElement>(".main-area");
    if (main === null) return;
    const closeOnMainBlankClick = (event: Event): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".vocab-card-row-wrap, .vocab-detail, .filter-panel, button, input, select, textarea, a, [role='button']")) return;
      closeDetail();
    };
    main.addEventListener("click", closeOnMainBlankClick);
    return () => main.removeEventListener("click", closeOnMainBlankClick);
  }, [detailWordId, closeDetail]);

  // 筛选输入和详情展开属于局部交互，不需要逐次跨同步数据库桥重读开关。
  // 沿用业务版本读取设置，在线词典及列表更新仍由原有通知与 effect 驱动。
  const dictionaryEnabled = useMemo(() => services.settings.getFeatureFlags().onlineDictionary, [services, version]);
  useEffect(() => {
    if (detailWordId === null || !dictionaryEnabled) {
      setDictionaryView(null);
      setDictionaryBusy(false);
      return;
    }
    let cancelled = false;
    const wordId = detailWordId;
    const cached = services.dictionary.getSnapshot(wordId);
    setDictionaryView({ wordId, snapshot: cached });
    if (!cached.needsRefresh) return () => { cancelled = true; };
    // V1 打开详情时自动补拉；查询期间保持界面可操作，收起或切换词条则取消旧结果。
    setDictionaryBusy(true);
    void services.dictionary.load(wordId, { isCancelled: () => cancelled }).then((snapshot) => {
      if (cancelled) return;
      setDictionaryView({ wordId, snapshot });
      // 在线结果只更新当前详情的局部状态；缓存已由词典服务落地，后续页面
      // 进入时会自行读取。广播全局 version 会把整张词表重新读库并重排。
    }).catch(() => {
      if (!cancelled) setDictionaryView({ wordId, snapshot: {
        status: "查询失败", provider: "在线词典", fetchedAt: null, definitions: [],
        message: "在线释义暂时不可用，请检查网络后重试", needsRefresh: true,
      } });
    }).finally(() => { if (!cancelled) setDictionaryBusy(false); });
    return () => { cancelled = true; };
  }, [detailWordId, dictionaryEnabled, services]);

  const retryDictionary = (): void => {
    if (detailWordId === null || dictionaryBusy) return;
    const wordId = detailWordId;
    setDictionaryBusy(true);
    void services.dictionary.load(wordId).then((snapshot) => {
      setDictionaryView({ wordId, snapshot });
    }).catch(() => setDictionaryView({ wordId, snapshot: {
      status: "查询失败", provider: "在线词典", fetchedAt: null, definitions: [],
      message: "在线释义暂时不可用，请检查网络后重试", needsRefresh: true,
    } })).finally(() => setDictionaryBusy(false));
  };

  const markWord = (wordId: string, mastered: boolean): void => {
    if (activeSpace === null) return;
    try {
      services.vocabularyMastery.mark({ spaceId: activeSpace.id, wordId, mastered });
      services.notifyChanged();
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const confirmRemove = (wordId: string): void => {
    try {
      services.bookLearning.removeWord({ wordId, firstConfirmation: true, secondConfirmation: true });
      services.notifyChanged();
      showToast("词条已从词汇中移除。");
      setDetailWordId(null);
      setSelectedWordId(null);
      setDetailDeleteArmed(false);
    } catch (cause) {
      setEditError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (activeSpace === null) {
    return (
      <PageShell title="词汇" description="先处理仍在学习的词。">
        <EmptyState title="还没有选择 Space" description="从侧边栏顶部选择一个 Space，再回到这里查看词汇。" />
      </PageShell>
    );
  }

  const detailEntry = detailWordId === null ? null : (entries.find((entry) => entry.wordId === detailWordId) ?? null);
  const statusOptions: readonly StatusFilter[] = ["全部掌握状态", "未掌握", "已掌握"];
  // 学习记录默认折叠；只有展开后才读本地事件表，避免每次选词和输入筛选词
  // 都同步扫描历史事件，尤其真实 SQLite 桥接会阻塞 WebView 主线程。
  const timeline = detailEntry === null || !timelineOpen ? [] : services.learningViews.listVocabularyTimeline(detailEntry.wordId);
  const dictionarySnapshot = detailEntry !== null && dictionaryView?.wordId === detailEntry.wordId ? dictionaryView.snapshot : null;
  const dictionaryHasContent = (dictionarySnapshot?.definitions.length ?? 0) > 0;
  const dictionaryFailed = dictionarySnapshot?.status === "查询失败" && !dictionaryHasContent;

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
          {isRegularMode ? null : (
            <>
              <div className="field"><label className="field-label" htmlFor="vocabulary-unit-filter">Unit</label>
                <input id="vocabulary-unit-filter" className="field-input" type="number" min="0" max="9999" value={unitFilter || ""} placeholder="全部" onChange={(event) => setUnitFilter(Number(event.target.value) || 0)} data-testid="vocabulary-unit-filter" />
              </div>
              <div className="field"><label className="field-label" htmlFor="vocabulary-list-filter">List</label>
                <input id="vocabulary-list-filter" className="field-input" type="number" min="0" max="9999" value={listFilter || ""} placeholder="全部" onChange={(event) => setListFilter(Number(event.target.value) || 0)} data-testid="vocabulary-list-filter" />
              </div>
            </>
          )}
          <div className="field">
            <label className="field-label" htmlFor="vocabulary-status-filter">
              掌握状态
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
              placeholder="搜索词条或释义"
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
                selected={selectedWordId === entry.wordId}
                onSelect={selectCard}
                onRemove={confirmRemove}
              />
            ))}
          </div>
          {detailEntry === null ? null : (
            <aside className="vocab-detail" data-testid="vocabulary-detail">
              <div className="vocab-detail-header">
                <h2 className="vocab-detail-title">{detailEntry.originalSpelling}
                  {detailEntry.masteryStatus === MasteryStatus.Mastered ? (
                    <span className="mastered-check" role="img" aria-label="已掌握">
                      ✓
                    </span>
                  ) : null}
                </h2>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={closeDetail}
                  aria-label="收起词汇详情"
                  data-testid="vocabulary-detail-close"
                >
                  收起
                </button>
              </div>
              <div className="vocab-detail-actions">
                {detailDeleteArmed ? (
                  <><button type="button" className="btn btn-danger" onClick={() => confirmRemove(detailEntry.wordId)} data-testid="vocabulary-confirm-delete">确认删除</button>
                    <button type="button" className="btn btn-secondary" onClick={() => setDetailDeleteArmed(false)} data-testid="vocabulary-cancel-delete">取消</button></>
                ) : <button type="button" className="btn btn-danger" onClick={() => setDetailDeleteArmed(true)} data-testid="vocabulary-remove">删除词条</button>}
                <button type="button" className="btn btn-secondary" onClick={() => markWord(detailEntry.wordId, detailEntry.masteryStatus !== MasteryStatus.Mastered)} data-testid="vocabulary-mark-mastery">
                  {detailEntry.masteryStatus === MasteryStatus.Mastered ? "标记为未掌握" : "标记为已掌握"}
                </button>
              </div>
              <section className="vocab-detail-section">
                <h3 className="card-section-title">手录释义</h3>
                <textarea className="vocab-detail-textarea" readOnly value={formatManualMeaning(detailEntry.manualMeaning, detailEntry.meanings)} aria-label="手录义项主数据" data-testid="vocabulary-manual-meaning" />
              </section>
              {dictionaryEnabled && (dictionaryHasContent || dictionaryFailed) ? (
                <section className="vocab-detail-section" data-testid="vocabulary-online-section">
                  <h3 className="card-section-title">在线释义</h3>
                  {dictionaryHasContent ? <textarea className="vocab-detail-textarea online" readOnly value={dictionarySnapshot?.definitions.map((item) => `${item.partOfSpeech}：${item.definition}`).join("\n") ?? ""} aria-label="在线补充释义" data-testid="vocabulary-online-meanings" /> : null}
                  {dictionaryFailed ? <><p role="alert">在线释义暂时不可用，请检查网络后重试</p><button type="button" className="btn btn-secondary" disabled={dictionaryBusy} onClick={retryDictionary} data-testid="vocabulary-dictionary-retry">重新查询</button></> : null}
                </section>
              ) : null}
              <section className="vocab-detail-section">
                <button type="button" className="vocab-timeline-toggle" onClick={() => setTimelineOpen((open) => !open)} aria-expanded={timelineOpen} data-testid="vocabulary-timeline-toggle">学习记录 {timelineOpen ? "⌄" : "›"}</button>
                {timelineOpen ? <div className="vocab-timeline" data-testid="vocabulary-timeline">
                  {timeline.length === 0 ? <p>暂无学习记录</p> : timeline.map((item) => <p key={item.eventId}>{formatUserDate(item.occurredAt, referenceNow)} · {item.title}</p>)}
                </div> : null}
              </section>
              {editError === null ? null : <p className="field-error" role="alert" data-testid="vocabulary-content-error">{editError}</p>}
            </aside>
          )}
        </div>
      )}
    </PageShell>
  );
}
