/**
 * hc-1109: Settings in single-thread product mode.
 *
 * Product mode keeps eight sections, in this order: 个性化, 记忆, 语音, 通知,
 * 外观, 连接微信和飞书, 用量, 关于. Someone on their own key (「使用自己的密钥」,
 * no APEX account) also keeps 模型 and 提供方: the model is theirs to set, the
 * same rule as the composer's model pill (hc-1015, `$modelChoiceHidden`).
 * 档位, 对话, 工作区, 安全, 浏览器, 密码与登录, 高级, 网关, 键盘快捷键, 工具与密钥,
 * 已归档对话 and the rail's export / import / reset stay in 开发者模式. The switch
 * off and developer mode are untouched.
 *
 * 记忆 is the 它记得什么 ledger here (it used to sit on 个性化); the engine's
 * memory and context knobs are developer settings. 个性化 drops its copy of 关于,
 * which keeps its own section (更新日志 is announced there).
 *
 * The overlay only knows the kept tabs, so every way into a folded one — a
 * hermes://open/settings deep link, a remembered route, a plugin's
 * host.navigate, history, a button on another page — lands on 个性化. The doors
 * product mode still shows fold with their page: ⌘K's settings rows, fields,
 * keys and archived chats (`settingsRowFolded`, through product-fold's palette
 * filter), ⌘/ and ⌘K's Keyboard shortcuts, and the pool-slot error's
 * 打开高级设置.
 */

import { useStore } from '@nanostores/react'
import { computed } from 'nanostores'
import { useCallback } from 'react'

import { useI18n } from '@/i18n'
import { useModelTierCopy } from '@/i18n/model-tier'
import { useSettingsProductCopy } from '@/i18n/settings-product'
import { $modelChoiceHidden } from '@/store/model-choice'
import { useModelTierMode } from '@/store/model-tiers'
import { $singleThreadMode } from '@/store/single-thread'

import { SECTIONS } from './constants'
import type { DesktopConfigSection, SettingsView } from './types'

const PRODUCT_VIEWS: readonly SettingsView[] = [
  'config:personalization',
  'config:memory',
  'config:voice',
  'notifications',
  'config:appearance',
  'im',
  'usage',
  'about'
]

const OWN_KEY_VIEWS: readonly SettingsView[] = [...PRODUCT_VIEWS.slice(0, -1), 'config:model', 'providers', 'about']

/** The tabs product mode keeps, in rail order; null outside product mode, where every tab is as it was. */
export const $productSettingsViews = computed(
  [$singleThreadMode, $modelChoiceHidden],
  (productMode, modelChoiceHidden): null | readonly SettingsView[] =>
    productMode ? (modelChoiceHidden ? PRODUCT_VIEWS : OWN_KEY_VIEWS) : null
)

/** Kept tabs whose product page shows none of the section's config fields: 记忆 is the ledger. */
const FIELDLESS_VIEWS: ReadonlySet<string> = new Set(['config:memory'])

/** Every tab the overlay knows, by base name; a ⌘K row that leads anywhere else is not Settings'. */
const SETTINGS_TABS: ReadonlySet<string> = new Set([
  ...SECTIONS.map(section => `config:${section.id}`),
  'about',
  'billing',
  'connections',
  'gateway',
  'im',
  'keybinds',
  'keys',
  'notifications',
  'providers',
  'sessions',
  'usage',
  'vault'
])

/** Does `tab` (`gateway`, `keys&kview=tools`, `config:memory&field=memory.provider`) open a folded page right now? */
export function settingsTabFolded(tab: string): boolean {
  const views = $productSettingsViews.get()

  if (!views) {
    return false
  }

  const [base, ...params] = tab.split('&')

  return (
    !views.includes(base as SettingsView) || (FIELDLESS_VIEWS.has(base) && params.some(p => p.startsWith('field=')))
  )
}

function fieldTab(key: string): null | string {
  const section = SECTIONS.find(candidate => candidate.keys.includes(key))

  return section ? `config:${section.id}&field=${key}` : null
}

/**
 * The settings tab a ⌘K row opens, read off the row's id (command-palette
 * builds them): `set-config-<section>` / `sp-config-<section>`, `set-<tab>` /
 * `sp-<tab>`, `field-<key>` / `sp-config-field:<key>`, `sp-credential:<key>`,
 * `sp-setting:<appearance id>` and `archived-<session>`. Null for a row that
 * opens anything else.
 */
export function paletteRowSettingsTab(id: string): null | string {
  const field = /^(?:field-|sp-config-field:)(.+)$/.exec(id)

  if (field) {
    return fieldTab(field[1])
  }

  if (id.startsWith('sp-credential:')) {
    return 'keys'
  }

  if (id.startsWith('sp-setting:')) {
    return 'config:appearance'
  }

  if (id.startsWith('archived-')) {
    return 'sessions'
  }

  const page = /^(?:set|sp)-(config-)?(.+)$/.exec(id)
  const tab = page ? `${page[1] ? 'config:' : ''}${page[2]}` : null

  return tab && SETTINGS_TABS.has(tab.split('&')[0]) ? tab : null
}

/** A ⌘K row that opens a page product mode folds right now. */
export function settingsRowFolded(id: string): boolean {
  const tab = paletteRowSettingsTab(id)

  return tab !== null && settingsTabFolded(tab)
}

/** The section's name in the rail and in ⌘K: 档位 in tier mode, 记忆 in product mode. */
export function useSettingsSectionLabel(): (section: DesktopConfigSection) => string {
  const { t } = useI18n()
  const tierMode = useModelTierMode()
  const tierCopy = useModelTierCopy()
  const productMode = useStore($singleThreadMode)
  const copy = useSettingsProductCopy()

  return useCallback(
    (section: DesktopConfigSection) =>
      productMode && section.id === 'memory'
        ? copy.memory
        : tierMode && section.id === 'model'
          ? tierCopy.navLabel
          : (t.settings.sections[section.id] ?? section.label),
    [copy, productMode, t.settings.sections, tierCopy, tierMode]
  )
}
