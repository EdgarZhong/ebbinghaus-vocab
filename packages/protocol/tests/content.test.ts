import { describe, expect, it } from "vitest";
import {
  contentEntrySchema, contentPullResponseSchema, isContentEntryNewer,
  type ContentEntry,
} from "../src/content.ts";

const DEVICE_A = "11111111-2222-4333-8444-555555555555";
const DEVICE_B = "99999999-8888-4777-8666-777777777777";

function space(overrides: Record<string, unknown> = {}): ContentEntry {
  const valid = contentEntrySchema.parse({
    entityType: "space", entityId: "space-1", deleted: false,
    value: {
      id: "space-1", kind: null, displayOrder: 1, name: "积累",
      archivedAt: null, createdAt: "2026-09-26T00:00:00Z",
      updatedAt: "2026-09-26T00:00:00Z", learningMode: "常规模式",
    },
    updatedAt: "2026-09-26T00:00:00Z", deviceId: DEVICE_A,
  });
  return { ...valid, ...overrides } as ContentEntry;
}

describe("内容目录协议", () => {
  it("校验实体身份、删除墓碑和 Word 手录义项", () => {
    expect(contentEntrySchema.safeParse(space({ entityId: "other" })).success).toBe(false);
    expect(contentEntrySchema.safeParse(space({ deleted: true })).success).toBe(false);
    expect(contentEntrySchema.safeParse(space({ deleted: true, value: null })).success).toBe(true);
    expect(contentEntrySchema.safeParse({
      entityType: "word", entityId: "word-1", deleted: false,
      value: {
        wordId: "word-1", listId: "list-1", spaceId: null,
        originalSpelling: "go", normalizedKey: "go", manualMeaning: "走",
        meanings: [{ partOfSpeech: "v.", definition: "走", usage: null }],
        removed: false, recordedAt: "2026-09-26T00:00:00Z",
      },
      updatedAt: "2026-09-26T00:00:00Z", deviceId: DEVICE_A,
    }).success).toBe(true);
  });

  it("新时间胜出；同时间设备标识决胜；同设备同时间墓碑胜出", () => {
    const original = space();
    expect(isContentEntryNewer(space({ updatedAt: "2026-09-26T01:00:00Z" }), original)).toBe(true);
    expect(isContentEntryNewer(space({ deviceId: DEVICE_B }), original)).toBe(true);
    expect(isContentEntryNewer(space({ deleted: true, value: null }), original)).toBe(true);
    expect(isContentEntryNewer(original, space({ deleted: true, value: null }))).toBe(false);
  });

  it("拉取响应携带独立内容游标并严格校验服务端版本", () => {
    const entry = space();
    expect(contentPullResponseSchema.parse({
      contents: [{ ...entry, serverSeq: 1 }], nextCursor: 1, hasMore: false,
    }).contents).toHaveLength(1);
    expect(contentPullResponseSchema.safeParse({
      contents: [{ ...entry, serverSeq: 0 }], nextCursor: 0, hasMore: false,
    }).success).toBe(false);
  });
});
