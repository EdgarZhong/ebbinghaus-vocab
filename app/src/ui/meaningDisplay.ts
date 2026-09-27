/**
 * 手录义项的界面展示文本。持久化的 manualMeaning 只含词性与释义，属于历史
 * 数据校验口径；用法与释义在同一 StructuredMeaning 中，展示时再组合，避免
 * 修改旧数据摘要或让某个页面遗漏用法。旧内容没有结构化义项时回退原摘要。
 */
import type { StructuredMeaning } from "@ebbinghaus/domain";

export function formatManualMeaning(
  manualMeaning: string,
  meanings: readonly StructuredMeaning[] | undefined,
  separator = "\n",
): string {
  if (meanings === undefined || meanings.length === 0) return manualMeaning;
  return meanings.map((meaning) => {
    const definition = meaning.partOfSpeech === null
      ? meaning.definition
      : `${meaning.partOfSpeech} ${meaning.definition}`;
    return meaning.usage === null || meaning.usage.trim() === ""
      ? definition
      : `${definition} · 用法：${meaning.usage}`;
  }).join(separator);
}
