/**
 * 非阻塞短暂反馈（toast）：跨页面动作（切换 Space、恢复归档等）使用，
 * 自动消失，不阻塞操作；role="status" 让屏幕阅读器播报而不抢焦点。
 *
 * 视觉：toast 是浮动层，采用与 Glass 降级路径同语言的 CSS 毛玻璃
 * （--glass-* 令牌 + backdrop-filter，样式在 components.css"toast"一节）。
 * 不用 Glass 原语的原因：Glass 的布局契约是"已定位祖先内绝对居中"，而
 * toast 需要在 .toast-region 里多条纵向堆叠——逐条包 Glass 会让每条玻璃
 * 都以整个 region 为居中锚点而互相重叠；CSS 毛玻璃在文档流内天然堆叠，
 * 视觉与玻璃一致且无布局风险。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

interface ToastItem {
  readonly id: number;
  readonly message: string;
}

interface ToastContextValue {
  showToast(message: string): void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/** 每条 toast 的展示时长；足够读出一句短反馈，又不遮蔽后续操作。 */
const TOAST_DURATION_MS = 3000;

export function ToastProvider({ children }: { children: ReactNode }): ReactNode {
  const [toasts, setToasts] = useState<readonly ToastItem[]>([]);
  const nextIdRef = useRef(1);
  /** 存活定时器登记：Provider 卸载时统一清理，杜绝卸载后 setState 的游离回调。 */
  const timersRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers) {
        window.clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);

  const showToast = useCallback((message: string): void => {
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    setToasts((current) => [...current, { id, message }]);
    const timer = window.setTimeout(() => {
      timersRef.current.delete(timer);
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, TOAST_DURATION_MS);
    timersRef.current.add(timer);
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="toast-region">
        {toasts.map((toast) => (
          <div key={toast.id} className="toast" role="status" data-testid="toast">
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (value === null) {
    throw new Error("useToast 必须在 ToastProvider 内使用");
  }
  return value;
}
