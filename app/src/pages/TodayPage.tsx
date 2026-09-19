/**
 * 今日页（占位）：本页完整功能（下一步卡片、学习顺序、每日目标看板与容量
 * 预测接线）由 UI-2 交付。当前按规格表达"三类任务都为空"的完成状态，
 * 不制造虚假任务，也不显示任何内部术语。
 */

import { navigate, routes } from "../router.tsx";
import { useActiveSpace } from "../services/servicesContext.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { PageShell } from "../ui/PageShell.tsx";

export function TodayPage(): React.ReactNode {
  const activeSpace = useActiveSpace();
  // 占位阶段显示本机日期；学习日投影随 UI-2 的看板用例统一接线。
  const now = new Date();
  const dateText = `今天 · ${now.getMonth() + 1}月${now.getDate()}日`;

  return (
    <PageShell
      title={dateText}
      description={activeSpace === null ? undefined : "查看今天最优先的学习动作。"}
    >
      <EmptyState
        title="今天的任务完成了"
        description="可以休息，或自行学习新的 List。测试与复习任务将在到期后出现在这里。"
        action={
          <button type="button" className="btn btn-primary" onClick={() => navigate(routes.firstPass)}>
            录入新 List
          </button>
        }
      />
    </PageShell>
  );
}
