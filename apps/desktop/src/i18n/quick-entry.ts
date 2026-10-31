/**
 * Copy for Quick Entry — the global-shortcut mini window and its two rows in
 * Settings › Advanced (hc-1001).
 *
 * Kept beside the main catalogs instead of inside them, like model-tier.ts: the
 * four catalog files are past the code-health size cap (they may only shrink).
 * Every locale here is a complete object, so a missing Chinese string is a type
 * error instead of a silent English fallback. zh, zh-hant and en are complete;
 * ar keeps its own Settings rows; ja falls back to en like any missing key. The
 * product is APEX in every locale, never Hermes.
 *
 * The mini window has no I18nProvider and no gateway: it learns the app's
 * language from the primary window through localStorage (same origin, so the
 * `storage` event reaches it live), which also means it already knows the
 * language on its very first paint instead of waiting for an IPC push.
 */

import { useEffect, useState } from 'react'

import { readKey, writeKey } from '@/lib/storage'

import { useI18n } from './context'
import { isSupportedLocaleValue, normalizeLocale } from './languages'
import type { Locale } from './types'

export interface QuickEntryWindowCopy {
  /** Shown in the input when the main window has no gateway connection. */
  disconnected: string
  /** Screen-reader name of the input. */
  inputLabel: string
  /** Target option: the chat the main window has in front. */
  currentChat: string
  /** Target option: start a new one for this prompt. */
  newSession: string
  placeholder: string
  /** Screen-reader name of the target picker. */
  targetLabel: string
  /** The visible word in front of the target picker. */
  sendTo: string
  /** A recent session with neither a title nor a preview. */
  untitled: string
  /** hc-1113: why a line came back into the input instead of reaching the assistant. */
  notDelivered: QuickEntryNotDeliveredCopy
}

/**
 * The sentence under the input when a line did not land. In `busy`, `switch`
 * and `retry`, APEX is the assistant and gets swapped for the name on screen
 * (withBotName); in `noWindow` it is the app and stays.
 */
export interface QuickEntryNotDeliveredCopy {
  /** A turn is still running there. */
  busy: string
  /** The main window is closed, so nothing could take it. */
  noWindow: string
  /** Anything else: not taken, not answered, an error. */
  retry: string
  /** The assistant it was typed to could not be opened. */
  switch: string
}

export interface QuickEntrySettingsCopy {
  active: string
  enabledDesc: string
  enabledTitle: string
  invalidShortcut: string
  shortcutDesc: string
  shortcutTitle: string
  takenBy: string
}

export interface QuickEntryCopy {
  settings: QuickEntrySettingsCopy
  window: QuickEntryWindowCopy
}

const en: QuickEntryCopy = {
  settings: {
    active: 'Shortcut is active.',
    enabledDesc: 'Summon a small composer from anywhere with a global shortcut and fire a prompt without opening APEX.',
    enabledTitle: 'Quick Entry',
    invalidShortcut: 'Not a valid shortcut. Include at least one modifier key.',
    shortcutDesc: 'Needs at least one modifier, e.g. CommandOrControl+Shift+Space.',
    shortcutTitle: 'Quick Entry shortcut',
    takenBy: 'Another app already uses this shortcut — pick a different one.'
  },
  window: {
    currentChat: 'Current chat',
    disconnected: 'Not connected — open APEX to reconnect',
    inputLabel: 'Quick Entry',
    newSession: 'New session',
    placeholder: 'Ask APEX…',
    sendTo: 'Send to',
    targetLabel: 'Target session',
    untitled: 'Untitled session',
    notDelivered: {
      busy: 'APEX is still answering, so this wasn’t sent. Press Enter again once it’s done.',
      noWindow: 'The APEX window is closed, so this wasn’t sent. Open APEX, then press Enter.',
      retry: 'This didn’t reach APEX. Press Enter to try again.',
      switch: 'Couldn’t open APEX, so this wasn’t sent. Press Enter to try again.'
    }
  }
}

const zh: QuickEntryCopy = {
  settings: {
    active: '快捷键已生效。',
    enabledDesc: '在任何地方按全局快捷键，唤出一个小输入框，不用打开 APEX 就能发一句话。',
    enabledTitle: '快速输入',
    invalidShortcut: '快捷键格式不对，至少要带一个修饰键。',
    // The field itself shows the current chord, which is the example to copy.
    shortcutDesc: '照着框里的写法：修饰键在前、按键在后，用加号连接，至少带一个修饰键。',
    shortcutTitle: '快速输入快捷键',
    takenBy: '这个快捷键已被别的应用占用，请换一个。'
  },
  window: {
    currentChat: '当前会话',
    disconnected: '未连接，打开 APEX 重新连接',
    inputLabel: '快速输入',
    newSession: '新建会话',
    placeholder: '问 APEX 点什么…',
    sendTo: '发到',
    targetLabel: '发到哪个会话',
    untitled: '无标题会话',
    notDelivered: {
      busy: 'APEX 还在回上一条，这句还没发。等它说完再按回车。',
      noWindow: 'APEX 主窗口没开着，这句没发出去。打开 APEX 再按回车。',
      retry: '这句没送到 APEX。再按一次回车试试。',
      switch: '没能打开 APEX，这句还没发。再按一次回车试试。'
    }
  }
}

