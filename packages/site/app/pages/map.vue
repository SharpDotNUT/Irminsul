<script setup lang="ts">
/**
 * UI_MapBack 地图页（`/map`）：canvas 平铺渲染 + 按需加载瓦片。
 *
 * 渲染循环的要点（都是踩出来的）：
 *  - 每格走两趟：先把**手上已有的最细档**画上去（跨档时用父档当替身并 clip 到目标矩形），
 *    再去请求**该档真正存在的最细瓦片**。合成一趟的话，"目标档存在但还在下载"会直接 break，
 *    于是那一帧什么都不画 —— 每次跨档闪一下空白。
 *  - 只请求 `levelTiles` 里存在的瓦片，所以永远不会打出 404。
 *  - 粗档（R ≤ 64）启动就预取并钉住不驱逐，否则从细档往回缩放时会闪一帧空白。
 *  - 档位按**设备像素**选（`cellPx = cell * scale * dpr`）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  LEVELS,
  TILE,
  boundsOf,
  gridsOf,
  levelFor,
  levelTiles,
  tileAtWorld,
  tileRect,
  tileUrl,
  visibleTiles,
  type MapGrid,
  type MapManifest,
} from "~/utils/map-geometry";

const MAX_SCALE = 8; // 世界像素最多放大 8×（超过原生 2048 就是放大，不是缺数据）
const MAX_INFLIGHT = 8; // 一次跨档能看到几十块，不限流就是一帧发几十个请求
const MAX_CACHED = 384; // 一块解码后约 1 MB，走遍所有档位会碰到 ~1500 块，不能指望 GC
const COARSE = 64; // 比它更粗的档覆盖整个 region 只要几张，钉住常驻

const base = useRuntimeConfig().public.assetsBase.replace(/\/+$/, "");
const tilesBase = `${base}/binary/MapTile/`;

const { data: manifest, error, refresh } = useAsyncData("map-manifest", () => $fetch<MapManifest>(`${base}/formatted/map.json`));

const grids = computed(() => (manifest.value ? gridsOf(manifest.value) : null));
const region = ref("");
watch(
  grids,
  (value) => {
    if (value && !value.has(region.value)) region.value = [...value.keys()][0] ?? "";
  },
  { immediate: true },
);
const regionOptions = computed(() => [...(grids.value?.keys() ?? [])].map((name) => ({ label: name, value: name })));

const canvasEl = ref<HTMLCanvasElement | null>(null);
const containerEl = ref<HTMLElement | null>(null);
const perfText = ref("准备中…");
const hudText = ref("");

const clamp = (value: number, low: number, high: number) => (value < low ? low : value > high ? high : value);

let ctx: CanvasRenderingContext2D | null = null;
let observer: ResizeObserver | null = null;
let timer = 0;
let raf = 0;
let dpr = 1;
let W = 0;
let H = 0;
let inflight = 0;
let drawn = 0;
let level: number = LEVELS[0]!;
let disposed = false;
let drag: { id: number; x: number; y: number; tx: number; ty: number } | null = null;

const view = { scale: 1, tx: 0, ty: 0 };
const cells = new Map<string, HTMLImageElement | null>(); // 值 null = 在飞
const gone = new Set<string>(); // 404 过的键，只问一次
const pinned = new Set<string>(); // 粗档，永不驱逐
const queue: { key: string; url: string }[] = [];
let recent = new Set<string>(); // 上一帧画过的键，驱逐时保留

const perf = { prev: 0, frameMs: 0, jsMs: 0, srcBytes: 0, draws: 0, lastPaint: 0 };

const current = (): MapGrid | undefined => grids.value?.get(region.value);

function schedule(): void {
  if (!raf) raf = requestAnimationFrame(frame);
}

/** 把整个 region 缩放到刚好放得下并居中。 */
function fit(): void {
  const grid = current();
  if (!grid || W === 0 || H === 0) return;
  const [x0, y0, x1, y1] = boundsOf(grid);
  view.scale = clamp(Math.min(W / (x1 - x0), H / (y1 - y0)) * 0.98, 16 / grid.cell, MAX_SCALE);
  view.tx = W / 2 - ((x0 + x1) / 2) * view.scale;
  view.ty = H / 2 - ((y0 + y1) / 2) * view.scale;
}

/** 取过就不再取；值同时充当"在飞"标记，一帧内不会重复排队同一块。 */
function ensure(grid: MapGrid, R: number, gx: number, gy: number): void {
  const key = `${grid.region}|${R}|${gx}|${gy}`;
  if (cells.has(key) || gone.has(key)) return;
  cells.set(key, null);
  queue.push({ key, url: tileUrl(tilesBase, grid, R, gx, gy) });
  pump();
}

/** 预取最粗的几档（Teyvat 一共 14 张）：任何档位切换时都有替身可画，不会先闪一帧空白。 */
function prefetchCoarse(grid: MapGrid): void {
  for (const R of LEVELS) {
    if (R > COARSE) break;
    for (const key of levelTiles(grid, R)) {
      const comma = key.indexOf(",");
      const gx = Number(key.slice(0, comma));
      const gy = Number(key.slice(comma + 1));
      ensure(grid, R, gx, gy);
      pinned.add(`${grid.region}|${R}|${gx}|${gy}`);
    }
  }
}

