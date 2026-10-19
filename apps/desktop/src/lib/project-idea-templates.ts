import { getRuntimeI18nLocale } from '@/i18n/runtime'
import type { Locale } from '@/i18n/types'

// Fun starter ideas for the new-project dialog. Pills prefill IDEA.md; the set
// shown is a random handful from this pool (reshuffled on open / via the dice),
// so creating a project always feels a little playful. Pure content — edit
// freely, order doesn't matter. The Chinese pools say the same ideas in the
// user's language; a locale without its own pool gets the English one.

export interface ProjectIdeaTemplate {
  emoji: string
  label: string
  idea: string
}

export const PROJECT_IDEA_TEMPLATES: ProjectIdeaTemplate[] = [
  {
    emoji: '🎮',
    label: 'Game jam',
    idea: 'A tiny browser game built in a weekend.\n\n- One core mechanic, juicy feedback\n- No build step — single HTML/JS file\n- Playable in under 60 seconds'
  },
  {
    emoji: '📚',
    label: 'Novel',
    idea: 'A novel-in-progress.\n\n- Track chapters, characters, and timeline\n- Daily word-count goal\n- Keep research notes beside the draft'
  },
  {
    emoji: '🤖',
    label: 'Discord bot',
    idea: 'A Discord bot for a small community.\n\n- Slash commands + a fun daily ritual\n- Lightweight persistence\n- Deploy somewhere free'
  },
  {
    emoji: '📊',
    label: 'Data viz',
    idea: 'An interactive visualization of a dataset I care about.\n\n- Pick the dataset and the one question it answers\n- Clean → chart → annotate\n- Shareable as a single page'
  },
  {
    emoji: '🎨',
    label: 'Generative art',
    idea: 'A generative art piece.\n\n- One algorithm, lots of seeds\n- Export high-res stills\n- A gallery of the best outputs'
  },
  {
    emoji: '🍳',
    label: 'Recipe box',
    idea: 'A personal recipe collection.\n\n- Searchable by ingredient and mood\n- Scale servings on the fly\n- Auto-build a shopping list'
  },
  {
    emoji: '🧪',
    label: 'Research log',
    idea: 'A research notebook for an open question.\n\n- Log experiments, results, and dead ends\n- Cite sources inline\n- Weekly synthesis of what I learned'
  },
  {
    emoji: '💸',
    label: 'Budget tracker',
    idea: 'A no-nonsense budget tracker.\n\n- Import transactions, tag them fast\n- Monthly burn vs. plan\n- One chart that tells the truth'
  },
  {
    emoji: '🌱',
    label: 'Habit tracker',
    idea: 'A habit tracker that actually sticks.\n\n- A handful of daily checkboxes\n- Streaks without guilt\n- A calm weekly review'
  },
  {
    emoji: '🗺️',
    label: 'Trip planner',
    idea: 'A trip planner for an upcoming adventure.\n\n- Day-by-day itinerary\n- Map of pins + notes\n- Packing + budget checklist'
  },
  {
    emoji: '🎵',
    label: 'Music toy',
    idea: 'A little music-making toy.\n\n- One instrument or sequencer\n- Web Audio, no installs\n- Record + share a loop'
  },
  {
    emoji: '🧩',
    label: 'Puzzle maker',
    idea: 'A generator for a puzzle I love.\n\n- Procedurally make solvable puzzles\n- Difficulty dial\n- Printable + playable'
  },
  {
    emoji: '📝',
    label: 'Digital garden',
    idea: 'A digital garden / personal wiki.\n\n- Atomic notes that link to each other\n- Grows over time, never "done"\n- Publish the public ones'
  },
  {
    emoji: '🛰️',
    label: 'API wrapper',
    idea: 'A clean wrapper around an API I keep reaching for.\n\n- Typed client + sensible defaults\n- One example per endpoint\n- Publish it'
  },
  {
    emoji: '🏋️',
    label: 'Workout plan',
    idea: 'A workout planner / logger.\n\n- Build a weekly split\n- Log sets fast on mobile\n- Track progress over months'
  },
  {
    emoji: '🧠',
    label: 'Flashcards',
    idea: 'A spaced-repetition flashcard app.\n\n- Quick card capture\n- Simple SM-2 scheduling\n- A daily review that fits in 5 minutes'
  },
  {
    emoji: '✍️',
    label: 'Screenplay',
    idea: 'A short screenplay.\n\n- Logline → beats → scenes\n- Proper format, distraction-free\n- A table read by the end'
  },
  {
    emoji: '🔭',
    label: 'Learn-by-building',
    idea: "A project to learn a thing I've been avoiding.\n\n- Smallest real thing that teaches it\n- Notes on every gotcha\n- A writeup when it works"
  }
]