const zhHant: QuickEntryCopy = {
  settings: {
    active: '快捷鍵已生效。',
    enabledDesc: '在任何地方按全域快捷鍵，喚出一個小輸入框，不用開啟 APEX 就能傳一句話。',
    enabledTitle: '快速輸入',
    invalidShortcut: '快捷鍵格式不對，至少要帶一個修飾鍵。',
    shortcutDesc: '照著框裡的寫法：修飾鍵在前、按鍵在後，用加號連接，至少帶一個修飾鍵。',
    shortcutTitle: '快速輸入快捷鍵',
    takenBy: '這個快捷鍵已被別的應用程式占用，請換一個。'
  },
  window: {
    currentChat: '目前的工作階段',
    disconnected: '未連線，開啟 APEX 重新連線',
    inputLabel: '快速輸入',
    newSession: '新工作階段',
    placeholder: '問 APEX 點什麼…',
    sendTo: '傳送到',
    targetLabel: '傳送到哪個工作階段',
    untitled: '未命名工作階段',
    notDelivered: {
      busy: 'APEX 還在回覆上一則，這句還沒傳出去。等它說完再送出一次。',
      noWindow: 'APEX 主視窗沒有開著，這句沒傳出去。開啟 APEX 後再送出一次。',
      retry: '這句沒送到 APEX。再送出一次試試。',
      switch: '沒能開啟 APEX，這句還沒傳出去。再送出一次試試。'
    }
  }
}

const ar: QuickEntryCopy = {
  settings: {
    active: 'الاختصار مفعّل.',
    enabledDesc: 'استدعِ محرّرا صغيرا من أي مكان باختصار عام وأرسل طلبا دون فتح APEX.',
    enabledTitle: 'الإدخال السريع',
    invalidShortcut: 'ليس اختصارا صالحا. أضف مفتاح تعديل واحدا على الأقل.',
    shortcutDesc: 'يحتاج إلى مفتاح تعديل واحد على الأقل، مثل CommandOrControl+Shift+Space.',
    shortcutTitle: 'اختصار الإدخال السريع',
    takenBy: 'يستخدم تطبيق آخر هذا الاختصار — اختر اختصارا مختلفا.'
  },
  window: en.window
}

export const QUICK_ENTRY_COPY: Readonly<Record<Locale, QuickEntryCopy>> = {
  ar,
  en,
  ja: en,
  zh,
  'zh-hant': zhHant
}

/** Quick Entry's Settings rows in the window's language. */
export function useQuickEntrySettingsCopy(): QuickEntrySettingsCopy {
  return (QUICK_ENTRY_COPY[useI18n().locale] ?? en).settings
}

// ── The mini window's language ──────────────────────────────────────────────

/** Written by the primary window, read by the mini window. */
export const QUICK_ENTRY_LOCALE_KEY = 'apex.desktop.quickEntry.locale'

/** The language the main window shows, as the mini window should. Before the
 *  main window has written one (a first launch racing the shortcut), Chinese:
 *  the same China-first default main.tsx hands its I18nProvider. */
export function storedQuickEntryLocale(): Locale {
  const stored = readKey(QUICK_ENTRY_LOCALE_KEY)

  return isSupportedLocaleValue(stored) ? normalizeLocale(stored) : 'zh'
}

/** Primary window only: record the language it resolved for the mini window. */
export function rememberQuickEntryLocale(locale: Locale): void {
  if (readKey(QUICK_ENTRY_LOCALE_KEY) !== locale) {
    writeKey(QUICK_ENTRY_LOCALE_KEY, locale)
  }
}

/** The mini window's language: the stored one now, and every later switch the
 *  main window makes (`storage` fires in the other same-origin windows). */
export function useQuickEntryLocale(): Locale {
  const [locale, setLocale] = useState<Locale>(storedQuickEntryLocale)

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === QUICK_ENTRY_LOCALE_KEY) {
        setLocale(storedQuickEntryLocale())
      }
    }

    window.addEventListener('storage', onStorage)

    return () => window.removeEventListener('storage', onStorage)
  }, [])

  return locale
}

// ── hc-1077: which assistant the mini window is talking to ──────────────────

/** Written by the primary window while several assistants are on; absent otherwise. */
export const QUICK_ENTRY_ASSISTANT_KEY = 'apex.desktop.quickEntry.assistant'

/** Primary window only: the name of the assistant a capture will reach (the one on screen), or null with one assistant. */
export function rememberQuickEntryAssistant(name: null | string): void {
  if (readKey(QUICK_ENTRY_ASSISTANT_KEY) !== name) {
    writeKey(QUICK_ENTRY_ASSISTANT_KEY, name)
  }
}

/** The mini window's view of it, live across windows like the language. */
export function useQuickEntryAssistant(): null | string {
  const [name, setName] = useState<null | string>(() => readKey(QUICK_ENTRY_ASSISTANT_KEY))

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === QUICK_ENTRY_ASSISTANT_KEY) {
        setName(readKey(QUICK_ENTRY_ASSISTANT_KEY))
      }
    }

    window.addEventListener('storage', onStorage)

    return () => window.removeEventListener('storage', onStorage)
  }, [])

  return name
}
