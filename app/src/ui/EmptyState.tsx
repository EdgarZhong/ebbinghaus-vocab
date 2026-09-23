/**
 * 空状态卡片：标题 + 说明 +（可选）动作。文案一律使用行为语言，
 * 禁止内部术语（界面设计规格第 15 章）。
 */

import type { ReactNode } from "react";

export interface EmptyStateProps {
  title: string;
  description: string;
  action?: ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps): ReactNode {
  return (
    <div className="card empty-state" data-testid="empty-state">
      <p className="empty-state-title">{title}</p>
      <p className="empty-state-description">{description}</p>
      {/* 动作区用类而非内联样式：表现全部收口在 components.css，主题一致可复査。 */}
      {action === undefined ? null : <div className="empty-state-action">{action}</div>}
    </div>
  );
}
