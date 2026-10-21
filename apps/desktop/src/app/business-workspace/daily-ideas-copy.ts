/**
 * Copy for the hc-995 今日点子 section on the Start page. Kept beside the
 * business workspace (like creator-intake-copy.ts) because the locale trees are
 * at their size cap, and typed per locale so a missing key is a compile error,
 * not an English fallback. The cards' own words (title, how, why, source,
 * profile summary) come from the cloud as they are.
 */

import type { DesktopDailyIdeaDislikeReason, DesktopDailyIdeaKind } from '@/global'
import type { Locale } from '@/i18n/types'

export interface DailyIdeasCopy {
  title: string
  /** Profile filled in, and today's hot ideas are among the cards. */
  subtitleHot: (summary: string) => string
  /** Profile filled in, no hot idea on screen (none generated today). */
  subtitleProfile: (summary: string) => string
  /** Today's hot ideas are still being picked. */
  subtitlePending: string
  subtitleNoProfile: string
  more: string
  loadingMore: string
  editProfile: string
  fillProfile: string
  kinds: Record<DesktopDailyIdeaKind, string>
  how: (text: string) => string
  why: (text: string) => string
  showSource: string
  hideSource: string
  sourceRead: (label: string, time: string) => string
  openSource: string
  start: string
  started: string
  dislike: string
  dislikeQuestion: string
  reasons: Record<DesktopDailyIdeaDislikeReason, string>
  cancel: string
  dislikeFailed: string
  startNote: string
  allSeen: string
  backToFirst: string
}

