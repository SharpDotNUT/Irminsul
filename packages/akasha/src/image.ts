/**
 * 原始 RGBA 与字节之间的最小通道。
 *
 * `Bun.Image` 能解码 PNG/JPEG/WebP、用 SIMD 核做高质量缩放、编码 WebP，但它的每一步都
 * 只能吃/吐"编码后的字节"：既拿不到原始像素，也没有裁剪与合成。地图金字塔两样都要 ——
 * 一块瓦片是大图里的一个 512² 子矩形，粗档还要把每个格拼成一张 region 图。
 *
 * 所以这里补上两个方向，且都只处理我们自己产生的字节，不做通用解码器：
 *  - `decodePng()`：读回 `Bun.Image` 写出的 PNG（8bit、非隔行、colorType 2 或 6，Bun 只会产出这两种）；
 *  - `encodeBmp()`：把原始 RGBA 交回 `Bun.Image` 解码（BMP 无压缩，编码只要几十行，比写 PNG 快得多）。
 */

import { inflateSync } from "node:zlib";

/** 未编码的像素：RGBA8、逐行、无 padding。`data` 可写，但 `width`/`height` 不变。 */
export type RawImage = { readonly width: number; readonly height: number; readonly data: Uint8Array };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** 原地还原一行：PNG 的 5 种行过滤器（0 none / 1 sub / 2 up / 3 average / 4 paeth）。 */
function unfilter(type: number, line: Uint8Array, previous: Uint8Array, step: number): void {
  switch (type) {
    case 0:
      return;
    case 1:
      for (let i = step; i < line.length; i++) line[i] = (line[i]! + line[i - step]!) & 0xff;
      return;
    case 2:
      for (let i = 0; i < line.length; i++) line[i] = (line[i]! + previous[i]!) & 0xff;
      return;
    case 3:
      for (let i = 0; i < line.length; i++) {
        const left = i >= step ? line[i - step]! : 0;
        line[i] = (line[i]! + ((left + previous[i]!) >> 1)) & 0xff;
      }
      return;
    case 4:
      for (let i = 0; i < line.length; i++) {
        const left = i >= step ? line[i - step]! : 0;
        const up = previous[i]!;
        const upLeft = i >= step ? previous[i - step]! : 0;
        line[i] = (line[i]! + paeth(left, up, upLeft)) & 0xff;
      }
      return;
    default:
      throw new Error(`PNG 行过滤器类型未知: ${type}`);
  }
}

/** 解码一张 PNG 为原始 RGBA。只支持 `Bun.Image` 会写出的形态，别的形态直接报错而不是猜。 */
export function decodePng(bytes: Uint8Array): RawImage {
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error("不是 PNG 数据（签名不匹配）");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const parts: Uint8Array[] = [];
  for (let offset = PNG_SIGNATURE.length; offset + 8 <= bytes.byteLength; ) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!);
    const start = offset + 8;
    if (type === "IHDR") {
      width = view.getUint32(start);
      height = view.getUint32(start + 4);
      bitDepth = bytes[start + 8]!;
      colorType = bytes[start + 9]!;
      if (bytes[start + 12] !== 0) throw new Error("不支持隔行 PNG");
    } else if (type === "IDAT") {
      parts.push(bytes.subarray(start, start + length));
    } else if (type === "IEND") {
      break;
    }
    offset = start + length + 4;
  }
  const step = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (step === 0 || bitDepth !== 8) {
    throw new Error(`不支持的 PNG 形态（colorType ${colorType}，bitDepth ${bitDepth}）`);
  }

  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * step;
  const data = new Uint8Array(width * height * 4);
  const line = new Uint8Array(stride);
  const previous = new Uint8Array(stride);
  let cursor = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[cursor]!;
    cursor += 1;
    line.set(raw.subarray(cursor, cursor + stride));
    cursor += stride;
    unfilter(filter, line, previous, step);
    for (let x = 0; x < width; x++) {
      const from = x * step;
      const to = (y * width + x) * 4;
      data[to] = line[from]!;
      data[to + 1] = line[from + 1]!;
      data[to + 2] = line[from + 2]!;
      data[to + 3] = step === 4 ? line[from + 3]! : 0xff;
    }
    previous.set(line);
  }
  return { width, height, data };
}

/** BITMAPFILEHEADER + BITMAPV4HEADER：14 + 108 字节。 */
const BMP_HEADER = 14 + 108;

/** 把原始 RGBA 包成 32bpp 的 BMP（BI_BITFIELDS、自下而上），`Bun.Image` 可以直接解码。 */
export function encodeBmp(image: RawImage): Uint8Array {
  const { width, height, data } = image;
  const out = new Uint8Array(BMP_HEADER + width * height * 4);
  const view = new DataView(out.buffer);
  out[0] = 0x42;
  out[1] = 0x4d;
  view.setUint32(2, out.length, true);
  view.setUint32(10, BMP_HEADER, true);
  view.setUint32(14, 108, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 32, true);
  view.setUint32(30, 3, true); // BI_BITFIELDS
  view.setUint32(34, width * height * 4, true);
  view.setUint32(54, 0x00ff0000, true); // R
  view.setUint32(58, 0x0000ff00, true); // G
  view.setUint32(62, 0x000000ff, true); // B
  view.setUint32(66, 0xff000000, true); // A
  for (let y = 0; y < height; y++) {
    let to = BMP_HEADER + (height - 1 - y) * width * 4;
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4;
      out[to] = data[from + 2]!;
      out[to + 1] = data[from + 1]!;
      out[to + 2] = data[from]!;
      out[to + 3] = data[from + 3]!;
      to += 4;
    }
  }
  return out;
}

/** 全透明的空白图。 */
export function blank(width: number, height: number): RawImage {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

/** 取 `src` 中 `(x, y)` 起 `w × h` 的子矩形；右侧/下侧越界处留全透明。 */
export function crop(src: RawImage, x: number, y: number, w: number, h: number): RawImage {
  const out = blank(w, h);
  const width = Math.min(w, src.width - x);
  const height = Math.min(h, src.height - y);
  for (let j = 0; j < height; j++) {
    const from = ((y + j) * src.width + x) * 4;
    out.data.set(src.data.subarray(from, from + width * 4), j * w * 4);
  }
  return out;
}

/** 恰好 2× 的盒式降采样（2×2 均值），与 PIL 在整数倍下的 `Image.BOX` 同义。 */
export function halve(src: RawImage): RawImage {
  const width = src.width >> 1;
  const height = src.height >> 1;
  const out = blank(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const to = (y * width + x) * 4;
      const a = (2 * y * src.width + 2 * x) * 4;
      const b = a + 4;
      const c = a + src.width * 4;
      const d = c + 4;
      for (let k = 0; k < 4; k++) {
        out.data[to + k] = (src.data[a + k]! + src.data[b + k]! + src.data[c + k]! + src.data[d + k]!) >> 2;
      }
    }
  }
  return out;
}

/** 把 `src` 整块盖到 `dst` 的 `(x, y)`：格子之间互不重叠，直接覆盖即可，无需 alpha 混合。 */
export function blit(dst: RawImage, src: RawImage, x: number, y: number): void {
  for (let j = 0; j < src.height; j++) {
    const from = j * src.width * 4;
    dst.data.set(src.data.subarray(from, from + src.width * 4), ((y + j) * dst.width + x) * 4);
  }
}

/** 整块全透明？用于发现"切片偏移写歪"这类只有总量看不出来的错误。 */
export function isBlank(image: RawImage): boolean {
  for (let i = 3; i < image.data.length; i += 4) {
    if (image.data[i] !== 0) return false;
  }
  return true;
}
