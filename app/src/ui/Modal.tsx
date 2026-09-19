/**
 * 模态对话框：创建/编辑 Space 与危险操作确认共用。
 *
 * 可访问性：role="dialog" + aria-modal + 标题关联；Escape 关闭等同"取消"，
 * 绝不撤销任何已确认的学习结果（键盘规格：Escape 只关闭临时表单）。
 * 打开时初始焦点由内容里的 autoFocus 元素承接。
 */

import { useEffect, type ReactNode } from "react";

export interface ModalProps {
  /** 对话框标题（同时作为可访问名称）。 */
  title: string;
  /** Escape / 取消按钮的关闭回调。 */
  onClose(): void;
  children: ReactNode;
}

export function Modal({ title, onClose, children }: ModalProps): ReactNode {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} data-testid="modal">
        <h2 className="modal-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}
