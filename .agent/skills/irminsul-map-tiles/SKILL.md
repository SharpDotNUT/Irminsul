---
name: irminsul-map-tiles
description: Irminsul 的 UI_MapBack 地图瓦片：akasha pyramid 怎么把导出贴图切成 WebP 金字塔（region/档位/格子映射规则、map.json 清单）、站点 MapViewer 怎么按同一份规则请求瓦片（父档回退、缓存驱逐、永不打 404），以及 Bun.Image 缺原始像素/裁剪时 image.ts 那层桥接的用法与坑。当要改地图切片、地图浏览、瓦片 URL/档位/坐标系，或排查“地图错位/空白/404/卡顿”时使用。
---

# UI_MapBack 地图瓦片（切片 + 浏览）

代码位置：

| 文件 | 职责 |
|---|---|
| `packages/akasha/src/map-tiles.ts` | 唯一真源：清点贴图、格子映射、档位规则、切金字塔、写 `map.json` |
| `packages/akasha/src/image.ts` | `Bun.Image` 缺的那半：`decodePng` / `encodeBmp` / `crop` / `halve` / `blit` / `isBlank` |
| `packages/akasha/src/commands/pyramid.ts` | `akasha pyramid` 命令 |
| `packages/site/app/utils/map-geometry.ts` | 站点侧镜像（必须与 `map-tiles.ts` 同步改） |
| `packages/site/app/pages/map.vue` | canvas 查看器（站点地图页 `/map`） |

## 1. 三条规则（全部来自资源本身，不是约定）

```
贴图 UI_MapBack[_Region]_x_y   铺在格 (-y, -x) 上，一格 = CELL = 2048 世界像素
```

1. **图片永远铺满整格**：贴图自身的像素尺寸（2048/1024/128/64）是**该格的细节上限**，不是覆盖范围。
   把它当成"图片 1:1 贴在格子左上角"来解释，264 张图会碎成马赛克 —— 这是最容易搞错的一条。
2. **档位 `R` = 该档每格多少像素**，从 2048 逐倍减半到 16；最高档是原生上限（再往上切纯属放大），
   最低档由查看器最小缩放（`16/CELL`）决定。档距必须 ×2：跨档时父档正好是整数 2×2 替身，像素对齐、无接缝。
3. **一格只在 `R ≤ 自己的原生尺寸` 的档位上出瓦片**：64 原生的格在 R=2048 上不生成。于是细档天然稀疏
   （Teyvat R=2048 有 688 块、R=1024 有 616 块，而 R=16 全 region 只有 1 块），并且**任意档位的任意位置，
   沿 `R/2, R/4 … 16` 一定能找到一张存在的瓦片**（最坏到 R=16 时整个 region 就一张）。客户端靠这条跨档回退，
   所以缩放永远不会闪白。

子图 `AbyssalPalace` / `DeepSea` / `TheChasm` 是**独立坐标系**，不能和 Teyvat 混在一张画布上；
`UI_MapBack_None.png`（64×64）没有坐标，跳过。

## 2. 产物与上传

```
.parse/pyramid/{region}/{R}/{gx}_{gy}.webp     # gx,gy 以该 region 最小格为原点
.parse/pyramid/map.json                        # 清单：cell + region → 原生尺寸 → [x,y] 列表
```

`akasha upload` 把它们推成 `Static/GI/binary/MapTile/{region}/{R}/{gx}_{gy}.webp` 与
`Static/GI/formatted/map.json`（清单是 JSON，和 `emoji.json` 一样归 `formatted/`）。
站点只读公共域名，**不设 `crossOrigin`**（对象存储不给 ACAO、OPTIONS 直接 403）；canvas 因此被污染，
不能 `getImageData`/`toDataURL` —— 只画不读，没问题。

**不用手写资源清单**：region 与坐标从文件名解析（`^UI_MapBack_(?:([A-Za-z]+)_)?(-?\d+)_(-?\d+)$`，
区域名与坐标之间也是 `_`），原生尺寸读 PNG 文件头（IHDR 字节 16..20，大端）；坐标可以是负数。

## 3. 切片实现（`map-tiles.ts`）

- 细档（`R ≥ TILE`）：**一块瓦片永远不跨格**，所以每格自成一个正方形金字塔，逐倍 2×2 均值减半；
  每块瓦片是那格图里的 `(i*TILE, j*TILE)` 子矩形（**格内偏移，不是绝对网格下标**）。
- 粗档（`R < TILE`）：一块瓦片跨多个格，所以先把每个格按 256 px **各自重采样**后拼成一张 region 图，
  再逐倍对半缩。顺序很重要：每格分别采样再拼，反过来会让 2048 原生格和 64 原生格的边界互相污染。
  Teyvat 峰值内存约 110 MB。
- 尺寸上限与插值：源图已经等于目标尺寸就不重采样（1:1 重采样会把像素磨软）；缩小用 `lanczos3`，
  粗档里给小图的放大用 `cubic`；减半用 2×2 均值（等价于 PIL 的 `Image.BOX`）。
- 输出 WebP quality 85。本机实测 1670 块 / 34 MiB / 约 58 s（源图 296 张 PNG / 248 MiB）；
  重量全在 2048/1024 两档（占 80%）。