function pump(): void {
  while (inflight < MAX_INFLIGHT && queue.length > 0) {
    const job = queue.shift()!;
    inflight += 1;
    const image = new Image();
    image.decoding = "async";
    // 故意不设 crossOrigin：对象存储不返回 ACAO、OPTIONS 直接 403，而瓦片只画不读。
    image.onload = () => {
      inflight -= 1;
      if (disposed) return;
      cells.set(job.key, image);
      evict();
      pump();
      schedule();
    };
    image.onerror = () => {
      inflight -= 1;
      if (disposed) return;
      cells.delete(job.key);
      gone.add(job.key);
      pump();
      schedule();
    };
    image.src = job.url;
  }
}

/** 丢弃上一帧没画过的最旧的瓦片：撑爆缓存的是一整档旧瓦片，而不是当前视图。 */
function evict(): void {
  if (cells.size <= MAX_CACHED) return;
  for (const [key, image] of cells) {
    if (cells.size <= MAX_CACHED) break;
    if (image === null || recent.has(key) || pinned.has(key)) continue;
    cells.delete(key);
  }
}

function frame(ts: number): void {
  raf = 0;
  const context = ctx;
  const grid = current();
  if (!context || !grid) return;

  const jsStart = performance.now();
  if (perf.prev) {
    const dt = ts - perf.prev;
    if (dt > 0 && dt < 500) perf.frameMs = perf.frameMs ? perf.frameMs * 0.9 + dt * 0.1 : dt;
  }
  perf.prev = ts;
  perf.lastPaint = jsStart;
  perf.srcBytes = 0;

  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.fillStyle = "#0b141c";
  context.fillRect(0, 0, W, H);

  const scale = view.scale;
  context.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * view.tx, dpr * view.ty);
  const wx0 = -view.tx / scale;
  const wy0 = -view.ty / scale;
  const wx1 = (W - view.tx) / scale;
  const wy1 = (H - view.ty) / scale;

  const R = levelFor(grid.cell * scale * dpr);
  const painted = new Set<string>();
  drawn = 0;
  for (const tile of visibleTiles(grid, R, wx0, wy0, wx1, wy1)) {
    // 1) 手上已有的最细档先画上去：跨档时用父档当替身，绝不闪空白。
    for (let r = R, gx = tile.gx, gy = tile.gy; r >= LEVELS[0]!; r /= 2, gx >>= 1, gy >>= 1) {
      const key = `${grid.region}|${r}|${gx}|${gy}`;
      const image = cells.get(key);
      if (!image) continue;
      painted.add(key);
      if (r === R) {
        context.drawImage(image, tile.x, tile.y, tile.size, tile.size);
        perf.srcBytes += TILE * TILE * 4;
      } else {
        // 父档一块盖 4 块（甚至更多）地，不 clip 就会盖掉邻居已经画好的正确内容。
        const [ax, ay, size] = tileRect(grid, r, gx, gy);
        context.save();
        context.beginPath();
        context.rect(tile.x, tile.y, tile.size, tile.size);
        context.clip();
        context.drawImage(image, ax, ay, size, size);
        context.restore();
        const ratio = size / tile.size;
        perf.srcBytes += ((TILE * TILE) / (ratio * ratio)) * 4;
      }
      drawn += 1;
      break;
    }
    // 2) 再去要这里真正存在的最细档。两趟分开，才不会因为"还在下载"白画一帧。
    for (let r = R, gx = tile.gx, gy = tile.gy; r >= LEVELS[0]!; r /= 2, gx >>= 1, gy >>= 1) {
      if (levelTiles(grid, r).has(`${gx},${gy}`)) {
        ensure(grid, r, gx, gy);
        break;
      }
    }
  }
  recent = painted;
  level = R;
  perf.draws = drawn;
  const jsMs = performance.now() - jsStart;
  perf.jsMs = perf.jsMs ? perf.jsMs * 0.9 + jsMs * 0.1 : jsMs;
}

/** 面板读数：用定时器而不是渲染帧 —— 挂在帧上的话，静止时就正好不刷新了。 */
function updatePerf(): void {
  const idle = performance.now() - perf.lastPaint > 500;
  let held = 0;
  for (const image of cells.values()) if (image) held += 1;
  perfText.value =
    `fps   ${idle ? " --" : (1000 / perf.frameMs).toFixed(0).padStart(3)}   ` +
    `frame ${idle ? "   --" : perf.frameMs.toFixed(1).padStart(5)} ms   js ${perf.jsMs.toFixed(1).padStart(4)} ms\n` +
    `draw  ${String(perf.draws).padStart(3)}   src ${(perf.srcBytes / 1e6).toFixed(1).padStart(5)} MB/frame   ` +
    `level ${level} px/cell\n` +
    `tiles ${String(held).padStart(4)} 张常驻   ${queue.length + inflight} 排队   ${gone.size} 缺失`;
}

