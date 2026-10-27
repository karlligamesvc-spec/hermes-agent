/**
 * Copy for hc-1078 (multi-bot M2): the new-assistant sheet, the selected row's 「···」 menu and the
 * delete confirmation, as prototype v2 artboard ⑦ (BotNew) words them.
 *
 * Kept beside the main catalogs (they are past the code-health size cap). Each locale is a whole
 * typed object, so a missing zh string is a type error rather than an English fallback; zh, zh-hant
 * and en are complete, ja and ar read en.
 *
 * The delete text says exactly what goes: the profile directory holds the assistant's conversations,
 * the images and videos its tools cached on this computer (`<profile>/cache/media`) and its own copy
 * of the skills. 「关于你」 (the cloud memory ledger), 交付物 (the cloud workflow deliverables) and
 * usage are the account's and stay.
 */

import type { ApexAvatarShape, ApexBotColor } from '@/components/apex-avatar-look'

import { useI18n } from './context'
import type { Locale } from './types'

export interface SingleThreadBotsCopy {
  /** hc-1077's 「+」 atop the sidebar once the limit is reached (its own label otherwise); `max` includes APEX. */
  newBotFull: (max: number) => string
  newTitle: string
  editTitle: (name: string) => string
  previewHint: string
  previewEmpty: string
  nameLabel: string
  namePlaceholder: string
  nameHelp: string
  nameTooLong: (max: number) => string
  nameTaken: string
  shapeLabel: string
  shapes: Record<ApexAvatarShape, string>
  colorLabel: string
  colors: Record<ApexBotColor, string>
  colorHelp: string
  /** Under the fields: what a new assistant shares with APEX. */
  sharedNote: string
  /** 「你已经建了 2 个，还能再建 2 个」: both counts leave APEX out. */
  left: (made: number, left: number) => string
  full: (made: number) => string
  cancel: string
  create: string
  creating: string
  save: string
  saving: string
  createFailed: string
  saveFailed: string
  /** The look was changed elsewhere since the sheet opened; the sheet now shows the newer one. */
  conflict: string
  /** The selected row's 「···」 button. */
  more: (name: string) => string
  edit: string
  /** APEX's menu: its look is fixed (K6), only the name changes. */
  rename: string
  remove: string
  deleteTitle: (name: string) => string
  deleteBody: string
  deleteCancel: string
  deleteConfirm: string
  deleting: string
  deleteFailed: string
}

const en: SingleThreadBotsCopy = {
  newBotFull: max => `You already have ${max} assistants. Delete one to make another.`,
  newTitle: 'New assistant',
  editTitle: name => `Edit ${name}`,
  previewHint: 'This is how it shows in the sidebar',
  previewEmpty: 'No name yet',
  nameLabel: 'Name',
  namePlaceholder: 'e.g. Captions',
  nameHelp: 'Any language. You can also rename it later by telling it in the chat.',
  nameTooLong: max => `At most ${max} characters`,
  nameTaken: 'Another assistant already has this name',
  shapeLabel: 'Shape',
  shapes: {
    circle: 'Circle',
    squircle: 'Rounded',
    pill: 'Pill',
    hexagon: 'Hexagon',
    cloud: 'Cloud',
    drop: 'Drop'
  },
  colorLabel: 'Color',
  colors: { blue: 'Blue', teal: 'Teal', green: 'Green', orange: 'Orange', rose: 'Rose', gold: 'Gold' },
  colorHelp: 'The purple circle is APEX’s.',
  sharedNote: 'It uses the same account and allowance as APEX, and remembers the same “About you”.',
  left: (made, left) => `You have made ${made}; ${left} more to go`,
  full: made => `You already have ${made}. Delete one to make another.`,
  cancel: 'Cancel',
  create: 'Create',
  creating: 'Creating…',
  save: 'Save',
  saving: 'Saving…',
  createFailed: 'That didn’t work. Try again.',
  saveFailed: 'That didn’t save. Try again.',
  conflict: 'It was just changed somewhere else. This shows the latest; make your change again.',
  more: name => `Manage ${name}`,
  edit: 'Rename or restyle',
  rename: 'Rename',
  remove: 'Delete this assistant',
  deleteTitle: name => `Delete “${name}”?`,
  deleteBody:
    'Its conversations, the images and videos it saved on this computer, and its copy of the skills go with it, for good. Your “About you”, your deliverables and your usage stay as they are.',
  deleteCancel: 'Keep it',
  deleteConfirm: 'Delete',
  deleting: 'Deleting…',
  deleteFailed: 'It wasn’t deleted. Try again.'
}