## 4. `image.ts`：为什么需要它，边界在哪

`Bun.Image` 能解码任意 PNG/JPEG/WebP、SIMD 缩放、编码 WebP，**但不给原始像素，也没有裁剪/合成**：
它只能吃"编码后的字节"、吐"编码后的字节"。而切片两样都要（裁 512² 子矩形、把多个格拼成一张图）。
所以：

- **Bun → 我**：`decodePng(await image.png({ compressionLevel: 0 }).bytes())`。`compressionLevel: 0` 让 zlib
  存原始块，省掉一次无意义的压缩；解码器只支持 Bun 会写出的形态（8bit、非隔行、colorType 2/6），别的直接报错。
- **我 → Bun**：`new Bun.Image(encodeBmp(raw))`。BMP 无压缩、编码只要几十行，比手写 PNG 编码器简单；
  32bpp / `BITMAPV4HEADER` / BI_BITFIELDS，alpha 能完整往返（已实测）。

**不要**用这套东西去解码游戏原始资源（那是 `Bun.Image` 的活），也不要试图手写 WebP 编码器。

## 5. 查看器（`packages/site/app/pages/map.vue`）

每帧对每个可见位置走**两趟**，这是踩出来的：

1. 先把**手上已有的最细档**画上去：跨档时用父档当替身，且**必须 clip 到目标矩形**（父档一块盖 4 块甚至更多
   地，不 clip 会盖掉邻居已经画好的正确内容）。
2. 再去请求 `levelTiles` 里**真正存在**的最细档。两趟必须分开：合成一趟的话，"目标档存在但还在下载"
   会直接 break，于是那一帧什么都不画 —— 每次跨档闪一下空白。

其余关键点：

- **只请求 `levelTiles` 里存在的档**，所以永远不会打出 404（404 的键会进 `gone`，只问一次）。
- 并发 8（`MAX_INFLIGHT`）；缓存上限 384 张（`MAX_CACHED`，一块解码后约 1 MB，走遍所有档会碰到 ~1500 块）；
  驱逐时按插入序丢"上一帧没画过"的，但**粗档（`R ≤ 64`）钉住不驱逐**并**启动就预取**（Teyvat 一共 14 张）——
  否则从细档往回缩放时粗档没缓存过，会闪一帧空白。
- 档位按**设备像素**选：`levelFor(cell * scale * dpr)`；缩放锚点保持光标下的世界点不动。
- 面板读数用 250 ms 定时器刷新，不要挂在渲染帧上（静止时挂在帧上就正好不刷新了）；帧耗时用 rAF 时间戳算。
- 缩放范围 `[16/CELL, 8]`：最深是 8× 放大，早就超过原生 2048 —— 那是数据的上限，不是设计缺陷。

## 6. 坑清单（照抄旧项目的教训）

| # | 坑 | 对策 |
|---|---|---|
| 1 | JS 的 `-0`：`-0` 与 `0` 在 `Map` 里是两个键 | `cellOf` 里用 `-y \|\| 0` 归一 |
| 2 | 用绝对网格下标裁单格图（`gx*TILE`）会写出整块透明，而文件数看着正常 | 用格内偏移 `(i*TILE, j*TILE)`；生成器统计"整块透明的瓦片数"并 warn |
| 3 | 校验参考图是全不透明的，直接比差会被背景差异淹掉 | 按 alpha 掩掉背景只比内容 |
| 4 | 变量在循环外算一次（档位变了 `gx0` 没重算） | 逐档重算 |
| 5 | 跨域图设了 `crossOrigin` | 绝不设；只画不读 |
| 6 | 拿 `width`/`height` 当"覆盖范围" | 尺寸只是细节上限（见 §1） |
| 7 | 改了一边几何忘了另一边 | `map-tiles.ts` 与 `map-geometry.ts` 必须同步；见 §7 的核对办法 |

## 7. 怎么验证（不开浏览器也能做）

- **清单/几何/磁盘三者相等**：用一次性 `bun` 脚本，对每个 region × 每个档位比较
  `levelTiles(gridOf(region, map.json.regions[region]), R)`（两份实现各算一遍）与磁盘上的 `.webp` 文件名集合，
  三者必须逐元素相同。这一条覆盖了"查看器会不会请求不存在的瓦片"。
- **切片正确性**：拿另一份参考金字塔（例如旧 Python 生成的）逐档解码、按 alpha 掩码比像素。
  R2048/R1024 是纯裁切，应当 **0.000/255**；粗档只因重采样核不同而有零点几的差异。
  判据：层级/映射放错会是 **>50/255**，所以 0.2–2.3 这个量级就足以证明布局正确。
- **上传 key 映射**：把 `R2_ENDPOINT` 指到一个本地替身（ListObjectsV2 返回空列表、记录每个 `PUT`），
  跑一遍 `akasha upload` 看它到底写了哪些 key —— 不用碰真桶。
- headless 测不出光栅开销：隐藏窗口根本没在光栅化，别编墙钟提速数字；性能只用机制证据
  （每帧交给光栅器的源字节数、跨档那一帧的画法）。
