/**
 * 步进数值输入：文本输入 + 44×44 减/加按钮。
 *
 * 业务原因（界面设计规格 5.4 / 14.4）：数值输入不得依赖原生微型上下箭头；
 * 字段获得焦点后 ↑/↓ 调整一个步长，需要鼠标步进时用独立的大号减号/加号按钮，
 * 单个点击区域至少 44×44，且超出边界时禁用按钮并在附近说明原因。
 */

import { useState, type KeyboardEvent, type ReactNode } from "react";

export interface StepperInputProps {
  id: string;
  /** 无障碍名称与可见标签。 */
  label: string;
  value: string;
  onValueChange(value: string): void;
  min: number;
  max?: number;
  step?: number;
  hint?: string;
  error?: string | null;
  testId: string;
}

function clamp(value: number, min: number, max: number | undefined): number {
  const lower = Math.max(min, value);
  return max === undefined ? lower : Math.min(max, lower);
}

export function StepperInput({
  id,
  label,
  value,
  onValueChange,
  min,
  max,
  step = 1,
  hint,
  error,
  testId,
}: StepperInputProps): ReactNode {
  // 非法输入（空串/非数字）时按钮按"从下界起步"处理，不猜用户意图。
  const parsed = Number.parseInt(value, 10);
  const currentValue = Number.isNaN(parsed) ? null : parsed;
  const [focused, setFocused] = useState(false);

  const adjust = (delta: number): void => {
    // 无值时按 min 起步；越界由 clamp 收敛，按钮禁用态负责提前拦截。
    const origin = currentValue ?? min;
    const next = clamp(origin + delta, min, max);
    onValueChange(String(next));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      adjust(step);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      adjust(-step);
    }
  };

  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <div className="stepper">
        <button
          type="button"
          className="stepper-btn"
          aria-label={`减少${label}`}
          disabled={currentValue === null || currentValue <= min}
          onClick={() => adjust(-step)}
          data-testid={`${testId}-decrease`}
        >
          −
        </button>
        <input
          id={id}
          className="field-input"
          type="text"
          inputMode="numeric"
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          data-testid={testId}
        />
        <button
          type="button"
          className="stepper-btn"
          aria-label={`增加${label}`}
          disabled={currentValue === null || (max !== undefined && currentValue >= max)}
          onClick={() => adjust(step)}
          data-testid={`${testId}-increase`}
        >
          +
        </button>
      </div>
      {focused && currentValue === null ? (
        <p className="field-hint">请输入不小于 {min} 的整数。</p>
      ) : null}
      {hint === undefined ? null : <p className="field-hint">{hint}</p>}
      {error === undefined || error === null ? null : <p className="field-error">{error}</p>}
    </div>
  );
}
