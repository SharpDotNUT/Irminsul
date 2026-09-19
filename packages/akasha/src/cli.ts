#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { CLI_EXE } from "./anime-studio.ts";
import { buildMapCommand } from "./commands/build_map.ts";
import { emojiCommand } from "./commands/emoji.ts";
import { exportCommand } from "./commands/export.ts";
import { initCommand } from "./commands/init.ts";
import { uploadCommand } from "./commands/upload.ts";
import { WORK_DIR_ENV, WORK_DIR_NAME, resolveWorkDir, type Context } from "./context.ts";
import { TEXT_MAP_LANGS, resolveLangs } from "./emoji.ts";
import { GENSHIN_DIR_ENV } from "./genshin.ts";
import { setSilent } from "./log.ts";
import { rules } from "./rules.ts";

type Arity = "bool" | "value";
type FlagSpec = Record<string, Arity>;

const manifest: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (typeof manifest !== "object" || manifest === null || !("version" in manifest) || typeof manifest.version !== "string") {
  throw new Error("package.json 缺少 version 字段");
}
const PACKAGE_VERSION = manifest.version;

const EXPORT_TYPES: Record<string, true> = { Convert: true, Raw: true, Dump: true, JSON: true };
const GROUP_ASSETS: Record<string, true> = {
  ByType: true,
  ByContainer: true,
  BySource: true,
  None: true,
};

const COMMON_FLAGS: FlagSpec = {
  "work-dir": "value",
  game: "value",
  silent: "bool",
  help: "bool",
};

type CommandSpec = {
  summary: string;
  usage: string;
  flags: FlagSpec;
  run: (ctx: Context, flags: Map<string, string[]>) => Promise<void>;
};

