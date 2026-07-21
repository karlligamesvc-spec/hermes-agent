// hc-554 场景目录 — desktop consumption of the shared scenario catalog.
//
// The cloud master (`GET /api/v1/media/scenario-catalog`, agent-key auth, TTL —
// hc-552) is the single source of truth for the taxonomy + copy (section
// titles, scenario names, one-line sample blurbs, param prompts, live/coming
// status). This module owns only the *desktop presentation* the catalog does
// not carry: an icon and the composer prefill (口令) per scenario. Both degrade
// gracefully — an unknown key falls back to a generic icon + a name-derived
// prefill, so a catalog the cloud grows later still renders without a shell
// update.
//
// When the cloud fetch is unavailable (older main, offline, 401) the UI falls
// back to FALLBACK_CATALOG below, which mirrors the cloud master's content so
// the zero-state shelf + ✦ menu never white-screen.

import {
  BarChart3,
  Brain,
  Eye,
  FileText,
  type IconComponent,
  Layers3,
  MessageCircle,
  MessageSquareText,
  MonitorPlay,
  NotebookTabs,
  Package,
  PencilLine,
  Sparkles,
  Users,
  Wrench
} from '@/lib/icons'

export type ScenarioStatus = 'coming_soon' | 'live'

/** Deterministic route resolved by the cloud (hc-450 intent-router). The
 *  desktop never executes it — the runtime does — but it rides along so a
 *  future desktop consumer (analytics, deep-link) can read the intent. */
export interface ScenarioRoute {
  allowed_tools?: string[]
  args?: Record<string, unknown>
  args_strategy?: unknown
  intent: string
  label: string
  post_hint?: string
  tool: string
}

export interface ScenarioItem {
  coming_soon_note?: string | null
  key: string
  name: string
  /** Server-assigned 1..N across all sections (hc-552 numbering). Optional so a
   *  hand-authored fallback item need not carry it. */
  number?: number
  param_prompt?: string | null
  param_required: boolean
  route?: ScenarioRoute | null
  /** One-line "what you'll get" blurb — the catalog's sample-output summary. */
  sample_ref?: string | null
  status: ScenarioStatus
}

export interface ScenarioSection {
  items: ScenarioItem[]
  key: string
  title: string
}

export interface ScenarioCatalog {
  enabled: boolean
  sections: ScenarioSection[]
  version: string
}

// ---------------------------------------------------------------------------
// Presentation (desktop-owned): icon + composer prefill per scenario key.
// ---------------------------------------------------------------------------

interface ScenarioPresentation {
  icon: IconComponent
  /** Text dropped into the composer when the scenario is picked. Param scenarios
   *  end with a fullwidth colon so the user continues with their link/topic. */
  prefill: string
}

// Keyed by the catalog item `key`. Copy mirrors the Kael-approved v3 prototype
// (HC554-HC555-SCENARIO-V3). Unknown keys degrade via scenarioPresentation().
const SCENARIO_PRESENTATION: Record<string, ScenarioPresentation> = {
  // 社媒
  trending: { icon: BarChart3, prefill: '抖音热榜' },
  single_transcribe: { icon: MonitorPlay, prefill: '拆解这条视频：' },
  benchmark_account: { icon: Users, prefill: '拆解这个对标账号：' },
  batch_viral: { icon: Layers3, prefill: '批量拆解这批爆款：' },
  comments: { icon: MessageCircle, prefill: '分析这条的评论区：' },
  imitate_viral: { icon: PencilLine, prefill: '参考这条仿写一版：' },
  topic_research: { icon: Brain, prefill: '给我的赛道出一批选题：' },
  batch_transcribe_table: { icon: NotebookTabs, prefill: '把这批视频转写落表：' },
  // 电商
  hot_product_analysis: { icon: Package, prefill: '帮我做爆品分析，品类是：' },
  competitor_monitor: { icon: Eye, prefill: '盯住这个竞品：' },
  listing_review: { icon: FileText, prefill: '优化这条 Listing：' },
  customer_service_script: { icon: MessageSquareText, prefill: '帮我写客服话术，场景是：' },
  // 更多
  skill_list: { icon: Wrench, prefill: '有哪些现成能力可以直接用？' }
}

