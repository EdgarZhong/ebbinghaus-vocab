import { $, expect } from "@wdio/globals";

describe("V2 macOS 原生应用", () => {
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
