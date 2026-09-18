/**
 * 架构守卫测试：静态扫描 packages/domain/src 全部源码，固化领域层依赖边界。
 *
 * 断言四类红线（架构铁律）：
 * 1. 禁止 import react/vue 等 UI 框架、@tauri-apps/* 平台壳、Node 专属模块（node: 内建
 *    与 fs/path/http/os…）、网络客户端库——领域层必须是纯计算；
 * 2. 禁止 Math.random——蒙特卡洛必须使用固定种子的确定性伪随机源；
 * 3. 禁止 Date.now 与无参 new Date()——一切"现在"经可注入 Clock 提供，禁止读取
 *    系统当前时间（带参 new Date(显式输入) 是纯函数，允许）；
 * 4. 允许的运行时依赖仅限 @ebbinghaus/protocol 与 ts-fsrs（纯算法库）。
 *
 * 测试文件本身位于 tests/，允许使用 node:fs 读取源码；扫描范围仅限 src/。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = join(import.meta.dirname, "../src");

function collectSourceFiles(directory: string): string[] {
  const collected: string[] = [];
  for (const name of readdirSync(directory)) {
    const full = join(directory, name);
    if (statSync(full).isDirectory()) {
      collected.push(...collectSourceFiles(full));
    } else if (name.endsWith(".ts")) {
      collected.push(full);
    }
  }
  return collected;
}

/** 去除块注释与行注释后再扫描，避免文档性提及（如 clock.ts 说明文字）误报。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** 提取全部 import/export ... from 的模块说明符（含动态 import）。 */
function importedModules(source: string): string[] {
  const modules: string[] = [];
  const staticPattern = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(staticPattern)) {
    modules.push(match[1] ?? "");
  }
  const dynamicPattern = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(dynamicPattern)) {
    modules.push(match[1] ?? "");
  }
  return modules;
}

const FORBIDDEN_MODULE_PATTERNS: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /^(react|react-dom|vue|svelte|solid-js)$/, reason: "UI 框架" },
  { pattern: /^@tauri-apps\//, reason: "Tauri 平台壳" },
  { pattern: /^node:/, reason: "Node 内建模块" },
  {
    pattern: /^(fs|path|http|https|os|crypto|child_process|net|dns|stream|url|util|worker_threads|cluster|perf_hooks)$/,
    reason: "Node 专属模块（裸名导入）",
  },
  { pattern: /^(axios|got|undici|node-fetch|ky|ws|cross-fetch)$/, reason: "网络客户端" },
];

const ALLOWED_RUNTIME_MODULES = new Set([
  "@ebbinghaus/protocol",
  "ts-fsrs",
]);

describe("领域层架构守卫", () => {
  const sourceFiles = collectSourceFiles(SRC_ROOT);

  it("源码文件确实被扫描到（防守卫自身失效）", () => {
    expect(sourceFiles.length).toBeGreaterThanOrEqual(10);
  });

  it("禁止依赖 UI 框架、平台壳、Node 专属模块与网络客户端", () => {
    for (const file of sourceFiles) {
      const source = readFileSync(file, "utf8");
      for (const moduleSpecifier of importedModules(source)) {
        if (moduleSpecifier.startsWith(".")) {
          // 相对导入属于包内模块，检查其是否越界由 TypeScript 编译器保证。
          continue;
        }
        for (const forbidden of FORBIDDEN_MODULE_PATTERNS) {
          if (forbidden.pattern.test(moduleSpecifier)) {
            throw new Error(
              `${file} 引入了被禁止的${forbidden.reason}：${moduleSpecifier}`,
            );
          }
        }
        const bareName = moduleSpecifier.startsWith("@")
          ? moduleSpecifier.split("/").slice(0, 2).join("/")
          : (moduleSpecifier.split("/")[0] ?? "");
        if (!ALLOWED_RUNTIME_MODULES.has(bareName)) {
          throw new Error(`${file} 引入了白名单之外的运行时依赖：${moduleSpecifier}`);
        }
      }
    }
  });

  it("禁止读取系统当前时间：不得出现 Date.now 或无参 new Date()", () => {
    const forbiddenTimePatterns: readonly { pattern: RegExp; label: string }[] = [
      { pattern: /\bDate\s*\.\s*now\s*\(/, label: "Date.now()" },
      { pattern: /\bnew\s+Date\s*\(\s*\)/, label: "无参 new Date()" },
    ];
    for (const file of sourceFiles) {
      const source = stripComments(readFileSync(file, "utf8"));
      for (const { pattern, label } of forbiddenTimePatterns) {
        if (pattern.test(source)) {
          throw new Error(`${file} 出现了禁止的系统时间读取 ${label}（一切时间必须经可注入 Clock 或显式输入）`);
        }
      }
    }
  });

  it("禁止 Math.random：随机性必须来自固定种子的确定性伪随机源", () => {
    const pattern = /\bMath\s*\.\s*random\s*\(/;
    for (const file of sourceFiles) {
      const source = stripComments(readFileSync(file, "utf8"));
      if (pattern.test(source)) {
        throw new Error(`${file} 出现了禁止的 Math.random()（蒙特卡洛必须使用固定种子伪随机源）`);
      }
    }
  });

  it("算法版本常量随导出可用，保证重放与预测结果可持久化审计", async () => {
    const domain = await import("../src/index.ts");
    expect(domain.SCHEDULER_ALGORITHM_VERSION).toBe("scheduler-v1");
    expect(domain.CAPACITY_ALGORITHM_VERSION).toBe("capacity-monte-carlo-v2");
    expect(domain.REPLAYER_ALGORITHM_VERSION).toBe("replayer-v1");
    expect(domain.FSRS_ALGORITHM_VERSION).toContain("regular-v1");
  });
});