/** Icon for a scenario — its mapped icon, else a generic spark. */
export function scenarioIcon(item: ScenarioItem): IconComponent {
  return SCENARIO_PRESENTATION[item.key]?.icon ?? Sparkles
}

/** Composer prefill (口令) for a scenario. Mapped value wins; otherwise derive
 *  from the name — a param scenario gets a trailing fullwidth colon so the
 *  user knows to append their input, a direct one gets the bare name. */
export function scenarioPrefill(item: ScenarioItem): string {
  const mapped = SCENARIO_PRESENTATION[item.key]?.prefill

  if (mapped) {
    return mapped
  }

  return item.param_required ? `${item.name}：` : item.name
}

/** A scenario is pickable (prefill-able) only when it's live — a coming-soon
 *  item routes to nothing, so picking it would send a command the runtime just
 *  rejects. The UI surfaces its note instead. */
export function isScenarioPickable(item: ScenarioItem): boolean {
  return item.status === 'live'
}

// ---------------------------------------------------------------------------
// Zero-state shelf shaping.
// ---------------------------------------------------------------------------

// The zero-state shelf is a curated hero subset (design ①: 社媒 6 + 电商 3),
// not the whole catalog — the full list lives behind "全部场景 →" and the ✦
// menu. Capping per section by catalog order keeps it data-driven (a reordered
// catalog reorders the shelf) without a shell update; sections with no cap here
// (e.g. 更多) don't appear on the shelf.
export const SHELF_SECTION_LIMITS: Record<string, number> = {
  social: 6,
  ecom: 3
}

/** The sections/items shown on the zero-state shelf: only capped sections, each
 *  trimmed to its limit, preserving catalog order. */
export function shelfSections(catalog: ScenarioCatalog): ScenarioSection[] {
  const shaped: ScenarioSection[] = []

  for (const section of catalog.sections) {
    const limit = SHELF_SECTION_LIMITS[section.key]

    if (limit === undefined) {
      continue
    }

    shaped.push({ ...section, items: section.items.slice(0, limit) })
  }

  return shaped
}

/** Non-empty sections, for the ✦ menu (categories with at least one item). */
export function menuSections(catalog: ScenarioCatalog): ScenarioSection[] {
  return catalog.sections.filter(section => section.items.length > 0)
}

/** Case-insensitive match over a scenario's user-visible text. */
export function scenarioMatchesQuery(item: ScenarioItem, query: string): boolean {
  const q = query.trim().toLowerCase()

  if (!q) {
    return true
  }

  const haystack = `${item.name} ${item.sample_ref ?? ''} ${scenarioPrefill(item)}`.toLowerCase()

  return haystack.includes(q)
}

// ---------------------------------------------------------------------------
// Built-in fallback (mirrors the cloud master content — hc-552 SECTIONS).
// ---------------------------------------------------------------------------

const live = (
  key: string,
  name: string,
  sample_ref: string,
  param_prompt?: string
): ScenarioItem => ({
  key,
  name,
  status: 'live',
  param_required: Boolean(param_prompt),
  param_prompt: param_prompt ?? null,
  sample_ref
})