const PROJECT_IDEA_TEMPLATES_ZH: ProjectIdeaTemplate[] = [
  {
    emoji: '🎮',
    label: '周末小游戏',
    idea: '一个周末就能做完的网页小游戏。\n\n- 只做一个核心玩法，反馈要爽\n- 不用构建，一个网页文件搞定\n- 60 秒内就能上手玩'
  },
  {
    emoji: '📚',
    label: '长篇小说',
    idea: '一部正在写的小说。\n\n- 记下章节、人物和时间线\n- 每天的字数目标\n- 资料笔记和草稿放在一起'
  },
  {
    emoji: '🤖',
    label: '社群机器人',
    idea: '给一个小社群用的聊天机器人。\n\n- 几个斜杠命令，外加一个每天的趣味小仪式\n- 轻量的数据保存\n- 部署在免费的地方'
  },
  {
    emoji: '📊',
    label: '数据可视化',
    idea: '把我关心的一份数据做成可交互的图表。\n\n- 选好数据，和它要回答的那一个问题\n- 清洗 → 出图 → 标注\n- 做成一个可以分享的单页'
  },
  {
    emoji: '🎨',
    label: '生成艺术',
    idea: '一件生成艺术作品。\n\n- 一个算法，很多随机种子\n- 导出高清静帧\n- 把最好的结果做成画廊'
  },
  {
    emoji: '🍳',
    label: '菜谱收藏',
    idea: '我的私人菜谱。\n\n- 按食材和心情搜索\n- 随时调整份量\n- 自动生成购物清单'
  },
  {
    emoji: '🧪',
    label: '研究日志',
    idea: '围绕一个开放问题的研究笔记。\n\n- 记下实验、结果和走不通的路\n- 随文标注来源\n- 每周总结学到了什么'
  },
  {
    emoji: '💸',
    label: '记账本',
    idea: '一个不啰嗦的记账工具。\n\n- 导入流水，快速打标签\n- 每月实际花销对比预算\n- 一张说实话的图表'
  },
  {
    emoji: '🌱',
    label: '习惯打卡',
    idea: '一个真能坚持下去的习惯打卡。\n\n- 每天几个勾选项\n- 记连续天数，但不制造愧疚\n- 每周一次平静的回顾'
  },
  {
    emoji: '🗺️',
    label: '旅行计划',
    idea: '为接下来的旅行做计划。\n\n- 按天排好行程\n- 地图标点加备注\n- 行李和预算清单'
  },
  {
    emoji: '🎵',
    label: '音乐小玩具',
    idea: '一个做音乐的小玩具。\n\n- 一种乐器或一个音序器\n- 网页里直接玩，不用安装\n- 录下一段循环并分享'
  },
  {
    emoji: '🧩',
    label: '谜题生成器',
    idea: '为我喜欢的一种谜题做个生成器。\n\n- 自动生成有解的谜题\n- 难度可以调\n- 能打印，也能直接玩'
  },
  {
    emoji: '📝',
    label: '数字花园',
    idea: '一个数字花园 / 个人知识库。\n\n- 互相链接的小笔记\n- 慢慢长大，永远不算完成\n- 把公开的那部分发布出去'
  },
  {
    emoji: '🛰️',
    label: '接口封装',
    idea: '把我常用的一个接口封装得干净好用。\n\n- 带类型的客户端和合理的默认值\n- 每个接口一个示例\n- 发布出去'
  },
  {
    emoji: '🏋️',
    label: '健身计划',
    idea: '一个健身计划和训练记录。\n\n- 排好每周的训练安排\n- 在手机上快速记下每组\n- 看几个月来的进步'
  },
  {
    emoji: '🧠',
    label: '记忆卡片',
    idea: '一个按遗忘曲线复习的记忆卡片应用。\n\n- 随手记下卡片\n- 简单的间隔复习安排\n- 每天 5 分钟就能复习完'
  },
  {
    emoji: '✍️',
    label: '短剧本',
    idea: '一个短剧本。\n\n- 一句话梗概 → 节拍 → 场景\n- 标准格式，专心写作\n- 写完来一次围读'
  },
  {
    emoji: '🔭',
    label: '边做边学',
    idea: '用一个项目学会我一直在逃避的东西。\n\n- 能教会它的最小真实项目\n- 每个坑都记下来\n- 做成后写一篇总结'
  }
]

