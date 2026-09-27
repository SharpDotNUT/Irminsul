import { Themes } from "@varlet/ui";
import { VarletImportResolver } from "@varlet/import-resolver";
import Components from "unplugin-vue-components/vite";

/**
 * 纯静态站点：`nuxt generate` 产出的只有 HTML/JS，运行时没有任何服务端；
 * 页面自己从对象存储（`akasha upload` 推上去的 `Static/GI/{formatted,binary}`）拉 JSON 与 PNG。
 *
 * 数据源是 bucket 的公共域名，默认写死在这里，跨域也能取（bucket 的 CORS 放行了这个域名与
 * `http://localhost:3000`）。换域名/换前缀时用 `NUXT_PUBLIC_ASSETS_BASE` 覆盖（构建时读取），
 * 站点挂在别的域名下时记得把该 origin 加进 bucket 的 CORS 规则。
 */
const ASSETS_BASE = process.env.NUXT_PUBLIC_ASSETS_BASE || "https://irminsul-os.kuriyona.com/Static/GI";

/**
 * 全站只有 Material 3 暗色一套主题，所以构建期就把 Varlet 的设计变量摊成一段内联 CSS 写进 `<head>`：
 * 它不随系统或用户变化，不需要客户端插件，也不会出现“注入前先按浅色画一屏”的闪白
 * （Varlet 自己的默认变量是浅色的）。选择器用 `:root:root` 是为了压过后面加载的默认值，`StyleProvider` 用的是同一招。
 */
const MD3_DARK_STYLE_VARS = Object.entries(Themes.md3Dark)
  .map(([name, value]) => `${name}:${value}`)
  .join(";");

export default defineNuxtConfig({
  compatibilityDate: "2026-09-19",
  ssr: false,
  devtools: { enabled: false },
  css: ["~/assets/main.css"],
  // Varlet 按需引入：模板里的 <var-*> 由 resolver 注入组件与对应样式（`@varlet/ui` 声明了
  // `sideEffects`，未用到的组件会被摇掉，别改成从 barrel 里手写 import）。
  // 生成的 `app/components.d.ts` 是 vue-tsc 认识这些组件类型的前提，随代码提交。
  vite: {
    plugins: [Components({ dirs: [], dts: "components.d.ts", resolvers: [VarletImportResolver()] })],
  },
  // 直接写 IP：默认的 "localhost" 在部分环境只绑到 ::1，浏览器连不上。
  devServer: { host: "127.0.0.1" },
  runtimeConfig: {
    public: { assetsBase: ASSETS_BASE },
  },
  app: {
    head: {
      title: "原神表情包",
      htmlAttrs: { lang: "zh-CN" },
      meta: [{ name: "viewport", content: "width=device-width, initial-scale=1" }],
      style: [{ innerHTML: `:root:root{${MD3_DARK_STYLE_VARS}}` }],
    },
  },
});
