import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import { AnalysisView } from './analysis-page'

const locales = [
  { locale: 'zh', retry: '重试保存设置', import: '导入文档或字幕', upload: '选择本地视频转写', failed: '无法读取资料保存设置，请检查连接后重试。' },
  { locale: 'zh-hant', retry: '重試儲存設定', import: '匯入文件或字幕', upload: '選擇本機影片轉寫', failed: '無法讀取資料儲存設定，請檢查連接後重試。' },
  { locale: 'en', retry: 'Retry save settings', import: 'Import document or captions', upload: 'Choose local video to transcribe', failed: 'Could not read source save settings. Check your connection and retry.' },
  { locale: 'ja', retry: '保存設定を再試行', import: '文書・字幕を読み込む', upload: 'ローカル動画を文字起こし', failed: '資料の保存設定を読み込めませんでした。接続を確認して再試行してください。' },
  { locale: 'ar', retry: 'إعادة قراءة إعدادات الحفظ', import: 'استيراد مستند أو ترجمة', upload: 'اختر فيديو محليًا لتفريغ صوته', failed: 'تعذرت قراءة إعدادات حفظ المصادر. تحقق من الاتصال ثم أعد المحاولة.' }
] as const

describe('Analysis save policy recovery', () => {
  it.each(locales)('recovers thrown and rejected reads without losing the source import action in $locale', async copy => {
    const policy = vi.fn()
      .mockRejectedValueOnce(new Error('connection interrupted'))
      .mockResolvedValueOnce({ ok: false, code: 'analysis_policy_unavailable' })
      .mockResolvedValueOnce({ ok: true, policy: { mode: 'local', cloud_storage_configured: false } })

    const item = { id: 'local-recovered', filename: 'Recovered.txt', kind: 'text', status: 'ready', storageMode: 'local', anchors: [], notes: [], questions: [] }
    const importFile = vi.fn(async () => ({ ok: true, item }))
    Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { analysisDocuments: {
      policy, list: vi.fn(async () => ({ ok: true, items: [] })), importFile,
      get: vi.fn(async () => ({ ok: true, item }))
    } } })

    render(<I18nProvider configClient={null} initialLocale={copy.locale}><AnalysisView /></I18nProvider>)
    await screen.findByRole('button', { name: copy.retry })
    expect(screen.getByRole('alert').textContent).toBe(copy.failed)
    expect(screen.getByRole('button', { name: copy.import }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: copy.upload }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: copy.retry }))
    await waitFor(() => expect(policy).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('button', { name: copy.retry })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe(copy.failed)
    fireEvent.click(screen.getByRole('button', { name: copy.retry }))
    await waitFor(() => expect(screen.getByRole('button', { name: copy.import }).hasAttribute('disabled')).toBe(false))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: copy.upload }).hasAttribute('disabled')).toBe(false)
    expect(policy).toHaveBeenCalledTimes(3)
    fireEvent.click(screen.getByRole('button', { name: copy.import }))
    await screen.findByRole('heading', { name: item.filename })
    expect(importFile).toHaveBeenCalledTimes(1)
  })

  it.each([
    { response: { ok: false, code: 'sign_in' }, message: '请先登录 APEX，再重新读取资料保存设置。', retry: true },
    { response: { ok: false, code: 'permission_denied' }, message: '当前账号无权读取资料保存设置，请检查账号权限。', retry: true },
    { response: { ok: true, policy: { mode: 'cloud', cloud_storage_configured: false } }, message: '云端资料存储尚未配置，请联系平台管理员。', retry: false }
  ])('keeps unavailable imports gated for $message', async ({ response, message, retry }) => {
    const importFile = vi.fn()
    const policy = vi.fn(async () => response)
    Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { analysisDocuments: {
      policy, list: vi.fn(async () => ({ ok: true, items: [] })), importFile
    } } })
    render(<I18nProvider configClient={null} initialLocale="zh"><AnalysisView /></I18nProvider>)
    await screen.findByText(message)
    expect(screen.getByRole('button', { name: '导入文档或字幕' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '选择本地视频转写' }).hasAttribute('disabled')).toBe(true)
    expect(Boolean(screen.queryByRole('button', { name: '重试保存设置' }))).toBe(retry)
    expect(importFile).not.toHaveBeenCalled()
  })
})
