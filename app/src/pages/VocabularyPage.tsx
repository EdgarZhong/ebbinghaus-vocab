/**
 * 词汇页（占位）：按规格表达"没有任何词条"的空状态。
 * 词卡列表、筛选与右侧详情由 UI-2 接线内容目录后交付。
 */

import { EmptyState } from "../ui/EmptyState.tsx";
import { PageShell } from "../ui/PageShell.tsx";

export function VocabularyPage(): React.ReactNode {
  return (
    <PageShell title="词汇" description="先处理仍在学习的词。">
      <EmptyState
        title="还没有录入任何词"
        description="在首过录入中添加重点词后，会显示在这里。"
      />
    </PageShell>
  );
}
