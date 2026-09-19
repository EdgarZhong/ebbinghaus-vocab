/**
 * 复习页（占位）：按界面设计规格 9.2 的空状态口径表达。
 * 任务列表（词书模式纸质复习 / 常规模式朗读组）由 UI-2 接线调度用例后交付。
 */

import { EmptyState } from "../ui/EmptyState.tsx";
import { PageShell } from "../ui/PageShell.tsx";

export function ReviewPage(): React.ReactNode {
  return (
    <PageShell title="复习" description="按 List 翻开纸质词书复习。">
      <EmptyState
        title="今天没有需要复习的 List"
        description="有新的复习任务时，会显示在这里。"
      />
    </PageShell>
  );
}
