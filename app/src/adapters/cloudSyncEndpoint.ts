/**
 * 云同步数据端点（对外发布分支口径）。
 *
 * 端点在构建期经 Vite 环境变量 VITE_CLOUD_SYNC_URL 注入；仓库不内置任何默认
 * 服务器地址——未配置时云同步整体关闭，本地学习功能完整可用。只接受 HTTPS、
 * 不带用户名密码的地址；尾随路径与斜杠统一规整为源（origin），避免与同步
 * 网关拼接路径时出现漂移。该常量为模块级纯计算，浏览器验收环境导入无副作用。
 */
function normalizeEndpoint(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || url.username || url.password) return "";
    return url.origin;
  } catch {
    return "";
  }
}

export const CLOUD_SYNC_ENDPOINT = normalizeEndpoint(import.meta.env["VITE_CLOUD_SYNC_URL"] ?? "");