function resize(): void {
  const canvas = canvasEl.value;
  const container = containerEl.value;
  if (!canvas || !container || !ctx) return;
  dpr = window.devicePixelRatio || 1;
  W = container.clientWidth;
  H = container.clientHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  schedule();
}

function onWheel(event: WheelEvent): void {
  const canvas = canvasEl.value;
  if (!canvas) return;
  const grid = current();
  if (!grid) return;
  const rect = canvas.getBoundingClientRect();
  const mx = event.clientX - rect.left;
  const my = event.clientY - rect.top;
  const next = clamp(view.scale * Math.exp(-event.deltaY * 0.0015), 16 / grid.cell, MAX_SCALE);
  const factor = next / view.scale;
  view.tx = mx - (mx - view.tx) * factor;
  view.ty = my - (my - view.ty) * factor;
  view.scale = next;
  schedule();
}

function onPointerDown(event: PointerEvent): void {
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, tx: view.tx, ty: view.ty };
  canvasEl.value?.setPointerCapture(event.pointerId);
}

function onPointerMove(event: PointerEvent): void {
  const canvas = canvasEl.value;
  const grid = current();
  if (!canvas || !grid) return;
  const rect = canvas.getBoundingClientRect();
  if (drag && drag.id === event.pointerId) {
    view.tx = drag.tx + (event.clientX - drag.x);
    view.ty = drag.ty + (event.clientY - drag.y);
    schedule();
  }
  const wx = (event.clientX - rect.left - view.tx) / view.scale;
  const wy = (event.clientY - rect.top - view.ty) / view.scale;
  const cell = grid.byCell.get(`${Math.floor(wx / grid.cell)},${Math.floor(wy / grid.cell)}`);
  const [gx, gy] = tileAtWorld(grid, level, wx, wy);
  hudText.value =
    `zoom ${(grid.cell * view.scale).toFixed(0)} px/cell   world ${wx.toFixed(0)}, ${wy.toFixed(0)}   ` +
    `tile ${gx}, ${gy} @${level}   ${cell ? `${cell.asset} (${cell.size}px)` : "-"}`;
}

function onPointerUp(event: PointerEvent): void {
  if (drag && drag.id === event.pointerId) drag = null;
  canvasEl.value?.releasePointerCapture?.(event.pointerId);
}

function onDoubleClick(event: MouseEvent): void {
  const canvas = canvasEl.value;
  const grid = current();
  if (!canvas || !grid) return;
  const rect = canvas.getBoundingClientRect();
  const mx = event.clientX - rect.left;
  const my = event.clientY - rect.top;
  const next = clamp(view.scale * 2, 16 / grid.cell, MAX_SCALE);
  const factor = next / view.scale;
  view.tx = mx - (mx - view.tx) * factor;
  view.ty = my - (my - view.ty) * factor;
  view.scale = next;
  schedule();
}

function reset(): void {
  const grid = current();
  if (!grid) return;
  fit();
  prefetchCoarse(grid);
  schedule();
}

/** 容器只在清单到位后才渲染出来，所以 canvas 的初始化要等这一帧挂载完成。 */
function initCanvas(): void {
  const canvas = canvasEl.value;
  const container = containerEl.value;
  if (!canvas || !container || ctx) return;
  ctx = canvas.getContext("2d", { alpha: false });
  observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();
}

watch(region, reset);
watch(grids, async (value) => {
  if (!value) return;
  await nextTick();
  initCanvas();
  reset();
});

onMounted(async () => {
  timer = window.setInterval(updatePerf, 250);
  updatePerf();
  await nextTick();
  initCanvas();
  reset();
});

onBeforeUnmount(() => {
  disposed = true;
  if (raf) cancelAnimationFrame(raf);
  window.clearInterval(timer);
  observer?.disconnect();
  cells.clear();
  queue.length = 0;
  ctx = null;
});
</script>

<template>
  <var-loading v-if="!manifest && !error" loading description="加载中…" />
  <var-result
    v-else-if="error"
    type="error"
    title="加载失败"
    :description="`${error.message}（地图清单 ${base}/formatted/map.json，可用 NUXT_PUBLIC_ASSETS_BASE 指向 R2 上的 Static/GI）`"
  >
    <template #footer>
      <var-button type="primary" @click="refresh()">重试</var-button>
    </template>
  </var-result>
  <div v-else ref="containerEl" class="map">
    <canvas
      ref="canvasEl"
      class="map-canvas"
      @wheel.prevent="onWheel"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @dblclick="onDoubleClick"
    />
    <div class="map-panel">
      <label class="map-region">
        区域
        <var-menu-select v-model="region" :options="regionOptions" size="small" />
      </label>
      <pre class="map-perf">{{ perfText }}</pre>
      <div class="map-hud">{{ hudText || "拖拽平移 · 滚轮缩放 · 双击放大" }}</div>
    </div>
  </div>
</template>
