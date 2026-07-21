// Render-layer localization for generation-ladder cards, keyed by the protocol's
// stable ids (step keys, card types, action ids) — the "按 id 映射自己的文案"
// contract from the protocol §2/§5. The card's own `language` field (not the app
// UI locale) drives which bundle is used, so switching the ladder language
// relocalizes the card independently of the rest of the app.
//
// Anything the server sends is zh reference text; every non-zh string a user
// sees here is produced by this table. When an id is absent from the table the
// card falls back to the server-provided label/title/body (zh) — the protocol's
// sanctioned default — so an unknown or newer id degrades to readable text
// rather than breaking.

import type { GenLadderLocale } from '@/lib/gen-ladder'

export interface GenLadderCopy {
  // aria label for the whole card region.
  region: string
  // by ladder step `key`.
  steps: Partial<Record<string, string>>
  // by card `type`.
  titles: Partial<Record<string, string>>
  // by card `type`.
  bodies: Partial<Record<string, string>>
  // by action `id`.
  actions: Partial<Record<string, string>>
  // entry-card sub-labels, by action `id`.
  entryDesc: Partial<Record<string, string>>
  // protocol language code → its endonym, for the language switcher.
  languageNames: Partial<Record<string, string>>
  generating: string
  estimated: string
  estimatedAria: string
  languageLabel: string
  referenceLabel: string
  moreLikeOriginal: string
  gateBlocked: string
  billTitle: string
  billLadder: string
  billDirect: string
  billNote: string
  attempts: (n: number) => string
  sending: string
  unsupported: string
  // follow-up message the render layer submits as the user's turn when a control
  // is used (the agent replays it into the `gen_ladder` tool).
  confirmMessage: (label: string) => string
  selectMessage: (index: number) => string
  startMessage: (label: string) => string
  freeMessage: (label: string) => string
  acknowledgeMessage: string
  restartMessage: string
  setLanguageMessage: (language: string) => string
}

const LANGUAGE_NAMES: Partial<Record<string, string>> = {
  zh: '简体中文',
  'zh-TW': '繁體中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어'
}

const zh: GenLadderCopy = {
  region: '生成阶梯卡片',
  steps: { prompt: '提示词', draft: '图草稿', refine: '精修', fork: '高清图/视频预览', final: '成品视频' },
  titles: {
    entry: '要做图还是做视频?三种开始方式',
    prompt: '反推提示词 · 每行可改,免费',
    draft_select: '图片草稿 · 选方向',
    fork: '构图已用选中草稿锁定(refs)。接下来:',
    video_preview: '视频预览 · 5s / 480P',
    final: '成品已出。',
    reference_gate: '参考图涉及真人 · 需确认',
    expired: '这条生成会话已过期,重新开始一条阶梯即可。'
  },
  bodies: {
    draft_select: '不满意?回上一档改提示词再出 4 张(仍是便宜档)—— 贵的成品档还没花钱。',
    video_preview: '镜头运动方向不对?改分镜提示词再预览(仍是预览价)。'
  },
  actions: {
    entry_text: '💬 描述想法',
    entry_image: '🖼 传图复刻',
    entry_video: '🎬 传视频复刻',
    confirm_draft: '出 4 张草稿',
    edit_prompt: '继续改提示词',
    acknowledge_rights: '我拥有授权,继续',
    select_draft: '选这张',
    back: '回上一档改(便宜)',
    confirm_hd_image: '出高清成品图',
    confirm_video_preview: '🎬 让它动起来',
    confirm_refine: '先精修细节',
    confirm_final_video: '✓ 方向对,出成品',
    restart: '重新开始'
  },
  entryDesc: {
    entry_text: '说人话,我来写提示词',
    entry_image: '竞品爆款图 → 换成你的货',
    entry_video: '爆款视频 → 反推分镜 → 重拍'
  },
  languageNames: LANGUAGE_NAMES,
  generating: '生成中…',
  estimated: '示意',
  estimatedAria: '示意估算价,非确定收费',
  languageLabel: '语言',
  referenceLabel: '参考图',
  moreLikeOriginal: '更像原图',
  gateBlocked: '阶梯已挡住升档;优先改用虚构人物,或在你确认拥有授权时放行。',
  billTitle: '账单(示意估算)',
  billLadder: '本次阶梯全程',
  billDirect: '若直接烧成品档试错',
  billNote: '账单为示意估算,实价随定价核准后进 catalog。',
  attempts: n => `${n} 次尝试`,
  sending: '已发送',
  unsupported: '这张生成卡片当前版本暂不支持展示,请在对话中继续。',
  confirmMessage: label => `确认:${label}`,
  selectMessage: index => `选第 ${index + 1} 张草稿`,
  startMessage: label => `开始:${label}`,
  freeMessage: label => label,
  acknowledgeMessage: '我确认拥有该素材的授权,继续。',
  restartMessage: '重新开始一条生成阶梯。',
  setLanguageMessage: language => `切换生成语言:${LANGUAGE_NAMES[language] ?? language}`
}

