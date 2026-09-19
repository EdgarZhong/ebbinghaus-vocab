/**
 * 页面骨架：统一的主标题（路由切换后获得辅助功能焦点，屏幕阅读器立即播报
 * 页面名称——界面设计规格 6.1）、说明文字、标题行动作区与内容区。
 */

import { useEffect, useRef, type ReactNode } from "react";

export interface PageShellProps {
  /** 页面唯一主标题。 */
  title: string;
  /** 标题下方的页面级说明（可选）。 */
  description?: string;
  /** 标题同一水平行右侧的动作区（如"创建 Space"主按钮）。 */
  actions?: ReactNode;
  children: ReactNode;
}

export function PageShell({ title, description, actions, children }: PageShellProps): ReactNode {
  const titleRef = useRef<HTMLHeadingElement | null>(null);

  // 挂载即聚焦标题：路由切换意味着页面组件重挂载，焦点随之迁移；
  // tabIndex=-1 使 h1 可编程聚焦但不出现在 Tab 序列中。
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  return (
    <div className="page">
      <header className="page-header-row">
        <div>
          <h1 className="page-title" tabIndex={-1} ref={titleRef} data-testid="page-title">
            {title}
          </h1>
          {description === undefined ? null : <p className="page-description">{description}</p>}
        </div>
        {actions === undefined ? null : <div className="page-header-actions">{actions}</div>}
      </header>
      {children}
    </div>
  );
}