export const DAILY_IDEAS_COPY: Record<Locale, DailyIdeasCopy> = {
  zh: {
    title: '今天能拍的 3 个点子',
    subtitleHot: summary => `按你的档案（${summary}）和今天的热点挑的 · 每天早上 6 点换一批`,
    subtitleProfile: summary => `按你的档案（${summary}）挑的 · 每天早上换一批`,
    subtitlePending: '今天的热点点子正在挑，大约 20 秒。先看看这几个常用的。',
    subtitleNoProfile: '还不知道你做什么内容，先给 3 个谁都能拍的。',
    more: '换一批',
    loadingMore: '正在换…',
    editProfile: '改一下档案',
    fillProfile: '填一下档案',
    kinds: { hot: '今天的热点', structure: '常用结构', own: '你拆过的' },
    how: text => `怎么拍：${text}`,
    why: text => `依据：${text}`,
    showSource: '看来源',
    hideSource: '收起来源',
    sourceRead: (label, time) => `${label} · 今天 ${time} 读取`,
    openSource: '打开原链接',
    start: '开做',
    started: '已开做',
    dislike: '不喜欢',
    dislikeQuestion: '哪里不合适？点一个就换掉',
    reasons: { not_my_direction: '不是我的方向', too_hard: '太难拍', skip_trend: '不想追这个热点' },
    cancel: '算了',
    dislikeFailed: '没换成，再点一次试试。',
    startNote: '点「开做」只会先写口播和分镜给你看，不花生成额度。',
    allSeen: '今天的点子都看过了，明天早上换新的。',
    backToFirst: '回到第一组'
  },
  'zh-hant': {
    title: '今天能拍的 3 個點子',
    subtitleHot: summary => `按你的檔案（${summary}）和今天的熱點挑的 · 每天早上 6 點換一批`,
    subtitleProfile: summary => `按你的檔案（${summary}）挑的 · 每天早上換一批`,
    subtitlePending: '今天的熱點點子正在挑，大約 20 秒。先看看這幾個常用的。',
    subtitleNoProfile: '還不知道你做什麼內容，先給 3 個誰都能拍的。',
    more: '換一批',
    loadingMore: '正在換…',
    editProfile: '改一下檔案',
    fillProfile: '填一下檔案',
    kinds: { hot: '今天的熱點', structure: '常用結構', own: '你拆過的' },
    how: text => `怎麼拍：${text}`,
    why: text => `依據：${text}`,
    showSource: '看來源',
    hideSource: '收起來源',
    sourceRead: (label, time) => `${label} · 今天 ${time} 讀取`,
    openSource: '打開原連結',
    start: '開做',
    started: '已開做',
    dislike: '不喜歡',
    dislikeQuestion: '哪裡不合適？點一個就換掉',
    reasons: { not_my_direction: '不是我的方向', too_hard: '太難拍', skip_trend: '不想追這個熱點' },
    cancel: '算了',
    dislikeFailed: '沒換成，再點一次試試。',
    startNote: '點「開做」只會先寫口播和分鏡給你看，不花生成額度。',
    allSeen: '今天的點子都看過了，明天早上換新的。',
    backToFirst: '回到第一組'
  },
  en: {
    title: '3 ideas you can shoot today',
    subtitleHot: summary => `Picked from your profile (${summary}) and today's trends · New ones every morning at 6`,
    subtitleProfile: summary => `Picked from your profile (${summary}) · New ones every morning`,
    subtitlePending: "Today's trending ideas are still being picked, about 20 seconds. Here are some common ones first.",
    subtitleNoProfile: "We don't know what you make yet, so here are 3 anyone can shoot.",
    more: 'Show others',
    loadingMore: 'Loading…',
    editProfile: 'Edit profile',
    fillProfile: 'Fill in profile',
    kinds: { hot: 'Trending today', structure: 'Proven format', own: 'From your breakdowns' },
    how: text => `How to shoot: ${text}`,
    why: text => `Based on: ${text}`,
    showSource: 'Source',
    hideSource: 'Hide source',
    sourceRead: (label, time) => `${label} · read today at ${time}`,
    openSource: 'Open the original',
    start: 'Start',
    started: 'Started',
    dislike: 'Not for me',
    dislikeQuestion: "What's off? Pick one and it's replaced",
    reasons: { not_my_direction: 'Not my direction', too_hard: 'Too hard to shoot', skip_trend: "Don't want this trend" },
    cancel: 'Never mind',
    dislikeFailed: "That didn't go through. Try again.",
    startNote: 'Start only writes a script and storyboard for you to read first. It uses no generation quota.',
    allSeen: "You've seen all of today's ideas. New ones come tomorrow morning.",
    backToFirst: 'Back to the first set'
  },
  ja: {
    title: '今日撮れるアイデア 3 つ',
    subtitleHot: summary => `あなたのプロフィール（${summary}）と今日のトレンドから選びました · 毎朝 6 時に更新`,
    subtitleProfile: summary => `あなたのプロフィール（${summary}）から選びました · 毎朝更新`,
    subtitlePending: '今日のトレンドのアイデアを選んでいます（約 20 秒）。まずは定番をどうぞ。',
    subtitleNoProfile: 'どんな内容を作るかまだ分からないので、誰でも撮れる 3 つをどうぞ。',
    more: 'ほかを見る',
    loadingMore: '読み込み中…',
    editProfile: 'プロフィールを変更',
    fillProfile: 'プロフィールを入力',
    kinds: { hot: '今日のトレンド', structure: '定番の構成', own: 'あなたの分析から' },
    how: text => `撮り方：${text}`,
    why: text => `根拠：${text}`,
    showSource: '出典',
    hideSource: '出典を閉じる',
    sourceRead: (label, time) => `${label} · 今日 ${time} 取得`,
    openSource: '元のリンクを開く',
    start: '始める',
    started: '開始済み',
    dislike: '合わない',
    dislikeQuestion: 'どこが合いませんか？選ぶと入れ替わります',
    reasons: { not_my_direction: '方向性が違う', too_hard: '撮るのが難しい', skip_trend: 'このトレンドは追わない' },
    cancel: 'やめる',
    dislikeFailed: '入れ替えられませんでした。もう一度お試しください。',
    startNote: '「始める」はまず台本と絵コンテを書くだけで、生成枠は使いません。',
    allSeen: '今日のアイデアはすべて見ました。明日の朝に新しくなります。',
    backToFirst: '最初の組に戻る'
  },
  ar: {
    title: '3 أفكار يمكنك تصويرها اليوم',
    subtitleHot: summary => `مختارة من ملفك (${summary}) ومن رائج اليوم · تتجدد كل صباح الساعة 6`,
    subtitleProfile: summary => `مختارة من ملفك (${summary}) · تتجدد كل صباح`,
    subtitlePending: 'ما زلنا نختار أفكار اليوم الرائجة، نحو 20 ثانية. إليك بعض الأفكار المعتادة أولًا.',
    subtitleNoProfile: 'لا نعرف بعد ما تصنعه، فإليك 3 أفكار يستطيع أي أحد تصويرها.',
    more: 'أفكار أخرى',
    loadingMore: 'جارٍ التحميل…',
    editProfile: 'تعديل الملف',
    fillProfile: 'املأ الملف',
    kinds: { hot: 'رائج اليوم', structure: 'قالب مجرَّب', own: 'من تحليلاتك' },
    how: text => `طريقة التصوير: ${text}`,
    why: text => `السبب: ${text}`,
    showSource: 'المصدر',
    hideSource: 'إخفاء المصدر',
    sourceRead: (label, time) => `${label} · قُرئ اليوم الساعة ${time}`,
    openSource: 'فتح الرابط الأصلي',
    start: 'ابدأ',
    started: 'بدأت',
    dislike: 'لا تناسبني',
    dislikeQuestion: 'ما الذي لا يناسب؟ اختر سببًا لاستبدالها',
    reasons: { not_my_direction: 'ليست في مجالي', too_hard: 'صعبة التصوير', skip_trend: 'لا أريد هذا الرائج' },
    cancel: 'لا يهم',
    dislikeFailed: 'لم يتم الاستبدال. حاول مرة أخرى.',
    startNote: 'زر «ابدأ» يكتب النص ولوحة المشاهد أولًا لتراجعها، ولا يستهلك رصيد التوليد.',
    allSeen: 'رأيت كل أفكار اليوم. تصل أفكار جديدة صباح الغد.',
    backToFirst: 'العودة إلى المجموعة الأولى'
  }
}

/** HH:MM of the moment the cloud read a hot list, or '' when it is unreadable. */
export function dailyIdeaReadTime(observedAt: null | string): string {
  const parsed = observedAt ? new Date(observedAt) : null

  if (!parsed || Number.isNaN(parsed.getTime())) {
    return ''
  }

  return `${String(parsed.getHours()).padStart(2, '0')}:${String(parsed.getMinutes()).padStart(2, '0')}`
}
