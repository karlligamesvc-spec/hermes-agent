import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { ElectronApplication, Page } from '@playwright/test'

import type { AnalysisDocumentsBridge } from '../src/app/business-workspace/analysis-types'

import { expect, test } from './test'

interface AccountTestWindow extends Window {
  hermesDesktop?: { analysisDocuments: AnalysisDocumentsBridge; managed: { signIn: (input: { email: string; password: string }) => Promise<{ ok: boolean }> } }
}

interface AccountApi {
  setLoginUser: (id: string) => void
  seedAccountSource: () => void
  holdAnalysisResponse: (suffix: string, renew?: boolean) => { received: Promise<void>; release: () => void }
}

const OTHER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

async function signIn(page: Page, api: AccountApi, id: string) {
  api.setLoginUser(id)
  const result = await page.evaluate(() => (window as AccountTestWindow).hermesDesktop!.managed!.signIn({ email: 'phase1-review@local.test', password: 'local-review-only' }))
  expect(result?.ok).toBe(true)
}

export async function verifyAccountIsolation(_app: ElectronApplication, page: Page, api: AccountApi, owner: string, sourceId: string) {
  api.seedAccountSource()
  const results: unknown[] = []

  try {
    for (const [operation, suffix, renew] of [
      ['policy', 'storage-policy', false], ['list', 'documents', false],
      ['get', `documents/${sourceId}`, false], ['list', 'documents', true]
    ] as const) {
      await signIn(page, api, owner)
      const held = api.holdAnalysisResponse(suffix, renew)

      const pending = page.evaluate(async input => {
        const bridge: AnalysisDocumentsBridge = (window as AccountTestWindow).hermesDesktop!.analysisDocuments!

        return input.operation === 'get' ? bridge.get(input.sourceId) : bridge[input.operation]()
      }, { operation, sourceId })

      try {
        await held.received
        await signIn(page, api, OTHER)
      } finally { held.release() }

      const result = await pending
      results.push({ operation, renew, result })
      expect.soft(result).toEqual({ ok: false, code: 'analysis_account_changed' })
      const current = await page.evaluate(() => (window as AccountTestWindow).hermesDesktop!.analysisDocuments!.policy())
      expect.soft(current.policy).toMatchObject({ user_id: OTHER })
    }

    await signIn(page, api, owner)
    const held = api.holdAnalysisResponse('documents', true)
    const normal = page.evaluate(() => (window as AccountTestWindow).hermesDesktop!.analysisDocuments!.list())
    await held.received
    held.release()
    expect((await normal).ok).toBe(true)
    const renewedPolicy = await page.evaluate(() => (window as AccountTestWindow).hermesDesktop!.analysisDocuments!.policy())
    expect(renewedPolicy.policy).toMatchObject({ user_id: owner, fixture_renewed: true })
    results.push({ sameAccountRenewal: true })
  } finally {
    await test.info().attach('hc894-account-bound-responses', { body: JSON.stringify(results), contentType: 'application/json' })
    await signIn(page, api, owner)
    await page.evaluate(id => (window as AccountTestWindow).hermesDesktop!.analysisDocuments!.delete(id), sourceId)
  }
}

export async function verifyPickerAccountIsolation(app: ElectronApplication, page: Page, api: AccountApi, owner: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hc894-picker-'))
  const sourcePath = path.join(directory, 'local-review-document.txt')
  fs.writeFileSync(sourcePath, '# Quarterly report\n\nRevenue 423 units')
  await signIn(page, api, owner)
  await app.evaluate(({ dialog }, selectedPath) => {
    const host = globalThis as typeof globalThis & { pickerOpened?: boolean; releasePicker?: () => void; restorePicker?: () => void }
    const original = dialog.showOpenDialog

    host.restorePicker = () => { dialog.showOpenDialog = original }
    host.pickerOpened = false

    dialog.showOpenDialog = async () => {
      host.pickerOpened = true
      await new Promise<void>(resolve => { host.releasePicker = resolve })

      return { canceled: false, filePaths: [selectedPath] }
    }
  }, sourcePath)
  const pending = page.evaluate(() => (window as AccountTestWindow).hermesDesktop!.analysisDocuments!.importFile())

  try {
    await expect.poll(() => app.evaluate(() => (globalThis as typeof globalThis & { pickerOpened?: boolean }).pickerOpened)).toBe(true)
    await signIn(page, api, OTHER)
    await app.evaluate(() => (globalThis as typeof globalThis & { releasePicker?: () => void }).releasePicker?.())
    const result = await pending
    expect(result).toEqual({ ok: false, code: 'analysis_account_changed' })
    const listed = await page.evaluate(() => (window as AccountTestWindow).hermesDesktop!.analysisDocuments!.list())
    expect(listed.items?.some(item => item.filename === 'local-review-document.txt')).toBe(false)
    await test.info().attach('hc894-picker-owner', { body: JSON.stringify({ result, listed }), contentType: 'application/json' })
  } finally {
    await app.evaluate(() => {
      const host = globalThis as typeof globalThis & { releasePicker?: () => void; restorePicker?: () => void }
      host.releasePicker?.(); host.restorePicker?.()
      delete host.releasePicker; delete host.restorePicker
    })
    await signIn(page, api, owner)
    fs.rmSync(directory, { recursive: true, force: true })
  }
}