export const FALLBACK_CATALOG: ScenarioCatalog = {
  enabled: true,
  version: 'fallback',
  sections: [
    {
      key: 'social',
      title: '社媒',
      items: [
        live(
          'trending',
          '热榜',
          '抖音/小红书/微博/B 站/快手/TikTok/Instagram/YouTube/Twitter 共 9 平台热榜直出(默认抖音,想看别的平台直接说平台名)。'
        ),
        live(
          'single_transcribe',
          '拆一条视频',
          '标题、作者、逐字稿一次给全;支持抖音/小红书/快手/B 站等主流平台分享链接。',
          '发来要拆解的视频链接,我直接给你出标题/作者/逐字稿:'
        ),
        live(
          'benchmark_account',
          '拆对标账号',
          '拉取账号主页作品并按互动量排序,再拆出定位/内容结构/钩子/可复用打法。',
          '发来对标账号的主页链接,我去拉取并拆解它的爆款:'
        ),
        live(
          'batch_viral',
          '批量拆爆款',
          '批量转写后逐条分析哪些真的爆了、为什么爆(钩子/前3秒/选题角度)。',
          '发来这批视频的链接(可以多条),我批量转写再帮你找爆点:'
        ),
        live(
          'comments',
          '看评论区',
          '拉取这条作品的评论,按主题/情绪归纳给你,不是干巴巴甩一堆原文。',
          '发来要看评论区的作品链接:'
        ),
        live(
          'imitate_viral',
          '仿写爆款',
          '拆解参考内容的结构和钩子,照着打法给你写一版新的(学打法,不是抄袭)。',
          '发来要参考的爆款链接或文案,再告诉我你要写的主题:'
        ),
        live(
          'topic_research',
          '找选题',
          '按你的定位出一批可执行选题,带角度、标题方向和发布节奏建议。',
          '告诉我你的账号定位/赛道(卖什么、给谁看):'
        ),
        live(
          'batch_transcribe_table',
          '批量转写落表',
          '批量转写后落成表格文件(标题/作者/逐字稿各一列),不用你手动整理。',
          '发来这批视频的链接(可以多条),我转写完直接整理成表格:'
        )
      ]
    },
    {
      key: 'ecom',
      title: '电商',
      items: [
        live(
          'hot_product_analysis',
          '爆品分析',
          '结合公开社媒趋势信号给你一份有依据的选品初判,不臆测数据。',
          '告诉我品类(卖什么类目的):'
        ),
        {
          key: 'competitor_monitor',
          name: '竞品监控',
          status: 'coming_soon',
          param_required: false,
          sample_ref: '持续盯住指定竞品的价格/上新/评价变化,自动提醒。',
          coming_soon_note: '「竞品监控」还在开发中,即将上线;现在可以先用「爆品分析」了解品类趋势。'
        },
        live(
          'listing_review',
          'Listing·评价',
          '优化 Listing 标题/五点/关键词,或从评价里挖出买家动机与可执行改进点。',
          '发来现有 Listing 文案或店铺/商品链接:'
        ),
        live(
          'customer_service_script',
          '客服话术',
          '按场景给可直接发的话术,售前/售后/安抚/补偿都覆盖,不说空话。',
          '告诉我具体场景(比如差评/催发货/退换货),方便的话把原始消息也发来:'
        )
      ]
    },
    {
      key: 'more',
      title: '更多',
      items: [
        live(
          'skill_list',
          '现成 SKILL 列表',
          '查看本助手已内置的常用能力清单,直接说需求即可触发,无需记指令。'
        )
      ]
    }
  ]
}

/** Structural guard for a value fetched over the bridge — the renderer must not
 *  trust an arbitrary main-process return. Returns a well-formed catalog or
 *  null (→ caller uses the fallback). */
export function normalizeScenarioCatalog(raw: unknown): ScenarioCatalog | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }

  const candidate = raw as Partial<ScenarioCatalog>

  if (!Array.isArray(candidate.sections)) {
    return null
  }

  const sections: ScenarioSection[] = []

  for (const section of candidate.sections) {
    if (!section || typeof section !== 'object') {
      continue
    }

    const s = section as Partial<ScenarioSection>

    if (typeof s.key !== 'string' || typeof s.title !== 'string' || !Array.isArray(s.items)) {
      continue
    }

    const items: ScenarioItem[] = []

    for (const item of s.items) {
      if (!item || typeof item !== 'object') {
        continue
      }

      const i = item as Partial<ScenarioItem>

      if (typeof i.key !== 'string' || typeof i.name !== 'string') {
        continue
      }

      items.push({
        key: i.key,
        name: i.name,
        status: i.status === 'coming_soon' ? 'coming_soon' : 'live',
        param_required: Boolean(i.param_required),
        param_prompt: typeof i.param_prompt === 'string' ? i.param_prompt : null,
        sample_ref: typeof i.sample_ref === 'string' ? i.sample_ref : null,
        coming_soon_note: typeof i.coming_soon_note === 'string' ? i.coming_soon_note : null,
        number: typeof i.number === 'number' ? i.number : undefined,
        route: (i.route as ScenarioRoute | null | undefined) ?? null
      })
    }

    sections.push({ key: s.key, title: s.title, items })
  }

  if (sections.length === 0) {
    return null
  }

  return {
    enabled: candidate.enabled !== false,
    version: typeof candidate.version === 'string' ? candidate.version : 'unknown',
    sections
  }
}
