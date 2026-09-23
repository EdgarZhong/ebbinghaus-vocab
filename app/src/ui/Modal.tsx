/**
 * 模态对话框：创建/编辑 Space 与危险操作确认共用。
 *
 * 可访问性：role="dialog" + aria-modal + 标题关联；Escape 关闭等同"取消"，
 * 绝不撤销任何已确认的学习结果（键盘规格：Escape 只关闭临时表单）。
 * 打开时初始焦点由内容里的 autoFocus 元素承接。
 *
 * 材质：对话框是浮动层，统一使用 Glass 原语（第二轮设计定案"玻璃是签名材质，
 * 只用在浮动层"）。结构契约（Glass.tsx 文件头）：.modal-backdrop 是 fixed
 * 定位的整屏层，天然充当 .glass-host 的已定位祖先；玻璃面板在背板内水平垂直
 * 居中，尺寸由内容决定——.modal 内容 div 用 min(440px, 100vw - 48px) 自定宽度，
 * Glass padding=0 让 .modal 的 padding 成为唯一内边距来源，保证正常/降级两条
 * 渲染路径（liquid-glass-react / .glass-fallback）的几何完全一致。
 * overLight 固定 false：对话框总浮在 40% 压暗背板之上，背板后的页面已是中灰调，
 * 亮态高光反而不协调。
 */

import { useEffect, type ReactNode } from "react";
import Glass from "./Glass.tsx";

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
      {/* Glass 是浮动层原语：背板（fixed）即已定位祖先，玻璃在其中居中；
          testid 保留在 .modal 内容 div 上，两条路径查询口径一致。 */}
      <Glass className="modal-glass" padding="0" cornerRadius={16} overLight={false}>
        <div className="modal" role="dialog" aria-modal="true" aria-label={title} data-testid="modal">
          <h2 className="modal-title">{title}</h2>
          {children}
        </div>
      </Glass>
    </div>
  );
}