function flagValues(flags: Map<string, string[]>, name: string): string[] {
  return (flags.get(name) ?? [])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function pickEnum(flags: Map<string, string[]>, name: string, allowed: Record<string, true>, fallback: string): string {
  const value = flags.get(name)?.at(-1) ?? fallback;
  if (!(value in allowed)) {
    throw new Error(`--${name} 只能是 ${Object.keys(allowed).join(" | ")}，收到: ${value}`);
  }
  return value;
}

const COMMANDS: Record<string, CommandSpec> = {
  init: {
    summary: "下载并解压 AnimeStudio CLI（net10 windows 构建）",
    usage: "akasha init [--url <zip>] [--force]",
    flags: { url: "value", force: "bool" },
    run: (ctx, flags) =>
      initCommand(ctx.workDir, { url: flags.get("url")?.at(-1), force: flags.has("force") }),
  },
  build_map: {
    summary: "扫描游戏 blocks 目录，构建 assets_map.map（MessagePack）",
    usage: "akasha build_map [--input <blocks>] [--types <Type[,Type]>] [--ai-file <json>]",
    flags: { input: "value", types: "value", "ai-file": "value" },
    run: (ctx, flags) => {
      const types = flagValues(flags, "types");
      return buildMapCommand(ctx, {
        input: flags.get("input")?.at(-1),
        aiFile: flags.get("ai-file")?.at(-1),
        types: types.length > 0 ? types : ["Texture2D"],
      });
    },
  },
  export: {
    summary: "从 assets_map.map 精确导出 Texture2D 为 PNG（默认 -> 工作目录的 export/）",
    usage:
      "akasha export [--out <dir>] [--map <map>] [--group <name>] [--pattern <regex>] [--all]\n" +
      "             [--types <Type[,Type]>] [--export-type Convert|Raw|Dump|JSON]\n" +
      "             [--group-assets ByType|ByContainer|BySource|None] [--input <blocks>]",
    flags: {
      input: "value",
      out: "value",
      map: "value",
      group: "value",
      pattern: "value",
      all: "bool",
      types: "value",
      "export-type": "value",
      "group-assets": "value",
    },
    run: (ctx, flags) => {
      const types = flagValues(flags, "types");
      return exportCommand(ctx, {
        input: flags.get("input")?.at(-1),
        out: flags.get("out")?.at(-1),
        map: flags.get("map")?.at(-1),
        groups: flagValues(flags, "group"),
        patterns: flagValues(flags, "pattern"),
        all: flags.has("all"),
        types: types.length > 0 ? types : ["Texture2D"],
        exportType: pickEnum(flags, "export-type", EXPORT_TYPES, "Convert"),
        groupAssets: pickEnum(flags, "group-assets", GROUP_ASSETS, "ByType"),
      });
    },
  },
  emoji: {
    summary: "下载并合并 Dimbreath 两份表情 Config Data，另出每语言一份的 hash 文案表",
    usage: "akasha emoji [--lang <语言[,语言]>] [--out <目录>] [--force]",
    flags: { lang: "value", out: "value", force: "bool" },
    run: (ctx, flags) =>
      emojiCommand(ctx, {
        langs: resolveLangs(flagValues(flags, "lang")),
        out: flags.get("out")?.at(-1),
        force: flags.has("force"),
      }),
  },
  upload: {
    summary: "上传 emoji 产物（formatted）与贴图（binary，默认取工作目录的 export/）到对象存储",
    usage: "akasha upload [--emoji <dir>] [--images <dir>] [--prefix <前缀>] [--force]",
    flags: { emoji: "value", images: "value", prefix: "value", force: "bool" },
    run: (ctx, flags) =>
      uploadCommand(ctx, {
        emojiDir: flags.get("emoji")?.at(-1),
        imagesDir: flags.get("images")?.at(-1),
        prefix: flags.get("prefix")?.at(-1) ?? "Static/GI",
        force: flags.has("force"),
      }),
  },
};

function printUsage(command?: string): void {
  const lines: string[] = [];
  if (command) {
    const spec = COMMANDS[command]!;
    lines.push(`${CLI_EXE} 封装 — ${spec.summary}`, "", "用法:", `  ${spec.usage}`, "");
    const known = { ...COMMON_FLAGS, ...spec.flags };
    lines.push("选项:");
    for (const name of Object.keys(known)) {
      lines.push(`  --${name}${known[name] === "value" ? " <值>" : ""}`);
    }
  } else {
    lines.push(
      "akasha <command> [options]",
      "",
      "命令:",
      ...Object.entries(COMMANDS).map(([name, spec]) => `  ${name.padEnd(10)} ${spec.summary}`),
      "",
      "环境变量:",
      `  ${GENSHIN_DIR_ENV}   原神游戏文件夹（含 YuanShen.exe / GenshinImpact_Data 的那一层）`,
      `  ${WORK_DIR_ENV}  工作目录，默认 项目根/${WORK_DIR_NAME}（已 gitignore）`,
      "                   CLI 本体、assets_map.map、names.txt 都在这里",
      `                   当前: ${resolveWorkDir()}`,
      "  R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME / R2_ENDPOINT",
      "                   upload 的 Cloudflare R2 配置（写进项目根 .env）",
      "",
      "示例:",
      "  akasha init",
      "  akasha build_map",
      "  akasha export --out D:\\out",
      "  akasha export --group logo --pattern '^UI_ItemIcon_1\\d+$'",
      "  akasha emoji --lang CHS,EN",
      "  akasha upload",
      "",
      "export 规则组:",
      ...Object.entries(rules.groups).map(
        ([name, group]) => `  ${name.padEnd(18)} ${group.description}`,
      ),
      `  默认全部使用: ${rules.default.join(", ")}`,
      "",
      "emoji 语言 (--lang，默认全部；RU/TH 的上游分片 _0/_1 会自动合并):",
      `  ${Object.keys(TEXT_MAP_LANGS).join(" | ")}`,
      "",
      "运行 akasha <command> --help 查看单个命令的选项。",
    );
  }
  console.log(lines.join("\n"));
}

function parseFlags(argv: string[], spec: FlagSpec): Map<string, string[]> {
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) throw new Error(`无法识别的参数: ${token}（选项需以 -- 开头）`);
    const equals = token.indexOf("=");
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
    const arity = spec[name];
    if (!arity) {
      throw new Error(`未知选项 --${name}；可用: ${Object.keys(spec).join(", ")}`);
    }
    if (arity === "bool") {
      if (equals !== -1) throw new Error(`--${name} 不接受值`);
      flags.set(name, ["true"]);
      continue;
    }
    if (equals !== -1) {
      flags.set(name, [...(flags.get(name) ?? []), token.slice(equals + 1)]);
      continue;
    }
    if (i + 1 >= argv.length) throw new Error(`--${name} 缺少值`);
    i += 1;
    flags.set(name, [...(flags.get(name) ?? []), argv[i]!]);
  }
  return flags;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (command === undefined || command === "-h" || command === "--help") {
    printUsage();
    return;
  }
  if (command === "-v" || command === "--version") {
    console.log(PACKAGE_VERSION);
    return;
  }
  const spec = COMMANDS[command];
  if (!spec) {
    printUsage();
    throw new Error(`未知命令: ${command}`);
  }

  const flags = parseFlags(argv.slice(1), { ...COMMON_FLAGS, ...spec.flags });
  if (flags.has("help")) {
    printUsage(command);
    return;
  }

  const ctx: Context = {
    workDir: resolveWorkDir(flags.get("work-dir")?.at(-1)),
    game: flags.get("game")?.at(-1) ?? "GI",
    silent: flags.has("silent"),
  };
  setSilent(ctx.silent);
  await spec.run(ctx, flags);
}

try {
  await main();
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