const PROJECT_IDEA_TEMPLATES_ZH_HANT: ProjectIdeaTemplate[] = [
  {
    emoji: '🎮',
    label: '週末小遊戲',
    idea: '一個週末就能做完的網頁小遊戲。\n\n- 只做一個核心玩法，回饋要爽\n- 不用建置，一個網頁檔案搞定\n- 60 秒內就能上手玩'
  },
  {
    emoji: '📚',
    label: '長篇小說',
    idea: '一部正在寫的小說。\n\n- 記下章節、人物和時間線\n- 每天的字數目標\n- 資料筆記和草稿放在一起'
  },
  {
    emoji: '🤖',
    label: '社群機器人',
    idea: '給一個小社群用的聊天機器人。\n\n- 幾個斜線指令，外加一個每天的趣味小儀式\n- 輕量的資料儲存\n- 部署在免費的地方'
  },
  {
    emoji: '📊',
    label: '資料視覺化',
    idea: '把我關心的一份資料做成可互動的圖表。\n\n- 選好資料，和它要回答的那一個問題\n- 清理 → 出圖 → 標註\n- 做成一個可以分享的單頁'
  },
  {
    emoji: '🎨',
    label: '生成藝術',
    idea: '一件生成藝術作品。\n\n- 一個演算法，很多隨機種子\n- 匯出高解析靜態圖\n- 把最好的結果做成畫廊'
  },
  {
    emoji: '🍳',
    label: '食譜收藏',
    idea: '我的私人食譜。\n\n- 依食材和心情搜尋\n- 隨時調整份量\n- 自動產生購物清單'
  },
  {
    emoji: '🧪',
    label: '研究日誌',
    idea: '圍繞一個開放問題的研究筆記。\n\n- 記下實驗、結果和走不通的路\n- 隨文標註來源\n- 每週總結學到了什麼'
  },
  {
    emoji: '💸',
    label: '記帳本',
    idea: '一個不囉嗦的記帳工具。\n\n- 匯入明細，快速貼標籤\n- 每月實際花費對照預算\n- 一張說實話的圖表'
  },
  {
    emoji: '🌱',
    label: '習慣打卡',
    idea: '一個真能堅持下去的習慣打卡。\n\n- 每天幾個勾選項目\n- 記連續天數，但不製造愧疚\n- 每週一次平靜的回顧'
  },
  {
    emoji: '🗺️',
    label: '旅行計畫',
    idea: '為接下來的旅行做計畫。\n\n- 按天排好行程\n- 地圖標點加備註\n- 行李和預算清單'
  },
  {
    emoji: '🎵',
    label: '音樂小玩具',
    idea: '一個做音樂的小玩具。\n\n- 一種樂器或一個音序器\n- 網頁裡直接玩，不用安裝\n- 錄下一段循環並分享'
  },
  {
    emoji: '🧩',
    label: '謎題產生器',
    idea: '為我喜歡的一種謎題做個產生器。\n\n- 自動產生有解的謎題\n- 難度可以調\n- 能列印，也能直接玩'
  },
  {
    emoji: '📝',
    label: '數位花園',
    idea: '一個數位花園 / 個人知識庫。\n\n- 互相連結的小筆記\n- 慢慢長大，永遠不算完成\n- 把公開的那部分發布出去'
  },
  {
    emoji: '🛰️',
    label: '介面封裝',
    idea: '把我常用的一個介面封裝得乾淨好用。\n\n- 帶型別的用戶端和合理的預設值\n- 每個介面一個範例\n- 發布出去'
  },
  {
    emoji: '🏋️',
    label: '健身計畫',
    idea: '一個健身計畫和訓練紀錄。\n\n- 排好每週的訓練安排\n- 在手機上快速記下每組\n- 看幾個月來的進步'
  },
  {
    emoji: '🧠',
    label: '記憶卡片',
    idea: '一個依遺忘曲線複習的記憶卡片應用程式。\n\n- 隨手記下卡片\n- 簡單的間隔複習安排\n- 每天 5 分鐘就能複習完'
  },
  {
    emoji: '✍️',
    label: '短劇本',
    idea: '一個短劇本。\n\n- 一句話梗概 → 節拍 → 場景\n- 標準格式，專心寫作\n- 寫完來一次圍讀'
  },
  {
    emoji: '🔭',
    label: '邊做邊學',
    idea: '用一個專案學會我一直在逃避的東西。\n\n- 能教會它的最小真實專案\n- 每個坑都記下來\n- 做成後寫一篇總結'
  }
]

const POOLS: Partial<Record<Locale, ProjectIdeaTemplate[]>> = {
  zh: PROJECT_IDEA_TEMPLATES_ZH,
  'zh-hant': PROJECT_IDEA_TEMPLATES_ZH_HANT
}

// A shuffled slice of the pool — the pills shown at any moment.
export function randomIdeaTemplates(count = 6): ProjectIdeaTemplate[] {
  const pool = [...(POOLS[getRuntimeI18nLocale()] ?? PROJECT_IDEA_TEMPLATES)]

  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))

    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }

  return pool.slice(0, Math.min(count, pool.length))
}
