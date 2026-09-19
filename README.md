# Irminsul

从原神客户端资源里提取贴图与文案、并发布到对象存储的私有工具。只有 `packages/akasha` 一个包：一层很薄的
CLI，把 AnimeStudio（建索引、导出 PNG）、DimbreathBot（表情配置与多语言文案）和 Cloudflare R2（产物落点）
串成一条流水线，解包本身交给上游二进制。

```bash
pnpm install
pnpm akasha --help     # 命令、环境变量、导出规则组

pnpm akasha init       # 下载并解压 AnimeStudio CLI（一次即可）→ .parse/anime-studio/
pnpm akasha build_map  # 建索引（一次即可，全量约 8 分钟 / 54 GB）→ .parse/maps/assets_map.map
pnpm akasha export     # 导出 PNG（日常，复用索引、秒级）→ .parse/export/Texture2D/
pnpm akasha emoji      # 表情配置 + 每语言文案表 → .parse/emoji/
pnpm akasha upload     # 推到 R2 → Static/GI/{formatted,binary}/
```

需要 Windows（上游是 net10.0-windows 构建）、Bun ≥ 1.3.14、原神客户端目录；`.env` 里放 `GENSHIN_DIR`
与上传用的 `R2_*`。各命令的用法见 [`packages/akasha/README.md`](packages/akasha/README.md)。
`.parse/` 里的索引与导出产物是昂贵缓存，别随手删 —— 原因写在 [`AGENTS.md`](AGENTS.md)。
