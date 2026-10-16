<script setup lang="ts">
/** 表情包页（`/`）：从 `Static/GI/formatted/emoji.json` + `texts/<语言>.json` + `binary/Texture2D/*.png` 读。 */

/** `Static/GI/formatted/emoji.json` 的形态（文案仍是 hash 引用）。 */
type RawConfig = {
  langs: string[];
  sets: {
    id: number;
    icon: string;
    nameTextMapHash: number | null;
    emojis: { id: number; icon: string; contentTextMapHash: number | null }[];
  }[];
};

/** `Static/GI/formatted/texts/<语言>.json` 的形态：hash → 文案。 */
type Texts = Record<string, string>;

/** `url` 在这里就算好：模板里每次重渲染再去拼字符串是白烧 CPU，而且拼出来的串不稳定会让 `src` 被判成变化。 */
type Item = { id: number; icon: string; url: string; text: string | null };
/** 聚合项（全部表情）没有真实的表情包 id 与图标，用 `all` 标记。 */
type Pack = { id: number; icon: string; url: string; name: string | null; emojis: Item[]; all?: true };

/** 聚合项的 id：真实表情包 id 从 1 起（见 emoji.json），不会撞。 */
const ALL_ID = 0;

/** 「全部表情」有 800 多张：一次全挂上去要实例化 800 多个组件，先给一屏，滚到底再续。 */
const CHUNK = 120;

const base = useRuntimeConfig().public.assetsBase.replace(/\/+$/, "");
const assets = (path: string) => `${base}/${path}`;
const iconUrl = (icon: string) => assets(`binary/Texture2D/${icon}.png`);
const textOf = (texts: Texts, hash: number | null) => (hash === null ? null : (texts[String(hash)] ?? null));

const lang = ref("CHS");
const query = ref("");

/**
 * 配置（有哪些包、哪些表情、图标名）与语言无关，文案每语言一份 —— 所以分成两个请求：
 * 首屏两个请求并行（都不 await，谁先到谁先填，`sets` 只等两个都有），切语言只重取文案，
 * 而且 key 里带语言、各自留缓存，切回去不用再取。
 */
const {
  data: config,
  error: configError,
  refresh: refreshConfig,
} = useAsyncData("emoji-config", () => $fetch<RawConfig>(assets("formatted/emoji.json")));
const { data: texts, error: textsError, refresh: refreshTexts } = useAsyncData(
  () => `emoji-texts-${lang.value}`,
  () => $fetch<Texts>(assets(`formatted/texts/${lang.value}.json`)),
);
const failed = computed(() => configError.value ?? textsError.value ?? null);
function retry(): void {
  void refreshConfig();
  void refreshTexts();
}

/** 配置 + 当前语言文案拼出来的包列表；两个都到位才有内容。 */
const sets = computed<Pack[] | null>(() => {
  const raw = config.value;
  const map = texts.value;
  if (!raw || !map) return null;
  return raw.sets.map((set) => ({
    id: set.id,
    icon: set.icon,
    url: iconUrl(set.icon),
    name: textOf(map, set.nameTextMapHash),
    emojis: set.emojis.map((emoji) => ({
      id: emoji.id,
      icon: emoji.icon,
      url: iconUrl(emoji.icon),
      text: textOf(map, emoji.contentTextMapHash),
    })),
  }));
});

const langOptions = computed(() => (config.value?.langs ?? []).map((code) => ({ label: code, value: code })));

const needle = computed(() => query.value.trim().toLowerCase());
/** 搜索命中的表情包（命中包名则整包保留）；没搜索时就是全部。 */
const visible = computed<Pack[]>(() => {
  const all = sets.value ?? [];
  if (needle.value === "") return all;
  const hitItem = (item: Item) =>
    item.icon.toLowerCase().includes(needle.value) || (item.text ?? "").toLowerCase().includes(needle.value);
  const hitPack = (pack: Pack) => (pack.name ?? "").toLowerCase().includes(needle.value);
  return all
    .map((pack) => (hitPack(pack) ? pack : { ...pack, emojis: pack.emojis.filter(hitItem) }))
    .filter((pack) => pack.emojis.length > 0);
});

/** 侧栏与手机端菜单共用的列表：第一项是把当前可见表情聚合成一屏的「全部表情」。 */
const packs = computed<Pack[]>(() => [
  { id: ALL_ID, all: true, icon: "", url: "", name: "全部表情", emojis: visible.value.flatMap((pack) => pack.emojis) },
  ...visible.value,
]);

/** 当前标签：显式选中的那个；被搜索过滤掉（或还没选）时退回第一个可见项。 */
const activeId = ref<number | null>(null);
const active = computed<Pack | null>(
  () => packs.value.find((pack) => pack.id === activeId.value) ?? packs.value[0] ?? null,
);

/** 手机端 `var-menu-select` 的 v-model：读出去掉失效选中项后的标签，写回用户的选择。 */
const selected = computed<number>({
  get: () => active.value?.id ?? ALL_ID,
  set: (id) => {
    activeId.value = id;
  },
});

/** 手机端菜单项：包名 + 该包的表情数（聚合项就是总数）。 */
const packOptions = computed(() =>
  packs.value.map((pack) => ({ label: `${pack.name ?? pack.icon} (${pack.emojis.length})`, value: pack.id })),
);

