/**
 * 测试页（占位）：按界面设计规格 10.1 的空状态口径表达。
 * 到期测试列表与逐词测试流程由 UI-2 接线调度用例后交付。
 */

import { EmptyState } from "../ui/EmptyState.tsx";
import { PageShell } from "../ui/PageShell.tsx";

export function TestPage(): React.ReactNode {
  return (
    <PageShell title="测试" description="在软件里逐词检查记忆，完成后再翻开纸质词书复习。">
      <EmptyState
        title="今天没有需要测试的 List"
        description="新的测试到期后，会显示在这里。"
      />
    </PageShell>
  );
}
