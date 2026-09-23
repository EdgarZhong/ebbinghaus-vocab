/**
 * 展示映射工具：把派生数据中的内部值翻译为用户可读的行为语言。
 *
 * 业务原因（界面设计规格第 15 章）：`T0 + 1`、事件名、FSRS 评级、UTC 时间等
 * 内部信息不得上屏；本模块是唯一的翻译点，禁止在页面里散落映射规则。
 */

/**
 * 用户可读日期：与本年（相对参考时刻）显示"9月18日"，跨年显示"2025年12月30日"。
 * referenceNow 必须来自组合根注入时钟（services.clock.now()），禁止在展示层
 * 直读系统时间——否则界面文案随真实日期漂移，固定时钟测试随之失效。
 */
export function formatUserDate(iso: string, referenceNow: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const sameYear = date.getFullYear() === referenceNow.getFullYear();
  const monthDay = `${date.getMonth() + 1}月${date.getDate()}日`;
  return sameYear ? monthDay : `${date.getFullYear()}年${monthDay}`;
}

/** 今日页标题：按用户设置的时区展示"今天 · M月D日"（学习日投影的用户视角）。 */
export function formatTodayTitle(timezoneName: string, now: Date): string {
  try {
    const formatter = new Intl.DateTimeFormat("zh-CN", {
      timeZone: timezoneName,
      month: "long",
      day: "numeric",
    });
    return `今天 · ${formatter.format(now)}`;
  } catch {
    // 无效时区名时回退浏览器本地时区，保证标题始终可读。
    const formatter = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" });
    return `今天 · ${formatter.format(now)}`;
  }
}

/** 到期程度的统一文案："今天到期" / "逾期 N 天"。 */
export function formatDueLabel(overdueDays: number): string {
  return overdueDays > 0 ? `逾期 ${overdueDays} 天` : "今天到期";
}
