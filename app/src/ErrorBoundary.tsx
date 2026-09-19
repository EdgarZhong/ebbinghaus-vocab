/**
 * 错误边界：捕获渲染期意外错误，给出用户可读的恢复路径。
 * 业务规则与用例错误在页面内部就地处理，不流到这里；这里只兜底
 * "界面本身崩了"的情况。
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryState {
  readonly message: string | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { message: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 控制台记录便于开发定位；界面上绝不展示堆栈与内部术语（规格第 15 章）。
    console.error("界面发生未预期错误", error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.message === null) {
      return this.props.children;
    }
    return (
      <div className="page">
        <div className="card empty-state" role="alert">
          <p className="empty-state-title">界面出现了问题</p>
          <p className="empty-state-description">
            你的学习数据没有受到影响。请重新加载应用；如果反复出现，请反馈这个问题。
          </p>
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            重新加载
          </button>
        </div>
      </div>
    );
  }
}