const zh: SingleThreadBotsCopy = {
  newBotFull: max => `已经有 ${max} 个助手了，先删掉一个再建`,
  newTitle: '新建一个助手',
  editTitle: name => `改一下${name}`,
  previewHint: '侧栏里会是这个样子',
  previewEmpty: '还没起名',
  nameLabel: '叫它什么',
  namePlaceholder: '比如：小红书文案',
  nameHelp: '中文、英文都行。以后在对话里说一句「以后叫你……」也能改。',
  nameTooLong: max => `最多 ${max} 个字`,
  nameTaken: '已经有助手叫这个名字了',
  shapeLabel: '样子',
  shapes: {
    circle: '圆',
    squircle: '圆角方',
    pill: '胶囊',
    hexagon: '六边形',
    cloud: '云朵',
    drop: '水滴'
  },
  colorLabel: '颜色',
  colors: { blue: '蓝', teal: '青', green: '绿', orange: '橙', rose: '玫红', gold: '金' },
  colorHelp: '紫色圆是 APEX 的，留给它。',
  sharedNote: '它和 APEX 用同一个账号和额度，记得的「关于你」也是同一份。',
  left: (made, left) => `你已经建了 ${made} 个，还能再建 ${left} 个`,
  full: made => `已经有 ${made} 个了，先删掉一个再建`,
  cancel: '取消',
  create: '建好了',
  creating: '正在建…',
  save: '改好了',
  saving: '正在改…',
  createFailed: '没建成，再试一次。',
  saveFailed: '没改成，再试一次。',
  conflict: '它刚在别处改过，这里已经换成最新的，再改一次。',
  more: name => `管理${name}`,
  edit: '改名或换样子',
  rename: '改名',
  remove: '删除这个助手',
  deleteTitle: name => `删掉「${name}」？`,
  deleteBody:
    '它的对话、它在这台电脑上存的图片和视频、它那份技能会一起删掉，删了找不回来。你的「关于你」、交付物和用量都不受影响。',
  deleteCancel: '先不删',
  deleteConfirm: '删掉',
  deleting: '正在删…',
  deleteFailed: '没删成，再试一次。'
}

const zhHant: SingleThreadBotsCopy = {
  newBotFull: max => `已經有 ${max} 個助手了，先刪掉一個再建`,
  newTitle: '新建一個助手',
  editTitle: name => `改一下${name}`,
  previewHint: '側欄裡會是這個樣子',
  previewEmpty: '還沒起名',
  nameLabel: '叫它什麼',
  namePlaceholder: '比如：小紅書文案',
  nameHelp: '中文、英文都行。以後在對話裡說一句「以後叫你……」也能改。',
  nameTooLong: max => `最多 ${max} 個字`,
  nameTaken: '已經有助手叫這個名字了',
  shapeLabel: '樣子',
  shapes: {
    circle: '圓',
    squircle: '圓角方',
    pill: '膠囊',
    hexagon: '六邊形',
    cloud: '雲朵',
    drop: '水滴'
  },
  colorLabel: '顏色',
  colors: { blue: '藍', teal: '青', green: '綠', orange: '橙', rose: '玫紅', gold: '金' },
  colorHelp: '紫色圓是 APEX 的，留給它。',
  sharedNote: '它和 APEX 用同一個帳號和額度，記得的「關於你」也是同一份。',
  left: (made, left) => `你已經建了 ${made} 個，還能再建 ${left} 個`,
  full: made => `已經有 ${made} 個了，先刪掉一個再建`,
  cancel: '取消',
  create: '建好了',
  creating: '正在建…',
  save: '改好了',
  saving: '正在改…',
  createFailed: '沒建成，再試一次。',
  saveFailed: '沒改成，再試一次。',
  conflict: '它剛在別處改過，這裡已經換成最新的，再改一次。',
  more: name => `管理${name}`,
  edit: '改名或換樣子',
  rename: '改名',
  remove: '刪除這個助手',
  deleteTitle: name => `刪掉「${name}」？`,
  deleteBody:
    '它的對話、它在這台電腦上存的圖片和影片、它那份技能會一起刪掉，刪了找不回來。你的「關於你」、交付物和用量都不受影響。',
  deleteCancel: '先不刪',
  deleteConfirm: '刪掉',
  deleting: '正在刪…',
  deleteFailed: '沒刪成，再試一次。'
}

export const SINGLE_THREAD_BOTS_COPY: Readonly<Record<Locale, SingleThreadBotsCopy>> = {
  ar: en,
  en,
  ja: en,
  zh,
  'zh-hant': zhHant
}

export function useSingleThreadBotsCopy(): SingleThreadBotsCopy {
  return SINGLE_THREAD_BOTS_COPY[useI18n().locale]
}
