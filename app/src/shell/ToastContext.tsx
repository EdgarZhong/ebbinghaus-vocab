/**
 * 非阻塞短暂反馈（toast）：跨页面动作（切换 Space、恢复归档等）使用，
 * 自动消失，不阻塞操作；role="status" 让屏幕阅读器播报而不抢焦点。
 */

import {
  createContext,
  useCallback,
  useContext,
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

  const showToast = useCallback((message: string): void => {
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    setToasts((current) => [...current, { id, message }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, TOAST_DURATION_MS);
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
