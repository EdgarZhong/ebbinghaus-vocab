/**
 * 结构化手录义项、正式词性简称与语音别名规范化（移植 V1 domain/meanings.py）。
 *
 * 词性是用户手录义项可选携带的语法类别：携带时保存需求规格定义的唯一规范简称；
 * 语音中的全称、口语或非标准简称必须先规范化。用户未表达词性时义项留空保存，
 * 不强制补选——本地规则绝不猜测用户没有表达的词性。
 */

/** 需求规格定义的唯一正式词性值；"待补充"只用于无损迁移旧数据。 */
export const PartOfSpeech = {
  Unclassified: "待补充",
  Noun: "n.",
  Verb: "v.",
  TransitiveVerb: "vt.",
  IntransitiveVerb: "vi.",
  Adjective: "a.",
  Adverb: "ad.",
  Preposition: "prep.",
  Pronoun: "pron.",
  Conjunction: "conj.",
  Numeral: "num.",
  Article: "art.",
  Auxiliary: "aux.",
  Modal: "modal.",
  Interjection: "interj.",
  Determiner: "det.",
} as const;
export type PartOfSpeech = (typeof PartOfSpeech)[keyof typeof PartOfSpeech];

/** 全部正式词性（不含"待补充"），用于表单候选与校验。 */
export const FORMAL_PARTS_OF_SPEECH: readonly PartOfSpeech[] = Object.values(
  PartOfSpeech,
).filter((value) => value !== PartOfSpeech.Unclassified);

/**
 * 较长别名必须先匹配（中文别名按最长优先），避免"及物动词"被较短的"动词"截断。
 * 英文别名统一去掉句点并折叠空白后查表（键已按此口径归一），兼容语音输入法输出
 * 全称、常见教材缩写或不带句点的简称。
 *
 * 键序与 V1 逐一对应：splitPartOfSpeechPrefix 依赖"同长度中文别名按表序优先"的
 * 稳定顺序，因此保持对象字面量书写顺序（JS 保证字符串键按插入序遍历）。
 */
const PART_OF_SPEECH_ALIASES: Readonly<Record<string, PartOfSpeech>> = {
  名词: PartOfSpeech.Noun,
  noun: PartOfSpeech.Noun,
  n: PartOfSpeech.Noun,
  及物动词: PartOfSpeech.TransitiveVerb,
  transitiveverb: PartOfSpeech.TransitiveVerb,
  vt: PartOfSpeech.TransitiveVerb,
  不及物动词: PartOfSpeech.IntransitiveVerb,
  intransitiveverb: PartOfSpeech.IntransitiveVerb,
  vi: PartOfSpeech.IntransitiveVerb,
  动词: PartOfSpeech.Verb,
  verb: PartOfSpeech.Verb,
  v: PartOfSpeech.Verb,
  形容词: PartOfSpeech.Adjective,
  adjective: PartOfSpeech.Adjective,
  adj: PartOfSpeech.Adjective,
  a: PartOfSpeech.Adjective,
  副词: PartOfSpeech.Adverb,
  adverb: PartOfSpeech.Adverb,
  adv: PartOfSpeech.Adverb,
  ad: PartOfSpeech.Adverb,
  介词: PartOfSpeech.Preposition,
  preposition: PartOfSpeech.Preposition,
  prep: PartOfSpeech.Preposition,
  代词: PartOfSpeech.Pronoun,
  pronoun: PartOfSpeech.Pronoun,
  pron: PartOfSpeech.Pronoun,
  连词: PartOfSpeech.Conjunction,
  conjunction: PartOfSpeech.Conjunction,
  conj: PartOfSpeech.Conjunction,
  数词: PartOfSpeech.Numeral,
  numeral: PartOfSpeech.Numeral,
  num: PartOfSpeech.Numeral,
  冠词: PartOfSpeech.Article,
  article: PartOfSpeech.Article,
  art: PartOfSpeech.Article,
  助动词: PartOfSpeech.Auxiliary,
  auxiliaryverb: PartOfSpeech.Auxiliary,
  auxiliary: PartOfSpeech.Auxiliary,
  aux: PartOfSpeech.Auxiliary,
  情态动词: PartOfSpeech.Modal,
  modalverb: PartOfSpeech.Modal,
  modal: PartOfSpeech.Modal,
  感叹词: PartOfSpeech.Interjection,
  interjection: PartOfSpeech.Interjection,
  interj: PartOfSpeech.Interjection,
  限定词: PartOfSpeech.Determiner,
  determiner: PartOfSpeech.Determiner,
  det: PartOfSpeech.Determiner,
};

/** 统一条目中的义项；词性与用法可选，释义始终是最小可学习内容。 */
export interface StructuredMeaning {
  /** 正式词性简称；null 表示用户未表达词性（允许留空保存）。 */
  readonly partOfSpeech: PartOfSpeech | null;
  readonly definition: string;
  readonly usage: string | null;
}

