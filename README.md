# Irminsul

从原神客户端资源里提取贴图与文案、发布到对象存储、再用网页浏览的私有工具。两个包：`packages/akasha` 是
一层很薄的 CLI，把 AnimeStudio（建索引、导出 PNG）、DimbreathBot（表情配置与多语言文案）和 Cloudflare R2
（产物落点）串成一条流水线，解包本身交给上游二进制；`packages/site` 是浏览这些产物的静态站点。

```bash
pnpm install
pnpm akasha --help     # 命令、环境变量、导出规则组

pnpm akasha init       # 下载并解压 AnimeStudio CLI（一次即可）→ .parse/anime-studio/
pnpm akasha build_map  # 建索引（一次即可，全量约 8 分钟 / 54 GB）→ .parse/maps/assets_map.map
pnpm akasha export     # 导出 PNG（复用索引、不重扫，已有文件跳过）→ .parse/export/Texture2D/
pnpm akasha emoji      # 表情配置 + 每语言文案表 → .parse/emoji/
pnpm akasha pyramid    # 把 UI_MapBack 贴图切成地图瓦片金字塔 → .parse/pyramid/
pnpm akasha upload     # 推到 R2 → Static/GI/{formatted,binary}/
```

需要 Windows（上游是 net10.0-windows 构建）、Bun ≥ 1.3.14、原神客户端目录；`.env` 里放 `GENSHIN_DIR`
与上传用的 `R2_*`。各命令的用法见 [`packages/akasha/README.md`](packages/akasha/README.md)。
`.parse/` 里的索引与导出产物是昂贵缓存，别随手删 —— 原因写在 [`AGENTS.md`](AGENTS.md)。

## 网页

`packages/site` 是浏览这些产物的静态站点（Nuxt 4 + Varlet，纯客户端渲染，没有服务端）：

```bash
pnpm site         # 开发服务器 http://127.0.0.1:3000
pnpm site:build   # 静态产物 → packages/site/.output/public（拷到任意静态托管即可）
```

它不读 `.parse/`，运行时直接取 bucket 公共域名下的 `Static/GI/`：`formatted/emoji.json`（表情包结构）、
`formatted/texts/<语言>.json`（15 种语言的文案）、`binary/Texture2D/*.png`，以及地图的
`formatted/map.json` + `binary/MapTile/<region>/<R>/<gx>_<gy>.webp`。换域名/换前缀用
`NUXT_PUBLIC_ASSETS_BASE` 覆盖（构建时读取）；站点挂在别的域名下时，记得把该 origin 加进 bucket 的 CORS
规则。界面固定 Material 3 暗色主题，两个页面（顶部导航切换，`/` 与 `/map`，各自懒加载、切页即卸载）：

- **表情包**（`/`）—— 左侧竖向表情包列表 + 右侧网格，可搜索文案/图标名/包名，右上角切换语言。
- **地图**（`/map`）—— 直接画在 canvas 上，可拖拽平移、滚轮缩放（以光标为锚）、双击放大，左上角选区域并显示
  帧耗时/每帧源数据/常驻瓦片数。瓦片按需加载、跨档用父档顶上，所以缩放不会闪白也不会一次拉几百张图。

上游缺的那条文案（`UI_EmotionTagIcon_51` 的名字）在页面上表现为回退到图标名 —— 数据如此，不是站点的问题。
