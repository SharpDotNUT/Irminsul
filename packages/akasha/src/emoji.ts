/**
 * DimbreathBot/AnimeGameData 的 GI 表情数据（两份 `ExcelBinOutput` + `TextMap`）。
 *
 * 归一化做三件事：
 * 1. 合并两份 Config Data：`EmojiSetDataExcelConfigData` 的表情包内嵌各自的表情，文案字段保持 hash 引用。
 * 2. 容忍上游容器/字段名漂移：容器接受裸数组 / `{"data": […]}` 包装 / 按 id 索引的对象，TextMap 接受
 *    `{"<hash>": "文案"}` 与 `[{hash, text}]`，字段名大小写与下划线不敏感（`setID` = `SetID` = `set_id`）。
 * 3. 合并同一语言的多份 TextMap 分片：RU 拆成 `RU_0`/`RU_1`，TH 拆成 `TH_0`/`TH_1`，分片按 hash 互补切分
 *    （实测重叠为 0），只取一份会丢掉约一半 hash。
 */

export const DATA_REPO = "https://github.com/DimbreathBot/AnimeGameData";
export const DATA_ROOT = "https://raw.githubusercontent.com/DimbreathBot/AnimeGameData/main";

export const EMOJI_FILE = "ExcelBinOutput/EmojiDataExcelConfigData.json";
export const EMOJI_SET_FILE = "ExcelBinOutput/EmojiSetDataExcelConfigData.json";

/** 语言代码 → `TextMap_Medium<suffix>.json` 的分片后缀（多分片即需合并）。 */
export const TEXT_MAP_LANGS: Record<string, string[]> = {
  CHS: ["CHS"],
  CHT: ["CHT"],
  DE: ["DE"],
  EN: ["EN"],
  ES: ["ES"],
  FR: ["FR"],
  ID: ["ID"],
  IT: ["IT"],
  JP: ["JP"],
  KR: ["KR"],
  PT: ["PT"],
  RU: ["RU_0", "RU_1"],
  TH: ["TH_0", "TH_1"],
  TR: ["TR"],
  VI: ["VI"],
};

export function textMapFile(suffix: string): string {
  return `TextMap/TextMap_Medium${suffix}.json`;
}

export function dataUrl(file: string): string {
  return `${DATA_ROOT}/${file}`;
}

/** `--lang` 解析：空 = 全部语言；结果按 `TEXT_MAP_LANGS` 顺序去重。 */
export function resolveLangs(requested: string[]): string[] {
  const names = Object.keys(TEXT_MAP_LANGS);
  const wanted = new Set(requested);
  for (const name of wanted) {
    if (!(name in TEXT_MAP_LANGS)) {
      throw new Error(`--lang 只能是 ${names.join(" | ")}（上游分片后缀 _0/_1 会自动合并），收到: ${name}`);
    }
  }
  return wanted.size === 0 ? names : names.filter((name) => wanted.has(name));
}

/** 文案字段：仍按 hash 引用，具体文案查 `emoji.texts.json`。上游删掉该字段时为 null。 */
export type Emoji = {
  id: number;
  order: number;
  /** Texture2D 名，对应 `rules.json` 的 `emotion-icon` 规则组。 */
  icon: string;
  contentTextMapHash: number | null;
};

export type EmojiSet = {
  id: number;
  order: number;
  /** Texture2D 名，对应 `rules.json` 的 `emotion-tag-icon` 规则组。 */
  icon: string;
  nameTextMapHash: number | null;
  emojis: Emoji[];
};

export type EmojiData = {
  langs: string[];
  source: {
    repo: string;
    emoji: string;
    set: string;
    /** 语言 → TextMap 分片 URL（RU/TH 各两片）。 */
    textMaps: Record<string, string[]>;
  };
  sets: EmojiSet[];
};

export type MergedConfig = {
  data: EmojiData;
  /** 配置引用到的全部 hash（`nameTextMapHash` + `contentTextMapHash`），即文案表要覆盖的键。 */
  hashes: Set<string>;
  /** 表情引用了不存在的 setID（这些表情不会写进输出）。 */
  orphanSetIDs: number[];
};

/** hash → 文案，单一语言（与上游 TextMap 同形）。 */
export type LangTexts = Record<string, string>;

