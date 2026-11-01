/**
 * hc-1132 identity guard (hard rule 11): what the real-profile change must leave alone.
 *
 * Every golden under `__identity__/real-profile-consent/` was recorded on fork
 * main 12fa0a86e9, before any hc-1132 code was written: the consent dialog and
 * the Capabilities toggle, in every language. A diff here means the change
 * reached a screen it should not: fix the code, do not re-record the golden.
 *
 * The ticket's one deliberate difference outside product mode is two sentences
 * of the dialog. `asOnMain` puts main's wording back, each sentence required
 * exactly once, and what remains must match main byte for byte. The last block
 * holds hc-1132 itself.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import {
  installBridge,
  LOCALES,
  OUTSIDE_PRODUCT_MODE,
  removeBridge,
  renderDialog,
  renderPanel,
  seedMode
} from '@/__identity__/real-profile-consent/render'
import type { Locale } from '@/i18n/types'

const GOLDEN = './__identity__/real-profile-consent'

const EN_COPY = [
  [
    "Let APEX's background browser use a snapshot of your signed-in profile. This panel is not affected.",
    'Let Hermes browse with a snapshot of your default browser profile, so sites open already signed in.'
  ],
  [
    'The snapshot stays on this computer, but pages the assistant reads are sent to the model.',
    'Nothing leaves this computer.'
  ]
] as const

const COPY_CHANGE: Record<Locale, readonly (readonly [now: string, onMain: string])[]> = {
  ar: EN_COPY,
  en: EN_COPY,
  ja: [
    [
      'APEX のバックグラウンドブラウザが、ログイン済みの既定プロファイルのスナップショットを使います。アシスタントが開くサイトはログイン済みになります。このパネルには影響しません。',
      'Hermes が既定ブラウザプロファイルのスナップショットでブラウジングできるようにすると、サイトはログイン済みの状態で開きます。'
    ],
    [
      'スナップショットはこのコンピュータにのみ保存されますが、アシスタントが読んだページの内容はモデルに送信されます。',
      'データがこのコンピュータの外に出ることはありません。'
    ]
  ],
  zh: [
    [
      '让 APEX 的后台浏览器使用默认浏览器配置文件的快照，助手打开网站时即已登录。这个面板不受影响。',
      '让 Hermes 使用默认浏览器配置文件的快照进行浏览，网站打开时即已登录。'
    ],
    ['快照只保存在这台电脑上，但助手读到的网页内容会发送给模型。', '所有数据都不会离开这台电脑。']
  ],
  'zh-hant': [
    [
      '讓 APEX 的背景瀏覽器使用預設瀏覽器設定檔的快照，助手開啟網站時即已登入。這個面板不受影響。',
      '讓 Hermes 使用預設瀏覽器設定檔的快照進行瀏覽，網站開啟時即已登入。'
    ],
    ['快照只保存在這台電腦上，但助手讀到的網頁內容會傳送給模型。', '所有資料都不會離開這台電腦。']
  ]
}

function asOnMain(html: string, locale: Locale): string {
  return COPY_CHANGE[locale].reduce((text, [now, onMain]) => {
    expect(text.split(now).length - 1, `${locale}: ${now}`).toBe(1)

    return text.replace(now, onMain)
  }, html)
}

afterEach(() => {
  cleanup()
  removeBridge()
})

describe.each(OUTSIDE_PRODUCT_MODE)('with %s', (_name, flag, toolView) => {
  it.each(LOCALES)('the dialog in %s', async locale => {
    seedMode(flag, toolView)
    installBridge()

    await expect(asOnMain(await renderDialog(locale), locale)).toMatchFileSnapshot(`${GOLDEN}/dialog-${locale}.html`)
  })

  it.each(LOCALES)('the Capabilities toggle in %s', async locale => {
    seedMode(flag, toolView)
    installBridge()

    await expect(await renderPanel(locale)).toMatchFileSnapshot(`${GOLDEN}/toggle-${locale}.html`)
  })

  it('accepting writes the same one key', async () => {
    seedMode(flag, toolView)
    const calls = installBridge({ browser: { allow_private_urls: false, use_real_profile: false } })

    await renderDialog('zh')
    fireEvent.click(screen.getByRole('button', { name: '使用我的配置文件' }))

    await waitFor(() => expect(calls.some(call => call.method === 'PUT')).toBe(true))
    expect(calls.filter(call => call.method === 'PUT')).toEqual([
      { body: { config: { browser: { use_real_profile: true } } }, method: 'PUT', path: '/api/config' }
    ])
  })
})

describe('hc-1132', () => {
  it.each(LOCALES)('product mode offers nothing in %s, and reads nothing to decide', async locale => {
    seedMode(true, 'product')
    const calls = installBridge()

    const html = await renderDialog(locale)

    expect(html).not.toContain('role="dialog"')
    expect(calls).toEqual([])
  })

  it.each(LOCALES)("the dialog in %s neither names Hermes nor repeats main's two claims", async locale => {
    seedMode(true, 'technical')
    installBridge()

    const html = await renderDialog(locale)

    expect(html).toContain('APEX')
    expect(html).not.toContain('Hermes')

    for (const [, onMain] of COPY_CHANGE[locale]) {
      expect(html).not.toContain(onMain)
    }
  })

  // Hard rule 12: count the exits. A new mount or a new writer fails here until someone decides what it does.
  const SRC = join(__dirname)

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap(name => {
      const path = join(dir, name)

      if (statSync(path).isDirectory()) {
        return name === '__identity__' ? [] : sourceFiles(path)
      }

      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [relative(SRC, path)] : []
    })
  }

  function filesMatching(pattern: RegExp): string[] {
    return sourceFiles(SRC)
      .filter(file => pattern.test(readFileSync(join(SRC, file), 'utf8')))
      .sort()
  }

  it('the dialog has one mount', () => {
    expect(filesMatching(/<RealProfileConsentDialog\b/)).toEqual(['app/chat/right-rail/preview-pane.tsx'])
  })

  it('the app root starts the one-time reset at load', () => {
    const code = readFileSync(join(SRC, 'app/contrib/controller.tsx'), 'utf8').replace(/^\s*\/\/.*$/gm, '')

    expect(code).toMatch(/^watchRealProfileReset\(\)$/m)
  })

  it('the setting has these writers and no others', () => {
    expect(filesMatching(/use_real_profile: (?:true|false|on)\b/)).toEqual([
      'app/chat/right-rail/real-profile-consent-dialog.tsx',
      'app/settings/browser-real-profile-panel.tsx',
      'app/single-thread/real-profile-reset.ts'
    ])
  })
})
