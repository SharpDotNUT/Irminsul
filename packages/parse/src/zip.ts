import type { FileHandle } from "node:fs/promises";
import { mkdir, open, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const U32_SENTINEL = 0xffffffff;
const U16_SENTINEL = 0xffff;
const EOCD_MIN_SIZE = 22;

type ZipEntry = {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  isDir: boolean;
};

export type ExtractResult = {
  /** Entry paths actually written, relative to the destination dir. */
  files: string[];
  /** Shared leading folder that was stripped, if any (GitHub artifacts nest everything under one). */
  strippedRoot: string | null;
};

async function readExact(fh: FileHandle, length: number, position: number, what: string): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await fh.read(buffer, read, length - read, position + read);
    if (bytesRead === 0) throw new Error(`zip 读取失败：${what} 在偏移 ${position} 处被截断`);
    read += bytesRead;
  }
  return buffer;
}

/** Offset of the End Of Central Directory record inside `tail`, or -1. */
function findEocd(tail: Buffer): number {
  for (let i = tail.length - EOCD_MIN_SIZE; i >= 0; i--) {
    if (tail.readUInt32LE(i) !== SIG_EOCD) continue;
    if (i + EOCD_MIN_SIZE + tail.readUInt16LE(i + 20) <= tail.length) return i;
  }
  return -1;
}

/** zip64 extended information (header id 0x0001), only for the fields flagged as sentinels. */
function readZip64Sizes(extra: Buffer, needs: { size: boolean; offset: boolean }): number[] {
  let position = 0;
  while (position + 4 <= extra.length) {
    const id = extra.readUInt16LE(position);
    const size = extra.readUInt16LE(position + 2);
    const body = extra.subarray(position + 4, position + 4 + size);
    if (id !== 0x0001) {
      position += 4 + size;
      continue;
    }
    const values: number[] = [];
    let cursor = 0;
    const take = () => {
      const value = Number(body.readBigUInt64LE(cursor));
      cursor += 8;
      return value;
    };
    if (needs.size) {
      values.push(take(), take());
    }
    if (needs.offset) values.push(take());
    return values;
  }
  throw new Error("zip64 扩展字段缺失");
}

