import { $, expect, browser } from "@wdio/globals";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** 原生隔离验收才使用数据库桥；令牌只在受信 WebView 内传递，返回值不含密钥。 */
async function isolatedSql(action: "get" | "run", sql: string, parameters: unknown[] = []): Promise<unknown> {
  return browser.execute(async (requestAction, statement, values) => {
    const tauri = (window as unknown as { __TAURI__: { core: { invoke(command: string): Promise<{ port: number; token: string }> } } }).__TAURI__;
    const info = await tauri.core.invoke("start_sqlite_bridge");
    const response = await fetch(`http://127.0.0.1:${info.port}/query`, {
      method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ token: info.token, action: requestAction, sql: statement, parameters: values }),
    });
    const result = await response.json() as { ok: boolean; value?: unknown; error?: string };
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }, action, sql, parameters);
}

describe("V2 macOS 原生应用", () => {
  (process.env["EBB_SOFT_REMOVED_NATIVE_CHECK"] === "1" ? it : it.skip)("隔离库软移除回归：无0词卡片、旧确认拒绝、暂停恢复及重新读取不复活", async () => {
    // 两道边界共同保护正式数据：必须在独立标识的验收库中明确播种安全标记，
    // 并确认云同步令牌为空，才能对模拟失效词写入内容墓碑。
    const marker = await isolatedSql("get", "SELECT value FROM device_local_kv WHERE key = ?", ["soft_removed_native_check"]) as { value: string } | null;
    expect(marker?.value).toBe("isolated");
    const tokenState = await isolatedSql("get", "SELECT length(value) AS size FROM device_local_kv WHERE key = ?", ["cloud_sync_auth_token_cipher_v1"]) as { size: number } | null;
    expect(tokenState?.size ?? 0).toBe(0);
    const ids = await isolatedSql("get", "SELECT value FROM device_local_kv WHERE key = ?", ["soft_removed_native_lists"]) as { value: string };
    const { finishedListId, seededListId } = JSON.parse(ids.value) as { finishedListId: string; seededListId: string };
    const outputDir = join(process.cwd(), "native-e2e", "__screenshots__");
    mkdirSync(outputDir, { recursive: true });
    await $("a[href='#/test']").click();
    await expect($(`[data-testid='test-task-${finishedListId}']`)).not.toExist();
    await expect($(`[data-testid='test-task-${seededListId}']`)).toHaveText(expect.stringContaining("2 个词"));
    await browser.saveScreenshot(join(outputDir, "soft-removed-task-list.png"));
    await $(`[data-testid='test-start-${seededListId}']`).click();
    await browser.keys("Enter");
    await expect($("[data-testid='session-meaning']")).toExist();
    await browser.saveScreenshot(join(outputDir, "soft-removed-answer.png"));
    const current = await isolatedSql("get", "SELECT session_id, json_extract(words_json, '$[' || current_position || '].wordId') AS word_id FROM test_sessions WHERE list_id = ? AND status = '进行中'", [seededListId]) as { session_id: string; word_id: string };
    await isolatedSql("run", "UPDATE word_contents SET removed = 1 WHERE word_id = ?", [current.word_id]);
    // 失效发生在揭示与最终确认之间：不能把旧初判套到下一词，也不能补写答案。
    await $("[data-testid='session-next']").click();
    await expect($("[data-testid='session-error']")).not.toExist();
    await expect($("[data-testid='session-answer-panel']")).toHaveElementClass("pending");
    await browser.saveScreenshot(join(outputDir, "soft-removed-reconciled.png"));
    const answerCount = await isolatedSql("get", "SELECT COUNT(*) AS count FROM learning_events WHERE event_type='testAnswered' AND target_id=?", [current.word_id]) as { count: number };
    expect(answerCount.count).toBe(0);
    await $("[data-testid='session-pause']").click();
    await expect($(`[data-testid='test-task-${seededListId}']`)).toHaveText(expect.stringContaining("尚余 1 个词"));
    await $(`[data-testid='test-start-${seededListId}']`).click();
    await browser.keys("Enter");
    await expect($("[data-testid='session-meaning']")).toExist();
    await browser.keys("Enter");
    await expect($("[data-testid='test-completed']")).toExist();
    await $("[data-testid='test-back-to-list']").click();
    await expect($(`[data-testid='test-task-${seededListId}']`)).not.toExist();
    const stored = await isolatedSql("get", "SELECT status, json_array_length(words_json) AS count FROM test_sessions WHERE session_id=?", [current.session_id]) as { status: string; count: number };
    expect(stored).toEqual({ status: "已完成", count: 1 });
    await browser.saveScreenshot(join(outputDir, "soft-removed-completed.png"));
  });

  it("从真实 SQLite 启动并可在今日、词汇、设置之间导航", async () => {
    // 这条测试刻意使用现有本机验收库，验证正式平台适配器而非浏览器种子。
    // 桌面会恢复上次浏览的页面，因此每次验收先显式回到“今天”，不依赖上次运行状态。
    await expect($("a[href='#/today']")).toExist();
    await $("a[href='#/today']").click();
    await expect($("h1")).toHaveText(expect.stringContaining("今天"));
    await expect($("button[aria-label*='当前 Space']")).toExist();

    await $("a[href='#/vocabulary']").click();
    await expect($("h1")).toHaveText("词汇");
    await expect($(".vocab-card")).toExist();

    await $("a[href='#/settings']").click();
    await expect($("h1")).toHaveText("设置");
    await expect($("body")).toHaveText(expect.stringContaining("云端数据托管"));
    // 普通设置逐项自动保存，原有整页“保存设置”按钮不应再出现。
    await expect($("[data-testid='settings-save']")).not.toExist();
  });
});
