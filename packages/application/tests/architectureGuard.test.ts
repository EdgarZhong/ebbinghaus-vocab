/**
 * 应用层架构守卫测试：对 src/*.ts 做静态扫描，固化 index.ts 模块头声明的依赖边界。
 *
 * 守卫清单（与 index.ts 注释、AGENTS.md 分层规则逐条对应）：
 * - 禁止 import UI 框架（react 等）、@tauri-apps/*、Node 专属模块、数据库驱动、
 *   HTTP/网络客户端——一切外部能力经 ports.ts 的端口接口注入；
 * - 禁止 Math.random、Date.now、无参 new Date() 与直接调用 crypto——时间经 Clock、
 *   标识经 IdGenerator、设备序号经 DeviceSeqAllocator、摘要用确定性 FNV-1a。
 *
 * 测试自身使用 node:fs 读取源文件（守卫只约束 src/，不约束 tests/）。
 * 为防止守卫空转（规则全部匹配不到也算通过），本文件包含两组自检：
 * - 阳性对照：每条规则都必须命中对应的违规样例；
 * - 豁免机制：仅"带架构守卫豁免注释的 node: 类型导入"被放行，其余一律拦截。
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/** 一条扫描命中：文件内行号、规则名与原始行文本（报告给开发者定位用）。 */
interface Violation {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly text: string;
}