async function readCentralDirectory(fh: FileHandle, fileSize: number): Promise<ZipEntry[]> {
  const tailLength = Math.min(fileSize, 66_000);
  const tail = await readExact(fh, tailLength, fileSize - tailLength, "EOCD");
  const eocd = findEocd(tail);
  if (eocd < 0) throw new Error("不是有效的 zip 文件：未找到 EOCD 记录");

  let entryCount = tail.readUInt16LE(eocd + 10);
  let centralSize = tail.readUInt32LE(eocd + 12);
  let centralOffset = tail.readUInt32LE(eocd + 16);

  if (entryCount === U16_SENTINEL || centralSize === U32_SENTINEL || centralOffset === U32_SENTINEL) {
    const locator = eocd - 20;
    if (locator < 0 || tail.readUInt32LE(locator) !== SIG_EOCD64_LOCATOR) {
      throw new Error("zip64 记录损坏：缺少 EOCD64 locator");
    }
    const eocd64 = await readExact(fh, 56, Number(tail.readBigUInt64LE(locator + 8)), "EOCD64");
    if (eocd64.readUInt32LE(0) !== SIG_EOCD64) throw new Error("zip64 EOCD 记录损坏");
    entryCount = Number(eocd64.readBigUInt64LE(32));
    centralSize = Number(eocd64.readBigUInt64LE(40));
    centralOffset = Number(eocd64.readBigUInt64LE(48));
  }

  const central = await readExact(fh, centralSize, centralOffset, "中央目录");
  const entries: ZipEntry[] = [];
  let position = 0;
  for (let index = 0; index < entryCount; index++) {
    if (position + 46 > central.length || central.readUInt32LE(position) !== SIG_CENTRAL) {
      throw new Error(`中央目录第 ${index} 项损坏`);
    }
    const method = central.readUInt16LE(position + 10);
    const compressedSize = central.readUInt32LE(position + 20);
    const uncompressedSize = central.readUInt32LE(position + 24);
    const nameLength = central.readUInt16LE(position + 28);
    const extraLength = central.readUInt16LE(position + 30);
    const commentLength = central.readUInt16LE(position + 32);
    const externalAttributes = central.readUInt32LE(position + 38);
    const localOffset = central.readUInt32LE(position + 42);
    const nameStart = position + 46;
    const name = central.toString("utf8", nameStart, nameStart + nameLength);
    const extra = central.subarray(nameStart + nameLength, nameStart + nameLength + extraLength);

    let size = uncompressedSize;
    let compressed = compressedSize;
    let offset = localOffset;
    if (
      uncompressedSize === U32_SENTINEL ||
      compressedSize === U32_SENTINEL ||
      localOffset === U32_SENTINEL
    ) {
      const [plain, deflated, local] = readZip64Sizes(extra, {
        size: uncompressedSize === U32_SENTINEL && compressedSize === U32_SENTINEL,
        offset: localOffset === U32_SENTINEL,
      });
      if (uncompressedSize === U32_SENTINEL && compressedSize === U32_SENTINEL) {
        size = plain;
        compressed = deflated;
      }
      if (offset === U32_SENTINEL) offset = local;
    }

    entries.push({
      name,
      method,
      compressedSize: compressed,
      uncompressedSize: size,
      localOffset: offset,
      // Directory bit (0x10) from the MS-DOS attributes, or a trailing slash.
      isDir: name.endsWith("/") || (externalAttributes & 0x10) !== 0,
    });
    position = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * GitHub artifact zips nest every entry under a single `Name-<sha>/` folder. Strip it so the
 * extracted tree is stable regardless of the build hash.
 */
function commonRoot(entries: ZipEntry[]): string | null {
  const roots = new Set<string>();
  for (const entry of entries) {
    const [root, ...rest] = entry.name.split("/");
    if (rest.length === 0 || root === undefined || root.length === 0) return null;
    roots.add(root);
  }
  return roots.size === 1 ? [...roots][0]! : null;
}

/** Rejects absolute paths, drive letters and `..` traversal inside the archive. */
function targetPath(destDir: string, name: string): string {
  const cleaned = name.replace(/\\/g, "/");
  if (cleaned.startsWith("/") || /^[a-zA-Z]:/.test(cleaned) || cleaned.split("/").includes("..")) {
    throw new Error(`zip 条目路径非法: ${name}`);
  }
  return join(destDir, cleaned);
}

async function localDataOffset(fh: FileHandle, localOffset: number): Promise<number> {
  const header = await readExact(fh, 30, localOffset, "本地文件头");
  if (header.readUInt32LE(0) !== SIG_LOCAL) throw new Error(`本地文件头损坏 @${localOffset}`);
  return localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
}

/**
 * Extracts a zip archive without shelling out to `tar`/`Expand-Archive`.
 * Deflate entries are inflated per-entry, so memory stays bounded by the largest member.
 */
export async function extractZip(
  zipPath: string,
  destDir: string,
  options: { stripCommonRoot?: boolean } = {},
): Promise<ExtractResult> {
  const fh = await open(zipPath, "r");
  try {
    const { size } = await fh.stat();
    const entries = await readCentralDirectory(fh, size);
    const strippedRoot = options.stripCommonRoot === false ? null : commonRoot(entries);
    const files: string[] = [];

    for (const entry of entries) {
      const name = strippedRoot === null ? entry.name : entry.name.slice(strippedRoot.length + 1);
      if (name.length === 0) continue;
      const target = targetPath(destDir, name);
      if (entry.isDir) {
        await mkdir(target, { recursive: true });
        continue;
      }

      const compressed = await readExact(
        fh,
        entry.compressedSize,
        await localDataOffset(fh, entry.localOffset),
        entry.name,
      );
      let data: Buffer;
      if (entry.method === 0) data = compressed;
      else if (entry.method === 8) data = inflateRawSync(compressed);
      else throw new Error(`不支持的压缩方式 ${entry.method}: ${entry.name}`);
      if (data.length !== entry.uncompressedSize) {
        throw new Error(`解压后长度不符 (${data.length} != ${entry.uncompressedSize}): ${entry.name}`);
      }

      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
      files.push(name);
    }
    return { files, strippedRoot };
  } finally {
    await fh.close();
  }
}
