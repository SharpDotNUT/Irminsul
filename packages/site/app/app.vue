<script setup lang="ts">
/**
 * 纯静态站点外壳：两个功能并列，`Static/GI` 下各取各的数据（见 `nuxt.config.ts` 的 ASSETS_BASE）。
 *  - 表情包：`formatted/emoji.json` + `formatted/texts/<语言>.json` + `binary/Texture2D/*.png`
 *  - 地图：`formatted/map.json` + `binary/MapTile/<region>/<R>/<gx>_<gy>.webp`
 */
import EmojiExplorer from "~/components/EmojiExplorer.vue";
import MapViewer from "~/components/MapViewer.vue";

const TABS = [
  { name: "emoji", label: "表情包" },
  { name: "map", label: "地图" },
] as const;
type TabName = (typeof TABS)[number]["name"];

/** 表情包一直挂着（切回来不丢搜索与选中）；地图是 canvas，切走就卸载，回来重新初始化。 */
const tab = ref<TabName>("emoji");
</script>

<template>
  <var-app-bar title="原神资料站" type="surface" border :elevation="0" />

  <nav class="app-nav" aria-label="功能">
    <button
      v-for="item in TABS"
      :key="item.name"
      type="button"
      class="nav-item"
      :aria-current="tab === item.name ? 'page' : undefined"
      @click="tab = item.name"
    >
      {{ item.label }}
    </button>
  </nav>

  <EmojiExplorer v-show="tab === 'emoji'" />
  <MapViewer v-if="tab === 'map'" />
</template>
