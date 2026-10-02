/**
 * 复习页（2026-10-02 口径重写）：两种学习模式统一的**纯浏览入口**。
 *
 * 交互语义对应界面设计规格第 9 章与需求规格 6.4/6.8：
 * - 词书模式按 List 分组展示今天关注的候选词；常规模式按当天测试组分组展示
 *   已测条目。两种模式共用同一套卡片结构、展开收起交互与词卡样式（规格 9.3）。
 * - 点击 List 卡/组卡主体展开词列表，再点收起；展开只改变本机展示状态，不写
 *   任何数据、不产生学习事件、不计工作量。
 * - 页面无任何完成/确认/推迟/勾选操作，不显示逾期、到期或完成状态，无 toast；
 *   词卡片只含左英文（左对齐）+ 右释义（右对齐，含用法、放不下时横滚）两列。
 * - 常规模式最终"不认识"的条目置顶，并以文字 + 警示图标标注"刚刚忘记"
 *   （不只依靠颜色表达，规格 9.3）。
 */

import { useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { TestJudgement } from "@ebbinghaus/domain";
import type {
  BookReviewListView,
  RegularReviewGroupView,
} from "../services/learningViews.ts";
import { useActiveSpace, useServices } from "../services/servicesContext.tsx";
import { formatManualMeaning } from "../ui/meaningDisplay.ts";
import { EmptyState } from "../ui/EmptyState.tsx";
import { PageShell } from "../ui/PageShell.tsx";

/** 词书模式复习页说明（规格 9.1）。 */
const BOOK_DESCRIPTION = "浏览今天关注的词，线下翻开纸质书朗读。";
/** 常规模式复习页说明（规格 9.3）。 */
const REGULAR_DESCRIPTION = "查看今天已经测试过的条目，方便朗读和背诵。";
/** 统一空状态（规格 9.2，两种模式同一文案）。 */
const EMPTY_TITLE = "今天没有需要关注的词";
const EMPTY_DESCRIPTION = "完成测试或复习计划到期后，今天关注的词会显示在这里。";

export function ReviewPage(): ReactNode {
  const services = useServices();
  const activeSpace = useActiveSpace();
  const version = useSyncExternalStore(services.subscribeChanged, services.getVersion, services.getVersion);

  const isRegularMode = activeSpace?.learningMode === "常规模式";

  const bookLists = useMemo(() => {
    if (activeSpace === null || activeSpace.learningMode !== "词书模式") {
      return [] as readonly BookReviewListView[];
    }
    return services.learningViews.listBookReviewLists(activeSpace.id);
    // eslint 语义：version 变化意味着候选集（派生态）可能已更新。
  }, [services, version, activeSpace]);

  const regularGroups = useMemo(() => {
    if (activeSpace === null || activeSpace.learningMode !== "常规模式") {
      return [] as readonly RegularReviewGroupView[];
    }
    return services.learningViews.listRegularReviewGroups(activeSpace.id);
  }, [services, version, activeSpace]);

  if (activeSpace === null) {
    return (
      <PageShell title="复习" description={BOOK_DESCRIPTION}>
        <EmptyState title="还没有选择 Space" description="从侧边栏顶部选择一个 Space，再回到这里安排复习。" />
      </PageShell>
    );
  }

  return isRegularMode ? (
    <RegularReviewView groups={regularGroups} />
  ) : (
    <BookReviewView lists={bookLists} />
  );
}

// ---------------------------------------------------------------------------
// 词书模式：按 List 分组的候选词浏览
// ---------------------------------------------------------------------------

function BookReviewView({ lists }: { lists: readonly BookReviewListView[] }): ReactNode {
  /** 当前展开的 List 卡标题；null 表示全部收起（纯本机展示状态，规格 9.2）。 */
  const [expandedTitle, setExpandedTitle] = useState<string | null>(null);

  return (
    <PageShell title="复习" description={BOOK_DESCRIPTION}>
      {lists.length === 0 ? (
        <EmptyState title={EMPTY_TITLE} description={EMPTY_DESCRIPTION} />
      ) : (
        <div className="row-list" data-testid="review-list">
          {lists.map((view) => {
            const expanded = expandedTitle === view.title;
            return (
              <ReviewCard
                key={view.listId}
                testId={`review-list-${view.title}`}
                headerTestId={`review-list-header-${view.title}`}
                wordsTestId={`review-words-${view.title}`}
                title={view.title}
                meta={<>{`今天关注 ${view.words.length} 个词`}</>}
                expanded={expanded}
                onToggle={() =>
                  setExpandedTitle((current) => (current === view.title ? null : view.title))
                }
                entries={view.words.map((word) => ({
                  key: word.wordId,
                  term: word.originalSpelling,
                  // 释义含用法、按词性条目顺序直接展示；放不下时由释义区横滚承接。
                  meaning: formatManualMeaning(word.manualMeaning, word.meanings, "；"),
                }))}
              />
            );
          })}
        </div>
      )}
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// 常规模式：按当天测试组分组的已测条目朗读
// ---------------------------------------------------------------------------

function RegularReviewView({ groups }: { groups: readonly RegularReviewGroupView[] }): ReactNode {
  /** 当前展开的组卡序号；null 表示全部收起。 */
  const [expandedOrdinal, setExpandedOrdinal] = useState<number | null>(null);

  return (
    <PageShell title="复习" description={REGULAR_DESCRIPTION}>
      {groups.length === 0 ? (
        <EmptyState title={EMPTY_TITLE} description={EMPTY_DESCRIPTION} />
      ) : (
        <div className="row-list" data-testid="review-group-list">
          {groups.map((group) => {
            const expanded = expandedOrdinal === group.ordinal;
            return (
              <ReviewCard
                key={group.ordinal}
                testId={`review-group-${group.ordinal}`}
                headerTestId={`review-group-header-${group.ordinal}`}
                wordsTestId={`review-group-words-${group.ordinal}`}
                title={`第 ${group.ordinal} 组 · 已测试 ${group.testedCount} 个条目`}
                meta={
                  group.forgottenCount > 0 ? (
                    <span className="review-card-meta-warning">
                      <WarningIcon />
                      {`刚刚忘记 ${group.forgottenCount} 个`}
                    </span>
                  ) : null
                }
                expanded={expanded}
                onToggle={() =>
                  setExpandedOrdinal((current) => (current === group.ordinal ? null : group.ordinal))
                }
                // 规格 9.3：最终"不认识"的条目始终排在最前，其后才是"认识"的条目。
                entries={[...group.forgotten, ...group.others].map((entry) => ({
                  key: entry.wordId,
                  term: entry.originalSpelling,
                  meaning: formatManualMeaning(entry.manualMeaning, entry.meanings, "；"),
                  forgotten: entry.lastJudgement === TestJudgement.NotRecognized,
                }))}
              />
            );
          })}
        </div>
      )}
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// 共用卡片结构（词书 List 卡与常规组卡同一套，规格 9.3）
// ---------------------------------------------------------------------------

/** 词卡片一行的展示内容：左英文词条 + 右释义； forgotten 行额外带"刚刚忘记"标注。 */
interface ReviewWordRow {
  readonly key: string;
  readonly term: ReactNode;
  readonly meaning: ReactNode;
  readonly forgotten?: boolean;
}

interface ReviewCardProps {
  readonly testId: string;
  readonly headerTestId: string;
  readonly wordsTestId: string;
  readonly title: ReactNode;
  /** 标题行右侧信息；无到期/逾期/完成语义（规格 9.2 禁止状态标识）。 */
  readonly meta: ReactNode | null;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly entries: readonly ReviewWordRow[];
}

/**
 * 复习卡：整张卡头部是一个展开/收起按钮（触控目标 ≥44px），词列表区宽度与卡
 * 一致并保留左侧小缩进，内部纵向滚动、最大高度 = 20 个词卡片（行高固定，
 * 见 pages.css 的 --review-word-row-height）。
 */
function ReviewCard(props: ReviewCardProps): ReactNode {
  return (
    <div className="review-card" data-testid={props.testId}>
      <button
        type="button"
        className="review-card-header"
        aria-expanded={props.expanded}
        onClick={props.onToggle}
        data-testid={props.headerTestId}
      >
        <span className="review-card-title">{props.title}</span>
        {props.meta === null ? null : <span className="review-card-meta">{props.meta}</span>}
      </button>
      {props.expanded ? (
        <div className="review-card-body">
          <ul className="review-word-list" data-testid={props.wordsTestId}>
            {props.entries.map((entry) => (
              <li
                key={entry.key}
                className={entry.forgotten === true ? "review-word-card is-forgotten" : "review-word-card"}
              >
                <span className="review-word-term">{entry.term}</span>
                <span className="review-word-meaning">{entry.meaning}</span>
                {entry.forgotten === true ? (
                  <span className="review-word-flag">
                    <WarningIcon />
                    刚刚忘记
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** 警示图标（规格 9.3："刚刚忘记"必须同时有文字与图标，不只靠颜色）。 */
function WarningIcon(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      <path
        d="M7 1.6 12.8 12H1.2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M7 5.4v2.9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="7" cy="10.5" r="0.9" fill="currentColor" />
    </svg>
  );
}
