import fs from 'node:fs'
import path from 'node:path'

import type { AnalysisDocumentsBridge } from '../src/app/business-workspace/analysis-types'

import { type PackagedMockBackendFixture, setupPackagedMockBackend, waitForAppReady } from './fixtures'
import { collectErrorBanners, expect, test } from './test'

interface IntegrationInput {
  base: string
  phase: 'save' | 'review' | 'retained'
  sourceId: string
  ownerId: string
  otherId: string
  output: string
  reportId?: string
  sha256?: string
  revision: string
  collection?: { workspace_id: string; submitted_at: string }
}
interface IntegrationWindow extends Window {
  hermesDesktop?: {
    analysisDocuments: AnalysisDocumentsBridge
    managed: { signIn: (input: { email: string; password: string }) => Promise<{ ok: boolean; hasRelayKey: boolean }> }
  }
}

const inputFile = process.env.APEX_ANALYSIS_INTEGRATION_INPUT

test('hc-896 packaged native cloud reports survive an independent client and enforce account policy', async () => {
  test.skip(!inputFile, 'Opt-in: run the APEX PostgreSQL/HTTP orchestrator')
  test.setTimeout(180_000)
  const input = JSON.parse(fs.readFileSync(inputFile!, 'utf8')) as IntegrationInput
  expect(new URL(input.base).hostname).toBe('127.0.0.1')
  let fixture: PackagedMockBackendFixture | undefined

  try {
    fixture = await setupPackagedMockBackend({ APEXNODES_API_BASE: input.base, APEXNODES_AUTH_BASE: input.base })
    const { page, mockUrl, sandbox } = fixture
    await page.getByRole('button', { name: '使用自己的密钥' }).click()
    const later = page.getByRole('button', { name: '稍后再选择提供方' })

    if (await later.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true, () => false)) {await later.click()}
    await waitForAppReady(fixture, 120_000)

    // The fixture login issues a real server JWT. The analysis routes have no overrides.
    const signIn = async (email: string) => {
      const result = await page.evaluate(({ email, password }) =>
        (window as IntegrationWindow).hermesDesktop!.managed.signIn({ email, password }), { email, password: mockUrl })

      expect(result).toMatchObject({ ok: true, hasRelayKey: true })
    }

    await signIn('owner@fixture.test')
    const source = await page.evaluate(id => (window as IntegrationWindow).hermesDesktop!.analysisDocuments.get(id), input.sourceId)
    expect(source.ok).toBe(true)
    expect(source.item).toMatchObject({ id: input.sourceId, analysis_scope: input.ownerId, analysis_revision: input.revision, storageMode: 'cloud' })
    const listing = await page.evaluate(() => (window as IntegrationWindow).hermesDesktop!.analysisDocuments.list())
    expect(listing.cloudUnavailable).toBe(false)
    expect(listing.items?.map(item => item.id)).toContain(input.sourceId)
    let result: unknown

    if (input.phase === 'save') {
      const workspace = await page.evaluate(input => (window as IntegrationWindow).hermesDesktop!.analysisDocuments
        .prepareDeepWorkspace(input.sourceId, input.ownerId, input.revision), input)

      expect(workspace.ok).toBe(true)
      expect(workspace.directory!.startsWith(fs.realpathSync(sandbox.userDataDir) + path.sep)).toBe(true)

      // This receipt and report are explicit fixtures, not evidence of an Agent run.
      const receipt = await page.evaluate(({ input, workspaceId }) => (window as IntegrationWindow).hermesDesktop!.analysisDocuments
        .recordDeepChat!(input.sourceId, input.ownerId, input.revision,
          { sessionId: 'fixture-session-not-executed', connectionId: null, profile: 'default', workspaceId }),
      { input, workspaceId: workspace.workspaceId })

      expect(receipt.ok).toBe(true)
      fs.writeFileSync(path.join(workspace.directory!, 'ANALYSIS.md'), '# Fixture cloud report\nSelected bytes, not model evidence.')

      const saved = await page.evaluate(input => (window as IntegrationWindow).hermesDesktop!.analysisDocuments
        .collectDeepReport!(input.sourceId, input.ownerId, input.revision, 'ANALYSIS.md'), input)

      expect(saved.ok).toBe(true)
      expect(saved.item).toMatchObject({ provenance: 'selected_file', revision: input.revision,
        body: '# Fixture cloud report\nSelected bytes, not model evidence.',
        collection: { workspace_id: workspace.workspaceId, submitted_at: receipt.item!.submittedAt } })
      expect(Object.keys(saved.item!.collection!).sort()).toEqual(['submitted_at', 'workspace_id'])
      result = { report: saved.item, root: sandbox.userDataDir }
    } else {
      expect(source.item!.deep_reports).toHaveLength(1)
      const report = source.item!.deep_reports![0]
      expect(report).toMatchObject({ id: input.reportId, sha256: input.sha256, collection: input.collection })

      const localReceipt = await page.evaluate(input => (window as IntegrationWindow).hermesDesktop!.analysisDocuments
        .readDeepChat!(input.sourceId, input.ownerId, input.revision), input)

      expect(localReceipt).toEqual({ ok: true, item: null })

      const reviewed = await page.evaluate(input => (window as IntegrationWindow).hermesDesktop!.analysisDocuments
        .reviewDeepReport!(input.sourceId, input.ownerId, input.reportId!,
          { revision: input.revision, sha256: input.sha256!, decision: 'accepted', note: 'Reviewed on another client' }), input)

      if (input.phase === 'review') {
        expect(reviewed.ok).toBe(true)
        expect(reviewed.item!.review).toMatchObject({ decision: 'accepted', note: 'Reviewed on another client' })
        expect(reviewed.item!.collection).toEqual(input.collection)
        await signIn('other@fixture.test')

        const denied = await page.evaluate(async input => {
          const api = (window as IntegrationWindow).hermesDesktop!.analysisDocuments

          return { list: await api.list(), get: await api.get(input.sourceId),
            review: await api.reviewDeepReport!(input.sourceId, input.otherId, input.reportId!,
              { revision: input.revision, sha256: input.sha256!, decision: 'changes_requested', note: 'Foreign user' }),
            remove: await api.deleteDeepReport(input.sourceId, input.otherId, input.reportId!) }
        }, input)

        expect(denied.list).toMatchObject({ ok: true, cloudUnavailable: false, items: [] })

        for (const outcome of [denied.get, denied.review, denied.remove]) {expect(outcome).toEqual({ ok: false, code: 'source_not_found' })}
        result = { report: reviewed.item, denied, root: sandbox.userDataDir }
      } else {
        expect(report.review).toMatchObject({ decision: 'accepted', note: 'Reviewed on another client' })
        expect(reviewed).toEqual({ ok: false, code: 'analysis_cloud_storage_disabled' })

        const removed = await page.evaluate(input => (window as IntegrationWindow).hermesDesktop!.analysisDocuments
          .deleteDeepReport(input.sourceId, input.ownerId, input.reportId!), input)

        expect(removed).toEqual({ ok: true })
        const kept = await page.evaluate(id => (window as IntegrationWindow).hermesDesktop!.analysisDocuments.get(id), input.sourceId)
        expect(kept.ok).toBe(true)
        expect(kept.item!.deep_reports).toEqual([])
        expect(kept.item!.anchors).toHaveLength(1)
        result = { retained: kept.item, deniedWrite: reviewed, root: sandbox.userDataDir }
      }
    }

    expect(await collectErrorBanners(page)).toEqual([])
    fs.writeFileSync(input.output, JSON.stringify(result))
    await test.info().attach(`hc896-${input.phase}`, { body: JSON.stringify(result), contentType: 'application/json' })
  } finally {
    if (fixture) {
      const errors = await collectErrorBanners(fixture.page)
      await fixture.cleanup()
      expect(errors).toEqual([])
    }
  }
})
