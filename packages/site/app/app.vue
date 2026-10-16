<script setup lang="ts">
/**
 * 纯静态站点外壳：app bar + 顶级导航，两个功能各自是一个路由页面（见 `app/pages/`）。
 *  - `/`     表情包：`formatted/emoji.json` + `formatted/texts/<语言>.json` + `binary/Texture2D/*.png`
 *  - `/map`  地图：`formatted/map.json` + `binary/MapTile/<region>/<R>/<gx>_<gy>.webp`
 *
 * 分成两个页面而不是同一页里 `v-show` 切换：切页会真正卸载上一个页面，DOM 与已解码位图一并释放，
 * 地图那块 canvas 与瓦片缓存不会和表情包那 800 多张图叠加在同一个文档里；直接打开 `/map` 时，
 * 表情包那部分内存根本不会产生。
 */
const NAV = [
  { to: "/", label: "表情包" },
  { to: "/map", label: "地图" },
] as const;

const route = useRoute();
</script>

<template>
  <var-app-bar title="原神资料站" type="surface" border :elevation="0" />

  <nav class="app-nav" aria-label="功能">
    <NuxtLink
      v-for="item in NAV"
      :key="item.to"
      :to="item.to"
      class="nav-item"
      :aria-current="route.path === item.to ? 'page' : undefined"
    >
      {{ item.label }}
    </NuxtLink>
  </nav>

  <NuxtPage />
</template>
