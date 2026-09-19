/**
 * 首过录入页（占位）：三阶段录入流程（输入 → 检查 → 完成）由 UI-2 接线
 * 智能整理与预览保存用例后交付。当前如实说明功能尚未开放。
 */

import { EmptyState } from "../ui/EmptyState.tsx";
import { PageShell } from "../ui/PageShell.tsx";

export function FirstPassPage(): React.ReactNode {
  return (
    <PageShell title="首过录入" description="录入新学 List 的重点词。">
      <EmptyState
        title="录入功能尚未开放"
        description="首过录入将在后续更新中提供。设置中的学习日与联网辅助现在就可以使用。"
      />
    </PageShell>
  );
}