const total = computed(() => {
  const all = sets.value ?? [];
  return { packs: all.length, emojis: all.reduce((sum, pack) => sum + pack.emojis.length, 0) };
});

/** 本轮渲染到第几张；换包/换语言/改搜索都会换一批内容，重新从一屏开始。 */
const shown = ref(CHUNK);
const shownItems = computed(() => (active.value ? active.value.emojis.slice(0, shown.value) : []));
const more = computed(() => Math.max(0, (active.value?.emojis.length ?? 0) - shown.value));
function showMore(): void {
  shown.value += CHUNK;
}
watch([active, needle], () => {
  shown.value = CHUNK;
});

/** 续渲染：`more` 那行本身当哨兵，滚到附近就再来一屏；按钮是兜底，自动续不动时手动也能看完。 */
const sentinel = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | null = null;
watch(sentinel, (el) => {
  observer?.disconnect();
  if (!el) return;
  observer ??= new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) showMore();
    },
    { rootMargin: "800px" },
  );
  observer.observe(el);
});
onBeforeUnmount(() => observer?.disconnect());

/** 侧栏是原生按钮，鼠标外还要能键盘浏览：上下切包并把焦点带到新的一行。 */
function moveRow(step: number): void {
  const list = packs.value;
  if (list.length === 0) return;
  const index = list.findIndex((pack) => pack.id === active.value?.id);
  const next = list[(index + step + list.length) % list.length]!;
  activeId.value = next.id;
  void nextTick(() => document.getElementById(`tab-${next.id}`)?.focus());
}
</script>

<template>
  <var-loading v-if="!sets && !failed" loading description="加载中…" />
  <var-result
    v-else-if="failed"
    type="error"
    title="加载失败"
    :description="`${failed.message}（资源地址 ${base}，可用 NUXT_PUBLIC_ASSETS_BASE 指向 R2 上的 Static/GI）`"
  >
    <template #footer>
      <var-button type="primary" @click="retry">重试</var-button>
    </template>
  </var-result>
  <var-result
    v-else-if="visible.length === 0"
    type="info"
    title="没有匹配的表情"
    :description="`没有匹配「${query}」的文案、图标名或表情包`"
  />

  <div v-else class="layout">
    <!-- 桌面端：左边竖向排列表情包（手机端由 CSS 换成工具栏里的菜单选择） -->
    <nav
      class="sidebar"
      role="tablist"
      aria-orientation="vertical"
      aria-label="表情包"
      @keydown.down.prevent="moveRow(1)"
      @keydown.up.prevent="moveRow(-1)"
    >
      <button
        v-for="pack in packs"
        :id="`tab-${pack.id}`"
        :key="pack.id"
        type="button"
        class="side-item"
        role="tab"
        :aria-selected="pack.id === active?.id"
        :tabindex="pack.id === active?.id ? 0 : -1"
        @click="activeId = pack.id"
      >
        <var-icon v-if="pack.all" name="view" :size="18" />
        <var-image v-else :src="pack.url" :width="18" :height="18" fit="contain" lazy />
        <span class="label">{{ pack.name ?? pack.icon }}</span>
        <span class="count">{{ pack.emojis.length }}</span>
      </button>
    </nav>

    <section class="content">
      <div class="toolbar">
        <var-menu-select v-model="lang" :options="langOptions" size="small">
          <var-button size="small" text>
            <var-icon name="translate" :size="18" />
            <span class="label">{{ lang }}</span>
          </var-button>
        </var-menu-select>

        <var-input v-model="query" class="search" placeholder="搜索文案 / 图标名 / 表情包" clearable>
          <template #prepend-icon>
            <var-icon name="magnify" />
          </template>
        </var-input>

        <var-menu-select v-model="selected" class="pack-menu" :options="packOptions" :same-width="false" scrollable>
          <var-button text>
            <var-icon v-if="active?.all" name="view" :size="18" />
            <var-image v-else-if="active" :src="active.url" :width="18" :height="18" fit="contain" lazy />
            <span class="label">{{ active?.name ?? active?.icon }}</span>
            <var-icon name="chevron-down" :size="18" />
          </var-button>
        </var-menu-select>

        <span class="count">
          {{ active?.emojis.length ?? 0 }} / {{ total.emojis }} 个表情 · {{ visible.length }} / {{ total.packs }} 个包
        </span>
      </div>

      <main v-if="active" role="tabpanel" :aria-labelledby="`tab-${active.id}`">
        <h2 class="title">
          <var-icon v-if="active.all" name="view" :size="20" />
          <var-image v-else :src="active.url" :width="20" :height="20" fit="contain" lazy />
          <span>{{ active.name ?? active.icon }}</span>
          <span class="count">{{ active.emojis.length }}</span>
        </h2>
        <ul class="grid">
          <li v-for="item in shownItems" :key="item.id">
            <a class="tile" :href="item.url" target="_blank" rel="noopener" :title="item.icon">
              <var-image :src="item.url" :alt="item.text ?? item.icon" fit="contain" lazy />
              <span class="caption">{{ item.text ?? item.icon }}</span>
            </a>
          </li>
        </ul>
        <div v-if="more > 0" ref="sentinel" class="more">
          <var-button text @click="showMore">显示更多（还剩 {{ more }} 个）</var-button>
        </div>
      </main>
    </section>
  </div>
</template>