const zhHant: GenLadderCopy = {
  region: '生成階梯卡片',
  steps: { prompt: '提示詞', draft: '圖草稿', refine: '精修', fork: '高清圖/影片預覽', final: '成品影片' },
  titles: {
    entry: '要做圖還是做影片?三種開始方式',
    prompt: '反推提示詞 · 每行可改,免費',
    draft_select: '圖片草稿 · 選方向',
    fork: '構圖已用選中草稿鎖定(refs)。接下來:',
    video_preview: '影片預覽 · 5s / 480P',
    final: '成品已出。',
    reference_gate: '參考圖涉及真人 · 需確認',
    expired: '這條生成工作階段已過期,重新開始一條階梯即可。'
  },
  bodies: {
    draft_select: '不滿意?回上一檔改提示詞再出 4 張(仍是便宜檔)—— 貴的成品檔還沒花錢。',
    video_preview: '鏡頭運動方向不對?改分鏡提示詞再預覽(仍是預覽價)。'
  },
  actions: {
    entry_text: '💬 描述想法',
    entry_image: '🖼 傳圖複刻',
    entry_video: '🎬 傳影片複刻',
    confirm_draft: '出 4 張草稿',
    edit_prompt: '繼續改提示詞',
    acknowledge_rights: '我擁有授權,繼續',
    select_draft: '選這張',
    back: '回上一檔改(便宜)',
    confirm_hd_image: '出高清成品圖',
    confirm_video_preview: '🎬 讓它動起來',
    confirm_refine: '先精修細節',
    confirm_final_video: '✓ 方向對,出成品',
    restart: '重新開始'
  },
  entryDesc: {
    entry_text: '說人話,我來寫提示詞',
    entry_image: '競品爆款圖 → 換成你的貨',
    entry_video: '爆款影片 → 反推分鏡 → 重拍'
  },
  languageNames: LANGUAGE_NAMES,
  generating: '生成中…',
  estimated: '示意',
  estimatedAria: '示意估算價,非確定收費',
  languageLabel: '語言',
  referenceLabel: '參考圖',
  moreLikeOriginal: '更像原圖',
  gateBlocked: '階梯已擋住升檔;優先改用虛構人物,或在你確認擁有授權時放行。',
  billTitle: '帳單(示意估算)',
  billLadder: '本次階梯全程',
  billDirect: '若直接燒成品檔試錯',
  billNote: '帳單為示意估算,實價隨定價核准後進 catalog。',
  attempts: n => `${n} 次嘗試`,
  sending: '已發送',
  unsupported: '這張生成卡片目前版本暫不支援顯示,請在對話中繼續。',
  confirmMessage: label => `確認:${label}`,
  selectMessage: index => `選第 ${index + 1} 張草稿`,
  startMessage: label => `開始:${label}`,
  freeMessage: label => label,
  acknowledgeMessage: '我確認擁有該素材的授權,繼續。',
  restartMessage: '重新開始一條生成階梯。',
  setLanguageMessage: language => `切換生成語言:${LANGUAGE_NAMES[language] ?? language}`
}

const en: GenLadderCopy = {
  region: 'Generation ladder card',
  steps: { prompt: 'Prompt', draft: 'Drafts', refine: 'Refine', fork: 'HD image / video preview', final: 'Final video' },
  titles: {
    entry: 'Image or video? Three ways to start',
    prompt: 'Reversed prompt · edit any line, free',
    draft_select: 'Draft images · pick a direction',
    fork: 'Composition locked to the picked draft (refs). Next:',
    video_preview: 'Video preview · 5s / 480P',
    final: 'Final result is ready.',
    reference_gate: 'Reference contains a real person · confirm needed',
    expired: 'This generation session has expired — start a new ladder to continue.'
  },
  bodies: {
    draft_select:
      'Not quite? Step back and tweak the prompt for four more (still the cheap tier) — the expensive final tier is untouched.',
    video_preview: 'Motion direction off? Adjust the shot prompt and preview again (still preview price).'
  },
  actions: {
    entry_text: '💬 Describe an idea',
    entry_image: '🖼 Replicate from an image',
    entry_video: '🎬 Replicate from a video',
    confirm_draft: 'Generate 4 drafts',
    edit_prompt: 'Keep editing the prompt',
    acknowledge_rights: 'I hold the rights — continue',
    select_draft: 'Pick this one',
    back: 'Step back (cheap)',
    confirm_hd_image: 'Render HD image',
    confirm_video_preview: '🎬 Bring it to life',
    confirm_refine: 'Refine details first',
    confirm_final_video: '✓ Direction is right — render final',
    restart: 'Start over'
  },
  entryDesc: {
    entry_text: 'Say it plainly — I write the prompt',
    entry_image: 'A rival hit image → swap in your product',
    entry_video: 'A hit video → reverse the shots → reshoot'
  },
  languageNames: LANGUAGE_NAMES,
  generating: 'Generating…',
  estimated: 'est.',
  estimatedAria: 'Estimated price, not a firm charge',
  languageLabel: 'Language',
  referenceLabel: 'Reference',
  moreLikeOriginal: 'Closer to the original',
  gateBlocked:
    'The ladder is holding this step. Switch to a fictional subject, or continue only if you confirm you hold the rights.',
  billTitle: 'Bill (estimated)',
  billLadder: 'This ladder, all in',
  billDirect: 'If you iterated on the final tier directly',
  billNote: 'The bill is an estimate; real prices land in the catalog once pricing is approved.',
  attempts: n => `${n} attempt${n === 1 ? '' : 's'}`,
  sending: 'Sent',
  unsupported: 'This generation card is not supported in this version — continue in the conversation.',
  confirmMessage: label => `Confirm: ${label}`,
  selectMessage: index => `Pick draft #${index + 1}`,
  startMessage: label => `Start: ${label}`,
  freeMessage: label => label,
  acknowledgeMessage: 'I confirm I hold the rights to this reference. Continue.',
  restartMessage: 'Start a new generation ladder.',
  setLanguageMessage: language => `Switch generation language to ${LANGUAGE_NAMES[language] ?? language}`
}

