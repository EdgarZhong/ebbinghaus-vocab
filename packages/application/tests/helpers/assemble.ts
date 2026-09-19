/**
 * 测试装配辅助：固定的学习日设置与小型构装函数。
 *
 * 时区与换日时间固定为 Asia/Shanghai / 04:00（领域默认值口径），全部时刻锚点使用
 * 2026 年 7 月的 UTC 绝对时间，学习日断言可手算验证：
 * - `2026-07-15T09:00:00Z` → 上海本地 17:00 → 学习日 2026-07-15；
 * - `2026-07-19T19:00:00Z` → 上海本地 03:00（早于 04:00 换日）→ 学习日 2026-07-19；
 * - `2026-07-19T20:00:00Z` → 上海本地 04:00（不早于换日）→ 学习日 2026-07-20。
 */

import { createSpace, type LearningMode, type Space } from "@ebbinghaus/domain";
import type { LearningDaySettings } from "@ebbinghaus/domain";
import type { SpaceStore } from "../../src/ports.ts";

/** 全部测试共用的学习日设置（与领域默认值一致）。 */
export const LEARNING_DAY_SETTINGS: LearningDaySettings = {
  timezoneName: "Asia/Shanghai",
  rolloverTime: "04:00",
};

/** 直接向 Space 存储登记一个 Space（绕过用例，供编排其他用例的前置数据）。 */
export function seedSpace(
  store: SpaceStore,
  input: {
    readonly id: string;
    readonly learningMode: LearningMode;
    readonly displayOrder?: number;
    readonly name?: string | null;
  },
): Space {
  const space = createSpace({
    id: input.id,
    kind: null,
    displayOrder: input.displayOrder ?? 1,
    name: input.name ?? null,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    learningMode: input.learningMode,
  });
  store.addSpace(space);
  return space;
}
