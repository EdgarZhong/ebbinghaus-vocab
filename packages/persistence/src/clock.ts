/**
 * 可注入时钟的持久化侧实现。
 *
 * 领域与应用层禁止读取系统当前时间（一切"现在"经 Clock 注入）；持久化层正是
 * 这个约束的"注水口"：SystemClock 是全应用唯一允许 `new Date()` 的地方，生产
 * 与浏览器模式注入它，测试注入固定时钟或手动推进的手动时钟。
 */

import type { Clock } from "@ebbinghaus/domain";

/** 真实系统时钟：生产环境（Tauri 壳与 Node 集成测试）的默认时钟实现。 */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