/** 义项等值比较键：用于解析结果去重（对应 Python dataclass 的值相等语义）。 */
function meaningKey(meaning: StructuredMeaning): string {
  return `${meaning.partOfSpeech ?? "\u0000"}\u0000${meaning.definition}\u0000${meaning.usage ?? "\u0000"}`;
}

/** 按值去重并保持首次出现顺序（对应 Python `dict.fromkeys` 的有序去重语义）。 */
export function dedupeMeanings(meanings: readonly StructuredMeaning[]): StructuredMeaning[] {
  const seen = new Set<string>();
  const result: StructuredMeaning[] = [];
  for (const meaning of meanings) {
    const key = meaningKey(meaning);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(meaning);
    }
  }
  return result;
}

/** 构造结构化义项并执行与 V1 一致的约束（释义非空且不超过 50 字符）。 */
export function createStructuredMeaning(
  partOfSpeech: PartOfSpeech | null,
  definition: string,
  usage?: string | null,
): StructuredMeaning {
  if (!definition.trim()) {
    throw new Error("结构化手录义项的中文释义不能为空");
  }
  if (definition.length > 50) {
    throw new Error("结构化手录义项的中文释义不得超过 50 个字符");
  }
  // 空白用法统一归一为 null，避免"空字符串用法"与"没有用法"两种表示并存。
  const normalizedUsage = usage !== null && usage !== undefined && usage.trim() ? usage : null;
  return { partOfSpeech, definition, usage: normalizedUsage };
}

/**
 * 把正式简称、英文全称、中文全称和常见非标准简称归一为正式词性。
 *
 * 归一口径：去掉全部空白与中英句点后查别名表。无法识别的取值（包括"名次"这类
 * 错字）返回 null——它不进入别名表，是否表示名词由模型结合上下文判断并以订正
 * 加 warning 表达，本地绝不猜测。
 */
export function normalizePartOfSpeech(value: string): PartOfSpeech | null {
  // 与 Python casefold 的差异仅影响极少数德语等特殊字符，本表键均为 ASCII 或中文，
  // toLowerCase 足以覆盖"全文小写"的归一目标。
  const normalized = value.replace(/[\s.。]/g, "").toLowerCase();
  return PART_OF_SPEECH_ALIASES[normalized] ?? null;
}

/** 判断别名是否是中文（中文词性全称可以和中文释义直接相连，需要最长名称优先匹配）。 */
function isChineseAlias(alias: string): boolean {
  return /[\u3400-\u9fff]/.test(alias);
}

// 中文别名按长度降序预排序；同长度保持别名表书写顺序（与 V1 sorted 稳定排序一致）。
const CHINESE_ALIASES_BY_LENGTH_DESC: readonly string[] = Object.keys(PART_OF_SPEECH_ALIASES)
  .filter(isChineseAlias)
  .sort((a, b) => b.length - a.length);

/** 去掉义项开头词性边界后的分隔符与空白。 */
function stripMeaningLeadingSeparators(text: string): string {
  return text.replace(/^[ ,，.。:：]+/, "");
}

/**
 * 从单条义项开头提取最长词性别名，返回规范词性与剩余中文释义。
 *
 * 中文别名直接前缀匹配；英文标记只读取开头的一至两个英文单词，避免把后续中文
 * 释义或普通英文内容吞入词性。无法识别时返回 null 词性与原文剩余部分。
 */
export function splitPartOfSpeechPrefix(text: string): [PartOfSpeech | null, string] {
  const stripped = text.trim();
  for (const alias of CHINESE_ALIASES_BY_LENGTH_DESC) {
    if (stripped.startsWith(alias)) {
      const remainder = stripMeaningLeadingSeparators(stripped.slice(alias.length));
      if (remainder) {
        const formal = PART_OF_SPEECH_ALIASES[alias];
        if (formal === undefined) {
          throw new Error("词性别名表内部错误：中文别名缺少映射值");
        }
        return [formal, remainder];
      }
    }
  }

  const englishPrefix = /^([A-Za-z]+(?:\s+[A-Za-z]+)?\.?)/.exec(stripped);
  if (englishPrefix !== null) {
    const matched = englishPrefix[1];
    if (matched === undefined) {
      throw new Error("词性前缀匹配内部错误：分组缺失");
    }
    const partOfSpeech = normalizePartOfSpeech(matched);
    const remainder = stripMeaningLeadingSeparators(stripped.slice(matched.length));
    if (partOfSpeech !== null && remainder) {
      return [partOfSpeech, remainder];
    }
  }
  return [null, stripped];
}

/** 生成兼容展示与内容版本使用的稳定文本，每个正式义项都重复词性。 */
export function formatStructuredMeanings(meanings: readonly StructuredMeaning[]): string {
  const parts: string[] = [];
  for (const meaning of meanings) {
    if (meaning.partOfSpeech === null || meaning.partOfSpeech === PartOfSpeech.Unclassified) {
      parts.push(meaning.definition);
    } else {
      parts.push(`${meaning.partOfSpeech} ${meaning.definition}`);
    }
  }
  return parts.join("；");
}