/** 禁止模式清单。规则模式只匹配代码形态（import 语句/调用形态），不匹配注释散文。 */
const FORBIDDEN_PATTERNS: readonly { readonly rule: string; readonly pattern: RegExp }[] = [
  { rule: "UI 框架（react 及其子包）", pattern: /from\s+["']react(?:\/[\w.-]+)?["']/ },
  { rule: "Tauri 平台 API（@tauri-apps/*）", pattern: /from\s+["']@tauri-apps\// },
  { rule: "Node 内置模块（node: 前缀）", pattern: /from\s+["']node:[A-Za-z]+["']/ },
  {
    rule: "Node 内置模块（裸模块名）",
    pattern:
      /from\s+["'](assert|async_hooks|buffer|child_process|cluster|constants|crypto|dgram|diagnostics_channel|dns|events|fs|fs\/promises|http|http2|https|inspector|module|net|os|path|perf_hooks|process|punycode|querystring|readline|repl|stream|string_decoder|sys|timers|tls|tty|url|util|v8|vm|worker_threads|zlib)["']/,
  },
  {
    rule: "数据库驱动",
    pattern: /from\s+["'](better-sqlite3|sqlite3|pg|mysql2?|mongodb|redis|rethinkdb)["']/,
  },
  {
    rule: "HTTP/网络客户端",
    pattern: /from\s+["'](undici|axios|node-fetch|got|ky|cross-fetch|superagent)["']|\bfetch\s*\(/,
  },
  { rule: "Math.random（不确定性随机）", pattern: /\bMath\.random\s*\(/ },
  { rule: "Date.now（绕过可注入时钟）", pattern: /\bDate\.now\s*\(/ },
  { rule: "无参 new Date()（读取系统当前时间）", pattern: /\bnew\s+Date\(\s*\)/ },
  {
    rule: "直接调用 crypto（应用层禁止，摘要用确定性 FNV-1a）",
    pattern:
      /from\s+["'](?:node:)?crypto["']|\bcrypto\.(?:getRandomValues|randomUUID|randomBytes|subtle|createHash|createHmac)\b/,
  },
];

/**
 * 扫描一段源码文本，返回全部违规行。
 *
 * 注释行不参与扫描：文档注释里的规则描述（如"禁止无参 new Date()"）不是代码调用。
 * 豁免规则：`import type ... from "node:..."` 且行内带"架构守卫豁免"注释时放行——
 * 仅当未来确需引用 Node 类型（如类型层面的路径描述）时使用，值级导入永不放行。
 */
function scanContent(content: string, file = "(sample)"): Violation[] {
  const violations: Violation[] = [];
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const trimmed = line.trim();
    // 跳过注释行：行注释、块注释开闭与其延续行（JSDoc 的 "* ..." 形态）。
    if (
      trimmed.startsWith("//") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("*/")
    ) {
      continue;
    }
    for (const { rule, pattern } of FORBIDDEN_PATTERNS) {
      if (!pattern.test(line)) {
        continue;
      }
      const exempted = line.includes("架构守卫豁免") && /^\s*import\s+type\b/.test(line);
      if (!exempted) {
        violations.push({ file, line: index + 1, rule, text: trimmed });
      }
    }
  }
  return violations;
}

/** 列出应用层 src 下的全部 TypeScript 源文件（绝对路径）。 */
function listSourceFiles(): string[] {
  const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
  return readdirSync(srcDir)
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => join(srcDir, name));
}

describe("架构守卫：应用层依赖与纯度静态扫描", () => {
  it("src 全部源文件不含禁止的依赖与不确定性调用", () => {
    const files = listSourceFiles();
    // 下限哨兵：源文件数量骤降说明扫描目标失配（例如目录结构变动），先暴露再放行。
    expect(files.length).toBeGreaterThanOrEqual(12);

    const violations = files.flatMap((file) =>
      scanContent(readFileSync(file, "utf8"), file).map((violation) => ({
        ...violation,
        file: violation.file.replace(fileURLToPath(new URL("../../", import.meta.url)), ""),
      })),
    );

    expect(violations).toEqual([]);
  });

  it("阳性对照：每条规则都能命中对应的违规样例（防止守卫空转）", () => {
    const samples: readonly string[] = [
      `import { useState } from "react";`,
      `import { invoke } from "@tauri-apps/api/core";`,
      `import { readFileSync } from "node:fs";`,
      `import { join } from "path";`,
      `import Database from "better-sqlite3";`,
      `import { fetch } from "undici";\nconst r = fetch(url);`,
      `const x = Math.random();`,
      `const now = Date.now();`,
      `const d = new Date();`,
      `import { randomUUID } from "crypto";\nconst id = crypto.randomUUID();`,
    ];
    // 每条规则至少被一个样例命中；样例文本拼在一起时命中行数不少于规则数。
    const combined = scanContent(samples.join("\n"));
    expect(combined.length).toBeGreaterThanOrEqual(samples.length);
    const hitRules = new Set(combined.map((violation) => violation.rule));
    for (const { rule } of FORBIDDEN_PATTERNS) {
      expect(hitRules.has(rule)).toBe(true);
    }
  });

  it("正常代码形态不误报：带参数的 new Date 与注释中的术语不算违规", () => {
    const benign = [
      `const d = new Date(iso);`,
      `const e = new Date("2026-07-15T09:00:00Z");`,
      `// 注释：应用层禁止直接调用 crypto，摘要用 FNV-1a。`,
      `* - 禁止 Math.random、Date.now、无参 new Date() 与直接调用 crypto：时间经 Clock、`,
      `import { Clock } from "@ebbinghaus/domain";`,
      `import { mergeSettings } from "@ebbinghaus/protocol";`,
    ].join("\n");

    expect(scanContent(benign)).toEqual([]);
  });

  it("豁免机制：仅带豁免注释的 node: 类型导入放行，值级导入与普通导入不放行", () => {
    const exempted = `import type { PathLike } from "node:fs"; // 架构守卫豁免：仅引用 Node 类型`;
    const valueImport = `import { readFileSync } from "node:fs"; // 架构守卫豁免：不应放行`;
    const plainTypeImport = `import type { Stats } from "node:fs";`;

    expect(scanContent(exempted)).toEqual([]);
    expect(scanContent(valueImport)).toHaveLength(1);
    expect(scanContent(plainTypeImport)).toHaveLength(1);
  });
});