export type MergedTexts = {
  /** 语言 → `{"<hash>": "文案"}`，每种语言一份。 */
  byLang: Record<string, LangTexts>;
  /** hash × 语言 里查不到文案的数量。 */
  missing: number;
  /** 至少缺一种语言的 hash（升序）。 */
  incomplete: string[];
};

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 字段名大小写与下划线不敏感（`setID` = `SetID` = `set_id`）。 */
function fieldsOf(row: Row): Map<string, unknown> {
  const fields = new Map<string, unknown>();
  for (const [key, value] of Object.entries(row)) {
    const name = key.toLowerCase().replaceAll("_", "");
    if (!fields.has(name)) fields.set(name, value);
  }
  return fields;
}

function pick(fields: Map<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    const value = fields.get(name.toLowerCase().replaceAll("_", ""));
    if (value !== undefined) return value;
  }
  return undefined;
}

function numberField(fields: Map<string, unknown>, names: string[], context: string): number {
  const value = pick(fields, names);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${context}的 ${names[0]} 不是数字: ${JSON.stringify(value)}`);
  }
  return value;
}

function stringField(fields: Map<string, unknown>, names: string[], context: string): string {
  const value = pick(fields, names);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${context}的 ${names[0]} 不是非空字符串: ${JSON.stringify(value)}`);
  }
  return value;
}