const ja: GenLadderCopy = {
  region: '生成ラダーカード',
  steps: { prompt: 'プロンプト', draft: '下書き', refine: '仕上げ', fork: 'HD画像/動画プレビュー', final: '完成動画' },
  titles: {
    entry: '画像か動画か?3つの始め方',
    prompt: '逆算プロンプト · 各行編集可、無料',
    draft_select: '下書き画像 · 方向を選ぶ',
    fork: '選んだ下書きで構図を固定(refs)。次は:',
    video_preview: '動画プレビュー · 5s / 480P',
    final: '完成しました。',
    reference_gate: '参照画像に実在の人物 · 確認が必要',
    expired: 'この生成セッションは期限切れです。新しいラダーで続けてください。'
  },
  bodies: {
    draft_select: 'いまいち?前の段に戻ってプロンプトを直し、もう4枚(まだ安い段)—— 高い完成段はまだ課金なし。',
    video_preview: '動きの方向が違う?ショットのプロンプトを直して再プレビュー(プレビュー価格のまま)。'
  },
  actions: {
    entry_text: '💬 アイデアを説明',
    entry_image: '🖼 画像から複製',
    entry_video: '🎬 動画から複製',
    confirm_draft: '下書きを4枚生成',
    edit_prompt: 'プロンプトを編集し続ける',
    acknowledge_rights: '権利を持っています — 続行',
    select_draft: 'これを選ぶ',
    back: '前に戻る(安い)',
    confirm_hd_image: 'HD画像を生成',
    confirm_video_preview: '🎬 動かす',
    confirm_refine: 'まず細部を仕上げる',
    confirm_final_video: '✓ 方向OK — 完成を生成',
    restart: '最初からやり直す'
  },
  entryDesc: {
    entry_text: '普通に言ってください、プロンプトは私が書きます',
    entry_image: '競合のヒット画像 → あなたの商品に差し替え',
    entry_video: 'ヒット動画 → ショットを逆算 → 撮り直し'
  },
  languageNames: LANGUAGE_NAMES,
  generating: '生成中…',
  estimated: '目安',
  estimatedAria: '目安の価格で、確定料金ではありません',
  languageLabel: '言語',
  referenceLabel: '参照画像',
  moreLikeOriginal: '元画像に近づける',
  gateBlocked: 'ラダーがこの段を保留中です。架空の人物に変えるか、権利を持つと確認できる場合のみ続行してください。',
  billTitle: '明細(目安)',
  billLadder: '今回のラダー合計',
  billDirect: '完成段で直接試行した場合',
  billNote: '明細は目安です。価格が承認され次第カタログに反映されます。',
  attempts: n => `${n} 回の試行`,
  sending: '送信済み',
  unsupported: 'この生成カードはこのバージョンでは表示できません。会話で続けてください。',
  confirmMessage: label => `確認:${label}`,
  selectMessage: index => `下書き #${index + 1} を選ぶ`,
  startMessage: label => `開始:${label}`,
  freeMessage: label => label,
  acknowledgeMessage: 'この参照素材の権利を持っていることを確認します。続行します。',
  restartMessage: '新しい生成ラダーを開始します。',
  setLanguageMessage: language => `生成言語を ${LANGUAGE_NAMES[language] ?? language} に切り替える`
}

const GEN_LADDER_COPY: Record<GenLadderLocale, GenLadderCopy> = {
  zh,
  'zh-hant': zhHant,
  en,
  ja
}

export function genLadderCopy(locale: GenLadderLocale): GenLadderCopy {
  return GEN_LADDER_COPY[locale]
}
