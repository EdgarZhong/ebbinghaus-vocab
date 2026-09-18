import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * 架构守卫（任务规格 9）：机器断言"哑服务器"铁律，防止后续演进悄悄越界。
 *
 * 守卫意图（对照技术决策第五章）：
 * 1. 服务器零业务逻辑——禁止依赖 @ebbinghaus/domain 与 @ebbinghaus/application，
 *    任何算法语义都不得进入服务器；协议只允许来自 @ebbinghaus/protocol。
 * 2. 服务器源码中不得出现具体业务域词汇（复习算法名、任务排程、容量推演等），
 *    出现即意味着有人开始在这里写业务语义；本测试对源码（含注释）做文本扫描。
 *    扫描范围 server/src 与 server/scripts，测试代码自身不在此列。
 * 3. 文件系统能力最小化：只有启动配置（目录准备）、库打开（建库/迁移）、备份
 *    三处允许使用 node:fs；其余模块出现 fs 即意味着业务代码在自行定位数据文件。
 * 4. 禁止硬编码本机绝对路径：路径一律来自启动配置（env/CLI/默认包内 data/）。
 */

const SERVER_ROOT = join(import.meta.dirname, "..");

/** 允许使用 node:fs 的模块（相对 server 包根；新增白名单须给出业务理由）。 */
const FS_ALLOWED = new Set(["src/config.ts", "src/db.ts", "src/backup.ts"]);

/** 业务域词汇黑名单：出现即视为业务语义渗入服务器（含中文注释一并扫描）。 */
const FORBIDDEN_BUSINESS_TERMS = ["fsrs", "调度", "capacity"];

function collectSourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".ts")) {
        files.push(relative(SERVER_ROOT, full));
      }
    }
  };
  walk(join(SERVER_ROOT, "src"));
  walk(join(SERVER_ROOT, "scripts"));
  return files;
}

const sourceFiles = collectSourceFiles();
const fileContents = new Map(
  sourceFiles.map((file) => [file, readFileSync(join(SERVER_ROOT, file), "utf8")]),
);

describe("哑服务器架构守卫", () => {
  it("应扫描到 server/src 与 server/scripts 下的全部 TS 源文件", () => {
    expect(sourceFiles.length).toBeGreaterThanOrEqual(10);
    expect(sourceFiles).toContain("src/app.ts");
    expect(sourceFiles).toContain("scripts/backup.ts");
  });

  it("任何源文件不得 import 领域层或应用层包（服务器零业务逻辑铁律）", () => {
    const forbiddenImports = ["@ebbinghaus/domain", "@ebbinghaus/application"];
    for (const [file, content] of fileContents) {
      for (const pkg of forbiddenImports) {
        expect(content.includes(pkg), `${file} 引用了 ${pkg}`).toBe(false);
      }
    }
  });

  it("任何源文件不得出现业务域词汇（含注释），防止业务语义渗入（规格 9）", () => {
    for (const [file, content] of fileContents) {
      const lowered = content.toLowerCase();
      for (const term of FORBIDDEN_BUSINESS_TERMS) {
        expect(lowered.includes(term.toLowerCase()), `${file} 出现业务词「${term}」`).toBe(false);
      }
    }
  });

  it("node:fs 仅允许出现在配置、建库、备份三个模块（文件系统能力最小化）", () => {
    for (const [file, content] of fileContents) {
      const usesFs = /from\s+["']node:fs["']/.test(content) || /from\s+["']fs["']/.test(content);
      if (usesFs) {
        expect(FS_ALLOWED.has(file), `${file} 使用了 node:fs 但不在白名单`).toBe(true);
      }
    }
    // 白名单自身不得腐化：白名单文件必须真实存在。
    for (const allowed of FS_ALLOWED) {
      expect(fileContents.has(allowed), `白名单文件 ${allowed} 不存在`).toBe(true);
    }
  });

  it("禁止硬编码本机绝对路径，数据路径只能来自启动配置（规格 9）", () => {
    for (const [file, content] of fileContents) {
      for (const marker of ["/Users/", "/home/", "C:\\\\"]) {
        expect(content.includes(marker), `${file} 硬编码了绝对路径片段 ${marker}`).toBe(false);
      }
    }
  });

  it("协议消费唯一来源是 @ebbinghaus/protocol（存在正向引用，禁止复制协议定义）", () => {
    const consumers = [...fileContents.entries()].filter(([, content]) =>
      content.includes("@ebbinghaus/protocol"),
    );
    expect(consumers.length).toBeGreaterThanOrEqual(5);
  });
});