/** hash 允许缺失（上游偶尔删掉该字段），缺失即 null。 */
function hashField(fields: Map<string, unknown>, names: string[], context: string): number | null {
  const value = pick(fields, names);
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${context}的 ${names[0]} 不是数字: ${JSON.stringify(value)}`);
  }
  return value;
}

function assertRows(value: unknown[], what: string): Row[] {
  const rows: Row[] = [];
  for (const row of value) {
    if (!isRow(row)) throw new Error(`${what} 中出现非对象记录（${typeof row}）`);
    rows.push(row);
  }
  return rows;
}

/** 接受 `[{…}]`、`{"data": [{…}]}` 与 `{"<id>": {…}}` 三种容器形态。 */
function rowsOf(value: unknown, what: string): Row[] {
  if (Array.isArray(value)) return assertRows(value, what);
  if (isRow(value)) {
    const arrays = Object.values(value).filter(Array.isArray);
    if (arrays.length === 1) return assertRows(arrays[0]!, what);
    const rows = Object.values(value);
    if (rows.length > 0 && rows.every(isRow)) return rows;
  }
  throw new Error(`${what} 结构无法识别（期望 [{…}]、{"data": [{…}]} 或 {"<id>": {…}}）`);
}

function isTextMapEntry(entry: [string, unknown]): entry is [string, string] {
  return typeof entry[1] === "string";
}

function textPairs(rows: unknown[], wanted: Set<string>, what: string): Map<string, string> {
  const texts = new Map<string, string>();
  for (const row of rows) {
    if (!isRow(row)) throw new Error(`${what} 中出现非对象记录（${typeof row}）`);
    const fields = fieldsOf(row);
    const hash = pick(fields, ["hash", "textMapHash", "key"]);
    const text = pick(fields, ["text", "value"]);
    if ((typeof hash !== "number" && typeof hash !== "string") || typeof text !== "string") {
      throw new Error(`${what} 的记录缺少 hash/text 字段: ${JSON.stringify(row)}`);
    }
    if (wanted.has(String(hash))) texts.set(String(hash), text);
  }
  return texts;
}

/** 接受 `{"<hash>": "文案"}`、`[{"hash": …, "text": …}]` 与其 `{"data": […]}` 包装；只保留 `wanted`。 */
function textMapOf(value: unknown, wanted: Set<string>): Map<string, string> {
  const what = "TextMap";
  if (Array.isArray(value)) return textPairs(value, wanted, what);
  if (isRow(value)) {
    const entries = Object.entries(value);
    const pairs = entries.filter(isTextMapEntry);
    if (pairs.length === entries.length) {
      const texts = new Map<string, string>();
      for (const [hash, text] of pairs) if (wanted.has(hash)) texts.set(hash, text);
      return texts;
    }
    const arrays = entries.map(([, item]) => item).filter(Array.isArray);
    if (arrays.length === 1) return textMapOf(arrays[0]!, wanted);
  }
  throw new Error(`${what} 结构无法识别（期望 {"<hash>": "文案"} 或 [{"hash": …, "text": …}]）`);
}

/**
 * 合并同一语言的 TextMap 分片，只保留 `wanted` 里的 hash。
 * 逐片过滤后立刻丢弃原始 JSON，全语言（约 350MB）才不会同时驻留内存。
 */
export function mergeTextMaps(parts: unknown[], wanted: Set<string>): Map<string, string> {
  const merged = new Map<string, string>();
  for (const part of parts) {
    for (const [hash, text] of textMapOf(part, wanted)) {
      if (!merged.has(hash)) merged.set(hash, text);
    }
  }
  return merged;
}

/** 把两份 Config Data 合并成一份：按 `order` 排序的表情包，每个包内嵌排序后的表情，文案仍是 hash。 */
export function mergeConfigData(langs: string[], emoji: unknown, set: unknown): MergedConfig {
  const hashes = new Set<string>();
  const orphanSetIDs: number[] = [];

  const sets = rowsOf(set, EMOJI_SET_FILE).map((row, index): EmojiSet => {
    const fields = fieldsOf(row);
    const context = `${EMOJI_SET_FILE} 第 ${index + 1} 条`;
    const nameTextMapHash = hashField(fields, ["nameTextMapHash"], context);
    if (nameTextMapHash !== null) hashes.add(String(nameTextMapHash));
    return {
      id: numberField(fields, ["id"], context),
      order: numberField(fields, ["order"], context),
      icon: stringField(fields, ["icon"], context),
      nameTextMapHash,
      emojis: [],
    };
  });
  sets.sort((left, right) => left.order - right.order || left.id - right.id);

  const byId = new Map(sets.map((set) => [set.id, set]));
  for (const [index, row] of rowsOf(emoji, EMOJI_FILE).entries()) {
    const fields = fieldsOf(row);
    const context = `${EMOJI_FILE} 第 ${index + 1} 条`;
    const setID = numberField(fields, ["setID"], context);
    const owner = byId.get(setID);
    if (!owner) {
      if (!orphanSetIDs.includes(setID)) orphanSetIDs.push(setID);
      continue;
    }
    const contentTextMapHash = hashField(fields, ["contentTextMapHash"], context);
    if (contentTextMapHash !== null) hashes.add(String(contentTextMapHash));
    owner.emojis.push({
      id: numberField(fields, ["id"], context),
      order: numberField(fields, ["order"], context),
      icon: stringField(fields, ["icon"], context),
      contentTextMapHash,
    });
  }
  for (const set of sets) {
    set.emojis.sort((left, right) => left.order - right.order || left.id - right.id);
  }

  return {
    data: {
      langs,
      source: {
        repo: DATA_REPO,
        emoji: dataUrl(EMOJI_FILE),
        set: dataUrl(EMOJI_SET_FILE),
        textMaps: Object.fromEntries(
          langs.map((lang) => [lang, TEXT_MAP_LANGS[lang]!.map((suffix) => dataUrl(textMapFile(suffix)))]),
        ),
      },
      sets,
    },
    hashes,
    orphanSetIDs: orphanSetIDs.sort((left, right) => left - right),
  };
}

/**
 * 按语言切成独立文案表：`hashes` 里的 hash 全部覆盖，查不到的 hash 直接不出键。
 * `texts` 是各语言合并后的分片表（见 `mergeTextMaps`）。
 */
export function buildTexts(
  hashes: Set<string>,
  langs: string[],
  texts: Record<string, Map<string, string>>,
): MergedTexts {
  const sorted = [...hashes].sort((left, right) => Number(left) - Number(right));
  const byLang: Record<string, LangTexts> = {};
  const resolvedPerHash = new Map<string, number>();
  let resolved = 0;
  for (const lang of langs) {
    const source = texts[lang];
    const table: LangTexts = {};
    for (const hash of sorted) {
      const text = source.get(hash);
      if (text === undefined) continue;
      table[hash] = text;
      resolvedPerHash.set(hash, (resolvedPerHash.get(hash) ?? 0) + 1);
      resolved += 1;
    }
    byLang[lang] = table;
  }
  return {
    byLang,
    missing: sorted.length * langs.length - resolved,
    incomplete: sorted.filter((hash) => (resolvedPerHash.get(hash) ?? 0) < langs.length),
  };
}
