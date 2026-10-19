/**
 * Copy for APEX model tiers — Flash / Pro / Max (hc-960).
 *
 * Kept beside the main catalogs instead of inside them: the strings only ever
 * show on an APEX account in tier mode, and the four catalog files are past
 * the code-health size cap (they may only shrink). zh and en are complete;
 * zh-hant has its own copy; ja and ar fall back to en like any missing key.
 * Tier names stay Flash / Pro / Max in every locale, and no string here may
 * name a model.
 */

import { useI18n } from './context'
import { getRuntimeI18nLocale } from './runtime'
import type { Locale } from './types'

export interface ModelTierCopy {
  advancedHint: string
  advancedTitle: string
  availabilityUnknown: string
  comingSoon: string
  comingSoonNotice: (tier: string) => string
  defaultBadge: string
  intro: string
  /** Replaces "Model" wherever a field or a backend line named one. */
  lineLabel: string
  loadFailed: string
  lockedAdvanced: string
  lockedFast: string
  lockedNotice: (tier: string, plan: string) => string
  manageProviders: string
  /** Settings nav entry and ⌘K label for the old model page. */
  navLabel: string
  ownModel: string
  ownModelNotice: string
  planAdvanced: string
  planFast: string
  retryHint: string
  retryStronger: string
  retryStrongerFailed: string
  retryStrongerTip: (tier: string) => string
  saved: (tier: string) => string
  saveFailed: string
  sectionTitle: string
  serviceNotReady: string
  slashHint: string
  tiers: Record<'flash' | 'max' | 'pro', { fit: string; tagline: string }>
}

const en: ModelTierCopy = {
  advancedHint: 'Custom endpoints and your own keys live here. You don’t need them to use APEX.',
  advancedTitle: 'Advanced: your own model service',
  availabilityUnknown: 'Couldn’t check which tiers this account has. Flash works meanwhile.',
  comingSoon: 'Coming soon',
  comingSoonNotice: tier => `${tier} is not open yet.`,
  defaultBadge: 'Default',
  intro:
    'No model to pick. APEX matches each tier to the model that works best for what it costs, and swaps in better ones without you changing anything here.',
  lineLabel: 'Tier',
  loadFailed: 'Couldn’t read which tier this assistant uses.',
  lockedAdvanced: 'Advanced plan and up',
  lockedFast: 'Fast plan and up',
  lockedNotice: (tier, plan) => `${tier} needs the ${plan} or higher.`,
  manageProviders: 'Manage your own model services',
  navLabel: 'Tier',
  ownModel: 'Your own model service',
  ownModelNotice:
    'This assistant runs on your own model service (set under Advanced below). Pick a tier to switch back to APEX.',
  planAdvanced: 'Advanced plan',
  planFast: 'Fast plan',
  retryHint: 'Not happy with an answer? Use “Try a stronger tier” under it.',
  retryStronger: 'Try a stronger tier',
  retryStrongerFailed: 'Couldn’t switch to a stronger tier. Try again.',
  retryStrongerTip: tier => `Answer this turn again on ${tier}`,
  saved: tier => `Switched to ${tier}. New chats use it.`,
  saveFailed: 'Couldn’t switch tiers. Try again.',
  sectionTitle: 'Which tier this assistant uses',
  serviceNotReady: 'Tiers are not live yet. Flash works meanwhile.',
  slashHint:
    'There is no model to pick. Choose Flash, Pro or Max under Settings → Tier, or in an assistant’s settings.',
  tiers: {
    flash: { fit: 'Topic ideas, viral breakdowns, script edits', tagline: 'Fast, enough for every day' },
    max: { fit: 'The pieces that matter most', tagline: 'The strongest' },
    pro: { fit: 'Long-video breakdowns, brand scripts, multi-step jobs', tagline: 'Thinks harder' }
  }
}

