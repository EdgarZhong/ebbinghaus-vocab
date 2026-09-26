/** 网络替身只返回协议形态，验证 V1 证据树复验、局部修复及取消竞态。 */
import { describe, expect, it } from "vitest";
import { LanguageModelCancelledError, LanguageModelOrganizationError } from "@ebbinghaus/application";
import {
  OpenAiCompatibleOrganizer, type CompletionRequest, type CompletionTransport,
} from "../src/adapters/openAiCompatibleOrganizer.ts";

const raw = "mentor 名词 导师, pupil 名词 学生";
const mentor = {
  term: { value: "mentor", source_excerpt: "mentor" },
  meanings: [{
    part_of_speech: { value: "n.", source_excerpt: "名词" },
    definition: { value: "导师", source_excerpt: "导师" }, usage: null,
  }],
};
const pupil = {
  term: { value: "pupil", source_excerpt: "pupil" },
  meanings: [{
    part_of_speech: { value: "n.", source_excerpt: "名词" },
    definition: { value: "学生", source_excerpt: "学生" }, usage: null,
  }],
};
function result(entries: unknown[]): string {
  return JSON.stringify({ choices: [{ finish_reason: "stop", message: {
    content: JSON.stringify({ schema_version: "entry-organizer-v3", global_warning: null, entries }),
  } }] });
}
function completion(content: unknown): string {
  return JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }] });
}
const config = { baseUrl: "https://api.example.com/v1", modelName: "test-model", apiKey: "test-only-key", thinkingEnabled: true };

describe("V1 智能整理异步适配器", () => {
  it("成功结果必须经过本地 v3 证据复验，模型请求不含 Space 或 Unit", async () => {
    const requests: CompletionRequest[] = [];
    const transport: CompletionTransport = { async post(request) { requests.push(request); return result([mentor]); } };
    const organizer = new OpenAiCompatibleOrganizer(config, transport);

    const organized = await organizer.organize(raw);

    expect(organized.candidates[0]?.title).toBe("mentor");
    expect(organizer.lastInteractionCount).toBe(1);
    expect(requests[0]?.endpoint).toBe("https://api.example.com/v1/chat/completions");
    const body = JSON.parse(requests[0]?.body ?? "{}");
    expect(body.messages[1]).toEqual({ role: "user", content: raw });
    expect(body).not.toHaveProperty("spaceId");
    expect(body).not.toHaveProperty("unitNumber");
    expect(body.reasoning_effort).toBe("high");
  });

  it("只修复证据错误的词条，已通过词条不能被第二轮响应改写", async () => {
    const badPupil = { ...pupil, term: { value: "pupil", source_excerpt: "原文没有的词" } };
    const requests: CompletionRequest[] = [];
    const transport: CompletionTransport = {
      async post(request) {
        requests.push(request);
        return requests.length === 1
          ? result([mentor, badPupil])
          : completion({ schema_version: "entry-organizer-v3", repaired_entries: [{ entry_index: 1, entry: pupil }] });
      },
    };
    const organizer = new OpenAiCompatibleOrganizer(config, transport);

    const organized = await organizer.organize(raw);

    expect(organized.candidates.map((candidate) => candidate.title)).toEqual(["mentor", "pupil"]);
    expect(organizer.lastInteractionCount).toBe(2);
    expect(JSON.parse(requests[1]?.body ?? "{}").messages.at(-1).content).toContain("词条编号 1");
  });

  it("取消立即拒绝旧请求；新请求可独立完成", async () => {
    let call = 0;
    const transport: CompletionTransport = {
      post(request) {
        call += 1;
        if (call > 1) return Promise.resolve(result([mentor]));
        return new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(new LanguageModelCancelledError("已取消")), { once: true });
        });
      },
    };
    const organizer = new OpenAiCompatibleOrganizer(config, transport);
    const old = organizer.organize(raw);
    organizer.cancel();
    await expect(old).rejects.toBeInstanceOf(LanguageModelCancelledError);
    await expect(organizer.organize(raw)).resolves.toMatchObject({ candidates: expect.any(Array) });
  });

  it("DeepSeek 官方地址使用当前官方 thinking 字段", async () => {
    let requestBody: Record<string, unknown> = {};
    const transport: CompletionTransport = {
      async post(request) { requestBody = JSON.parse(request.body); return result([mentor]); },
    };
    await new OpenAiCompatibleOrganizer({ ...config, baseUrl: "https://api.deepseek.com", thinkingEnabled: false }, transport).organize(raw);
    expect(requestBody["thinking"]).toEqual({ type: "disabled" });
    expect(requestBody).not.toHaveProperty("reasoning_effort");
  });

  it("三轮校验仍失败时不返回未验证候选", async () => {
    const bad = { ...mentor, term: { value: "mentor", source_excerpt: "原文没有的词" } };
    const transport: CompletionTransport = { async post() { return result([bad]); } };
    const organizer = new OpenAiCompatibleOrganizer(config, transport);
    await expect(organizer.organize(raw)).rejects.toBeInstanceOf(LanguageModelOrganizationError);
    expect(organizer.lastInteractionCount).toBe(3);
  });
});