const zh: ModelTierCopy = {
  advancedHint: '自定义端点和自己的密钥放在这里。不设置也能正常使用 APEX。',
  advancedTitle: '高级：用自己的模型服务',
  availabilityUnknown: '暂时查不到这个账号能用哪几档，先用 Flash。',
  comingSoon: '即将开放',
  comingSoonNotice: tier => `${tier} 档还没开放。`,
  defaultBadge: '默认',
  intro: '不用选模型。每一档背后用哪个模型，由 APEX 按效果和成本配好；以后换了更好的，你这里什么都不用改。',
  lineLabel: '档位',
  loadFailed: '读不到这个助手现在用哪一档。',
  lockedAdvanced: '高级版起可用',
  lockedFast: '快速版起可用',
  lockedNotice: (tier, plan) => `${tier} 档需要${plan}或以上。`,
  manageProviders: '管理自己的模型服务',
  navLabel: '档位',
  ownModel: '自己的模型服务',
  ownModelNotice: '这个助手正在用你自己的模型服务（在下面“高级”里设置）。选一档就换回 APEX。',
  planAdvanced: '高级版',
  planFast: '快速版',
  retryHint: '回答不满意时，点回答下面的“换更强的再答一次”。',
  retryStronger: '换更强的再答一次',
  retryStrongerFailed: '没换成更强的一档，请再试一次。',
  retryStrongerTip: tier => `用 ${tier} 档重新回答这一轮`,
  saved: tier => `已换成 ${tier} 档，新对话开始生效。`,
  saveFailed: '没换成，请再试一次。',
  sectionTitle: '这个助手用哪一档',
  serviceNotReady: '档位服务还没上线，先用 Flash。',
  slashHint: '不用选模型。要换档，在“设置 → 档位”或助手的编辑里选 Flash、Pro 或 Max。',
  tiers: {
    flash: { fit: '写选题、拆爆款、改脚本都够', tagline: '快，日常够用' },
    max: { fit: '最重要的稿子', tagline: '最强' },
    pro: { fit: '长视频拆解、商单脚本、多步骤的大任务', tagline: '更会想' }
  }
}

const zhHant: ModelTierCopy = {
  advancedHint: '自訂端點和自己的金鑰放在這裡。不設定也能正常使用 APEX。',
  advancedTitle: '進階：用自己的模型服務',
  availabilityUnknown: '暫時查不到這個帳號能用哪幾檔，先用 Flash。',
  comingSoon: '即將開放',
  comingSoonNotice: tier => `${tier} 檔還沒開放。`,
  defaultBadge: '預設',
  intro: '不用選模型。每一檔背後用哪個模型，由 APEX 按效果和成本配好；以後換了更好的，你這裡什麼都不用改。',
  lineLabel: '檔位',
  loadFailed: '讀不到這個助手現在用哪一檔。',
  lockedAdvanced: '進階版起可用',
  lockedFast: '快速版起可用',
  lockedNotice: (tier, plan) => `${tier} 檔需要${plan}或以上。`,
  manageProviders: '管理自己的模型服務',
  navLabel: '檔位',
  ownModel: '自己的模型服務',
  ownModelNotice: '這個助手正在用你自己的模型服務（在下面「進階」裡設定）。選一檔就換回 APEX。',
  planAdvanced: '進階版',
  planFast: '快速版',
  retryHint: '回答不滿意時，點回答下面的「換更強的再答一次」。',
  retryStronger: '換更強的再答一次',
  retryStrongerFailed: '沒換成更強的一檔，請再試一次。',
  retryStrongerTip: tier => `用 ${tier} 檔重新回答這一輪`,
  saved: tier => `已換成 ${tier} 檔，新對話開始生效。`,
  saveFailed: '沒換成，請再試一次。',
  sectionTitle: '這個助手用哪一檔',
  serviceNotReady: '檔位服務還沒上線，先用 Flash。',
  slashHint: '不用選模型。要換檔，在「設定 → 檔位」或助手的編輯裡選 Flash、Pro 或 Max。',
  tiers: {
    flash: { fit: '寫選題、拆爆款、改腳本都夠', tagline: '快，日常夠用' },
    max: { fit: '最重要的稿子', tagline: '最強' },
    pro: { fit: '長影片拆解、商單腳本、多步驟的大任務', tagline: '更會想' }
  }
}

export const MODEL_TIER_COPY: Readonly<Record<Locale, ModelTierCopy>> = {
  ar: en,
  en,
  ja: en,
  zh,
  'zh-hant': zhHant
}

/** Tier copy in the window's language. */
export function useModelTierCopy(): ModelTierCopy {
  return MODEL_TIER_COPY[useI18n().locale] ?? en
}

/** Tier copy outside React (slash output, a notification from a callback). */
export function modelTierCopyNow(): ModelTierCopy {
  return MODEL_TIER_COPY[getRuntimeI18nLocale()] ?? en
}
