import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import type { ElectronApplication, Locator, Page } from '@playwright/test'

import { TASK_PANEL_RESUME_TRIGGER } from '../../../tests-js/scripts/mock-server'
import type { SourceAnswerInput } from '../shared/analysis-answer'
import type { AnalysisDocumentsBridge } from '../src/app/business-workspace/analysis-types'

import { verifyAccountWorkspaceReset } from './account-workspace-reset'
import { verifyAccountIsolation, verifyPickerAccountIsolation } from './analysis-account-isolation'
import { verifyAnalysisChatLink } from './analysis-chat-link'
import { verifySourceAnswer } from './analysis-source-answer'
import { verifyWorkspaceReport } from './analysis-workspace-report'
import { openAccountDestination } from './business-navigation'
import { verifyCronExecutionHistory, verifyCronTimerExecution, verifyLateSessionRecovery } from './cron-execution-history'
import { type PackagedMockBackendFixture, setupPackagedMockBackend, waitForAppReady } from './fixtures'
import { allowErrorBanners, collectErrorBanners, expect, test } from './test'

// Browser evaluation uses the same analysis contract as the production bridge.
// Keep the renderer's unrelated ambient declarations out of this Node E2E project.
type AnalysisReviewWindow = Window & { hermesDesktop?: { analysisDocuments?: AnalysisDocumentsBridge } }

const BUSINESS_NAV_LABELS = ['开始', '沉浸式分析'] as const

const PACKAGED_VERSION = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8')
).version as string

const ANALYSIS_REVIEW_USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ANALYSIS_REVIEW_TOKEN = `local.${Buffer.from(JSON.stringify({ sub: ANALYSIS_REVIEW_USER_ID })).toString('base64url')}.review`
const ANALYSIS_REVIEW_VIDEO_URL = 'https://www.iesdouyin.com/share/video/123456'
const ANALYSIS_REVIEW_CLOUD_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const REVIEW_PROJECT_RUNNING_ID = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1'
const REVIEW_PROJECT_COMPLETED_ID = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2'
const REVIEW_PROJECT_EMPTY_ID = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3'
const REVIEW_WORKFLOW_ID = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1'
const REVIEW_RUN_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1'
const REVIEW_COMPLETED_RUN_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2'

const ANALYSIS_FORMAT_SAMPLES = [
  {
    filename: 'analysis-review.pdf', kind: 'pdf', question: 'Revenue?', citation: '第 2 页',
    anchorId: 'a2', evidence: 'Revenue 423 units',
    anchors: [
      { id: 'a1', location: { page: 1 }, text: 'Quarterly report' },
      { id: 'a2', location: { page: 2 }, text: 'Revenue 423 units' }
    ]
  },
  {
    filename: 'analysis-review.docx', kind: 'word', question: 'Launch?', citation: '第 2 段',
    anchorId: 'a2', evidence: 'Launch in October',
    anchors: [
      { id: 'a1', location: { paragraph: 1, heading: 'Plan' }, text: 'Plan' },
      { id: 'a2', location: { paragraph: 2, heading: 'Plan' }, text: 'Launch in October' }
    ]
  },
  {
    filename: 'analysis-review.xlsx', kind: 'excel', question: 'North?', citation: 'Forecast · C7',
    anchorId: 'a1', evidence: 'North region',
    anchors: [{ id: 'a1', location: { sheet: 'Forecast', cell: 'C7' }, text: 'North region' }]
  }
] as const

async function openWorkflowCatalog(page: Page) {
  await openAccountDestination(page, '项目')
  await page.getByRole('button', { name: /\[本地测试\] 美国宠物用品机会分析/ }).click()
  await page.locator('[data-project-detail]').getByRole('button', { name: '增加工作流' }).click()
  await expect(page.getByRole('heading', { name: '工作流', level: 1 })).toBeVisible()
}

async function openDeliverables(page: Page) {
  await page.getByRole('button', { name: /打开账户菜单.*本地 UI 评审/ }).click()
  await page.getByRole('menuitem', { name: '交付物' }).click()
  await expect(page.getByRole('heading', { name: '交付物', level: 1 })).toBeVisible()
}

async function expectWindowHeight(app: ElectronApplication, actual: number | undefined, requested: number) {
  const workAreaHeight = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea.height)

  expect(actual).toBe(Math.min(requested, workAreaHeight))
}

const PHASE1_VIEWPORTS = [
  { height: 900, name: 'wide-1440', width: 1440 },
  { height: 800, name: 'desktop-1220', width: 1220 },
  { height: 800, name: 'narrow-752', width: 752 }
] as const

async function expectDrawerBelowNativeChrome(drawer: Locator) {
  const geometry = await drawer.evaluate(element => {
    const box = element.getBoundingClientRect()
    const style = getComputedStyle(element)

    return {
      top: box.top,
      bottom: box.bottom,
      height: box.height,
      viewportHeight: window.innerHeight,
      titlebarHeight: style.getPropertyValue('--titlebar-height'),
      computedTop: style.top
    }
  })

  await test.info().attach('native-drawer-geometry', {
    body: JSON.stringify(geometry, null, 2),
    contentType: 'application/json'
  })
  // Native chrome is 34px at the fixture's explicit 100% zoom. A portal
  // without its shell token instead shrinks to content and anchors at bottom.
  expect(geometry.top).toBeCloseTo(34, 0)
  expect(geometry.bottom).toBeCloseTo(geometry.viewportHeight, 0)
  expect(geometry.height).toBeCloseTo(geometry.viewportHeight - 34, 0)
}

async function expectReadablePageGutters(surface: Locator) {
  const geometry = await surface.evaluate(element => {
    const style = getComputedStyle(element)
    const box = element.getBoundingClientRect()
    const content = element.firstElementChild!.getBoundingClientRect()

    return {
      contentLeftGap: content.left - box.left,
      contentRightGap: box.right - content.right,
      paddingLeft: Number.parseFloat(style.paddingLeft),
      paddingRight: Number.parseFloat(style.paddingRight),
      rootClientWidth: document.documentElement.clientWidth,
      rootScrollWidth: document.documentElement.scrollWidth,
      surfaceClientWidth: element.clientWidth,
      surfaceScrollWidth: element.scrollWidth,
      surfaceTop: box.top,
      surfaceBottom: box.bottom,
      viewportHeight: window.innerHeight
    }
  })

  // Measure the packaged CSS and real content edges, independently of the
  // renderer's token. An undefined custom property computes to zero here.
  expect(geometry.paddingLeft).toBeGreaterThanOrEqual(20)
  expect(geometry.paddingLeft).toBeLessThanOrEqual(64)
  expect(geometry.paddingRight).toBeCloseTo(geometry.paddingLeft, 1)
  expect(geometry.contentLeftGap).toBeGreaterThanOrEqual(20)
  expect(geometry.contentRightGap).toBeGreaterThanOrEqual(20)
  expect(geometry.surfaceScrollWidth).toBeLessThanOrEqual(geometry.surfaceClientWidth)
  expect(geometry.rootScrollWidth).toBeLessThanOrEqual(geometry.rootClientWidth)
  expect(geometry.surfaceTop).toBeGreaterThanOrEqual(0)
  expect(geometry.surfaceBottom).toBeLessThanOrEqual(geometry.viewportHeight + 1)
  await test.info().attach('page-gutter-geometry', {
    body: JSON.stringify(geometry, null, 2),
    contentType: 'application/json'
  })
}

async function expectApexShellPaint(page: Page, expected: 'business-canvas' | 'session', label: string) {
  const shell = page.locator('[data-contrib-shell]')

  await expect(shell).toHaveCount(1)

  const paint = await shell.evaluate(element => {
    const root = document.documentElement
    const shellStyle = getComputedStyle(element)
    const shellRect = element.getBoundingClientRect()
    const chromeProbe = document.createElement('div')

    chromeProbe.style.backgroundColor = 'var(--ui-bg-chrome)'
    chromeProbe.style.position = 'fixed'
    chromeProbe.style.visibility = 'hidden'
    document.body.append(chromeProbe)

    const chromeColor = getComputedStyle(chromeProbe).backgroundColor
    const backgroundColor = shellStyle.backgroundColor
    chromeProbe.remove()

    const alphaFor = (color: string): number => {
      if (color === 'transparent') {
        return 0
      }

      const commaAlpha = color.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/)

      if (commaAlpha) {
        return Number(commaAlpha[1])
      }

      const slashAlpha = color.match(/\/\s*([\d.]+)%?\s*\)$/)

      if (slashAlpha) {
        const alpha = Number(slashAlpha[1])

        return color.includes('%') ? alpha / 100 : alpha
      }

      return 1
    }

    return {
      appearance: root.classList.contains('dark') ? 'dark' : 'light',
      backgroundAlpha: alphaFor(backgroundColor),
      backgroundColor,
      businessSurface: element.getAttribute('data-apex-surface'),
      chromeColor,
      glassActive: root.hasAttribute('data-hermes-glass'),
      glassKeep: getComputedStyle(root).getPropertyValue('--translucency-glass-keep').trim(),
      shellRect: {
        bottom: shellRect.bottom,
        left: shellRect.left,
        right: shellRect.right,
        top: shellRect.top
      },
      viewport: { height: root.clientHeight, width: root.clientWidth }
    }
  })

  await test.info().attach(`apex-shell-paint-${label}`, {
    body: JSON.stringify(paint, null, 2),
    contentType: 'application/json'
  })

  expect(paint.glassActive).toBe(true)
  expect(paint.glassKeep).toMatch(/^\d+%$/)
  expect(Number.parseInt(paint.glassKeep, 10)).toBeGreaterThan(0)
  expect(Number.parseInt(paint.glassKeep, 10)).toBeLessThan(100)
  expect(paint.appearance).toBe('light')
  expect(paint.shellRect.left).toBeCloseTo(0, 0)
  expect(paint.shellRect.top).toBeCloseTo(0, 0)
  expect(paint.shellRect.right).toBeCloseTo(paint.viewport.width, 0)
  expect(paint.shellRect.bottom).toBeCloseTo(paint.viewport.height, 0)

  if (expected === 'business-canvas') {
    expect(paint.businessSurface).toBe('business-canvas')
    expect(paint.backgroundAlpha).toBe(1)
    expect(paint.backgroundColor).toBe(paint.chromeColor)
  } else {
    expect(paint.businessSurface).toBeNull()
    expect(paint.backgroundAlpha).toBe(0)
    expect(paint.backgroundColor).not.toBe(paint.chromeColor)
  }
}

let fixture: PackagedMockBackendFixture | null = null
let reviewApi: null | Awaited<ReturnType<typeof startPhase1ReviewApi>> = null

const reviewProjects = [
  {
    createdAt: '2026-09-05T18:00:00Z',
    id: REVIEW_PROJECT_RUNNING_ID,
    name: '[本地测试] 美国宠物用品机会分析',
    objective: '验证项目列表的长标题、真实生命周期文案与点击入口。',
    status: 'active',
    summary: {
      attention: 'none',
      currentRunId: REVIEW_RUN_ID,
      currentRunStatus: 'running',
      currentStepTitle: null,
      deliverableCount: 0,
      stepCompleted: 0,
      stepTotal: 0
    },
    updatedAt: '2026-09-05T21:05:00Z'
  },
  {
    createdAt: '2026-09-04T16:00:00Z',
    id: REVIEW_PROJECT_COMPLETED_ID,
    name: '[本地测试] APEX GEO 品牌诊断',
    objective: '验证已完成状态、窄窗换行与返回路径。',
    status: 'completed',
    summary: {
      attention: 'none',
      currentRunId: REVIEW_COMPLETED_RUN_ID,
      currentRunStatus: 'succeeded',
      currentStepTitle: null,
      deliverableCount: 0,
      stepCompleted: 0,
      stepTotal: 0
    },
    updatedAt: '2026-09-05T17:30:00Z'
  },
  {
    createdAt: '2026-09-05T19:00:00Z',
    id: REVIEW_PROJECT_EMPTY_ID,
    name: '[本地测试] 尚未启动的业务目标',
    objective: '[本地测试] 尚未启动的业务目标',
    status: 'active',
    updatedAt: '2026-09-05T21:15:00Z'
  }
]

const reviewCatalog = [
  ['market-launch', 'cross_border_launch', true],
  ['geo-brand-audit', 'geo_brand_audit', true],
  ['content-review', 'content_review', true],
  ['competitor-monitoring', 'competitor_monitoring', false],
  ['review-insights', 'review_insights', false],
  ['business-review', 'business_review', false]
].map(([id, businessPath, recommended], index) => ({
  businessPath,
  id,
  position: index + 1,
  recommended,
  slug: id,
  version: 1
}))

const reviewRun = {
  deliverables: [
    {
      createdAt: '2026-09-06T17:04:00Z',
      evidence: [
        {
          quote: '美国宠物用品搜索需求同比增长。',
          title: '[本地测试] 公开市场来源',
          token: 'e2e-evidence-secret',
          url: 'https://example.com/pet-market',
          verified: true
        }
      ],
      executorType: 'hermes',
      executorVersion: '2026.9.1',
      id: 'local-review-deliverable-1',
      kind: 'report',
      payload: {
        config: { apiKey: 'e2e-payload-secret' },
        highlights: ['美国需求增长', '引用覆盖率达到验收线'],
        schema: 'private-schema',
        summary: '[本地测试] 有证据的美国宠物用品市场结论。'
      },
      projectId: REVIEW_PROJECT_RUNNING_ID,
      reviews: [
        {
          createdAt: '2026-09-06T17:05:00Z',
          decidedAt: '2026-09-06T17:05:00Z',
          id: 'local-review-review-1',
          metrics: { citationCoverage: 0.8, secretScore: 99 },
          nextAction: { label: '补充引用', secret: 'e2e-next-action-secret', type: 'revise' },
          notes: '[本地测试] 请补充主要来源。',
          reviewerType: 'human',
          roundNumber: 1,
          status: 'changes_requested',
          updatedAt: '2026-09-06T17:05:00Z',
          userId: 'tenant-user'
        }
      ],
      runId: REVIEW_RUN_ID,
      schemaVersion: 1,
      sourceCapturedAt: '2026-09-06T17:03:30Z',
      status: 'ready',
      storageTarget: {
        id: '00000000-0000-4000-8000-000000000831',
        kind: 'user_file',
        signedUrl: 'https://files.example/private?token=e2e-file-secret'
      },
      title: '[本地测试] 美国宠物用品分析报告',
      updatedAt: '2026-09-06T17:05:00Z',
      verifierResult: {
        citationCoverage: 0.8,
        evidenceCount: 1,
        passed: true,
        secret: 'e2e-verifier-secret'
      }
    }
  ],
  events: [
    {
      eventKey: 'private-event-key',
      eventType: 'tool.result',
      happenedAt: '2026-09-06T17:03:00Z',
      id: 'local-review-event-3',
      payload: { result: 'e2e-raw-result-secret' },
      sequence: 3
    },
    {
      eventType: 'run.queued',
      happenedAt: '2026-09-06T17:00:00Z',
      id: 'local-review-event-1',
      payload: {},
      sequence: 1
    },
    {
      eventType: 'run.running',
      happenedAt: '2026-09-06T17:01:00Z',
      id: 'local-review-event-2',
      payload: {},
      sequence: 2
    }
  ],
  run: {
    attempt: 1,
    completedAt: null,
    createdAt: '2026-09-06T17:00:00Z',
    errorMessage: 'e2e-private-stack',
    executorType: 'hermes',
    id: REVIEW_RUN_ID,
    maxAttempts: 2,
    startedAt: '2026-09-06T17:01:00Z',
    status: 'waiting_review',
    triggerRef: '[本地测试] 验证真实 Run 抽屉、事件顺序与诚实空态。',
    updatedAt: '2026-09-06T17:05:00Z',
    userId: 'tenant-user'
  },
  steps: []
}

async function startPhase1ReviewApi() {
  let loginUserId = ANALYSIS_REVIEW_USER_ID
  const tokenFor = (id: string) => `local.${Buffer.from(JSON.stringify({ sub: id })).toString('base64url')}.review`
  let heldResponse: { path: string; received: () => void; send?: () => void; renewedToken?: string } | null = null
  let lastReview: null | Record<string, unknown> = null
  let relayBaseUrl = ''
  let runAvailable = true
  let workflowEnabled = true
  let analysisMode: 'cloud' | 'local' = 'local'
  let cloudStorageConfigured = false
  let failAnalysisPolicy = false
  const policyStatuses: number[] = []
  let failCloudDetail = false

  let cloudDocument: null | {
    id: string; filename: string; kind: string; status: 'processing' | 'ready';
    created_at: string; anchors: Array<{ id: string; location: { paragraph: number }; text: string }>
  } = null

  let cloudQuestions: Array<{ id: string; question: string; answer: string; answer_type: string; source_revision?: string; citations: Array<{ anchor_id: string; location: { paragraph: number } }> }> = []
  let cloudNotes: Array<{ id: string; body: string; anchor_id: string | null }> = []
  let cloudDetailReads = 0

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')

    const json = (status: number, body: unknown) => {
      const held = heldResponse?.path === url.pathname && !heldResponse.send ? heldResponse : null

      const send = () => {
        response.writeHead(status, { 'content-type': 'application/json', ...(held?.renewedToken ? { 'X-Apex-Renewed-Token': held.renewedToken } : {}) })
        response.end(JSON.stringify(body))
      }

      if (held) { held.send = send; held.received() } else { send() }
    }

    if (request.method === 'POST' && url.pathname === '/api/v1/auth/login') {
      json(200, {
        access_token: tokenFor(loginUserId),
        email: 'phase1-review@local.test',
        name: '本地 UI 评审',
        plan: 'review'
      })

      return
    }

    if (request.method === 'POST' && url.pathname === '/api/v1/auth/desktop-handoff/exchange') {
      json(200, { access_token: tokenFor(loginUserId) })

      return
    }

    if (request.method === 'GET' && url.pathname === '/api/v1/desktop/provision-key/capabilities') {
      json(200, { version: 1 })

      return
    }

    if (request.method === 'POST' && url.pathname === '/api/v1/desktop/provision-key/revoke') {
      const chunks: Buffer[] = []

      for await (const chunk of request) {chunks.push(Buffer.from(chunk))}
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      json(200, { revoked: true, provision_revision: input.provision_revision })

      return
    }

    if (request.method === 'POST' && url.pathname === '/api/v1/desktop/provision-key') {
      const chunks: Buffer[] = []

      for await (const chunk of request) {chunks.push(Buffer.from(chunk))}
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      json(200, {
        provision_revision: input.provision_revision,
        api_key: 'sk-apex-local-phase1-review',
        base_url: relayBaseUrl,
        email: 'phase1-review@local.test',
        model: 'mock-model',
        name: '本地 UI 评审',
        plan: 'review'
      })

      return
    }

    if (request.method === 'GET' && url.pathname === '/api/v1/account/analysis/storage-policy') {
      if (failAnalysisPolicy) {
        policyStatuses.push(503)
        json(503, { detail: { code: 'analysis_policy_unavailable' } })

        return
      }

      const token = String(request.headers.authorization || '').replace(/^Bearer /, '')
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
      policyStatuses.push(200)
      json(200, { user_id: claims.sub, mode: analysisMode, cloud_storage_configured: cloudStorageConfigured, fixture_renewed: Boolean(claims.renewed) })

      return
    }

    if (request.method === 'GET' && url.pathname === '/api/v1/account/analysis/documents') {
      const token = String(request.headers.authorization || '').replace(/^Bearer /, '')
      const owner = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).sub
      json(200, { items: cloudDocument && owner === ANALYSIS_REVIEW_USER_ID ? [{ ...cloudDocument, anchors: undefined }] : [] })

      return
    }

    if (request.method === 'POST' && url.pathname === '/api/v1/account/analysis/documents') {
      const chunks: Buffer[] = []

      for await (const chunk of request) {chunks.push(Buffer.from(chunk))}

      const upload = Buffer.concat(chunks).toString('utf8')

      if (request.headers.authorization !== `Bearer ${ANALYSIS_REVIEW_TOKEN}` || analysisMode !== 'cloud' ||
        !cloudStorageConfigured || !upload.includes('filename="cloud-review-document.txt"') ||
        !upload.includes('Cloud revenue 817 units')) {
        json(403, { detail: { code: 'analysis_cloud_write_disabled' } })

        return
      }

      cloudDetailReads = 0
      cloudQuestions = []
      cloudNotes = []
      cloudDocument = {
        id: ANALYSIS_REVIEW_CLOUD_ID, filename: 'cloud-review-document.txt', kind: 'text',
        status: 'processing', created_at: '2026-09-29T01:00:00Z',
        anchors: [{ id: 'a1', location: { paragraph: 1 }, text: 'Cloud revenue 817 units' }]
      }
      json(202, { item: { ...cloudDocument, anchors: undefined } })

      return
    }

    const cloudPath = `/api/v1/account/analysis/documents/${ANALYSIS_REVIEW_CLOUD_ID}`

    if (url.pathname === cloudPath || url.pathname.startsWith(`${cloudPath}/`)) {
      if (request.headers.authorization !== `Bearer ${ANALYSIS_REVIEW_TOKEN}` || !cloudDocument) {
        json(404, { detail: { code: 'source_not_found' } })

        return
      }

      if (url.pathname === cloudPath && request.method === 'GET') {
        if (failCloudDetail) {
          failCloudDetail = false
          json(503, { detail: { code: 'source_unavailable' } })

          return
        }

        cloudDetailReads += 1

        if (cloudDetailReads >= 2) { cloudDocument.status = 'ready' }

        json(200, { item: { ...cloudDocument, analysis_revision: 'c'.repeat(64), source_answers_supported: true,
          anchors: cloudDocument.status === 'ready' ? cloudDocument.anchors : [] } })

        return
      }

      if (url.pathname === `${cloudPath}/questions` && request.method === 'GET') {
        json(200, { items: cloudQuestions })

        return
      }

      if (url.pathname === `${cloudPath}/notes` && request.method === 'GET') {
        json(200, { items: cloudNotes })

        return
      }

      if (url.pathname === `${cloudPath}/questions/answers` && request.method === 'POST') {
        const chunks: Buffer[] = []

        for await (const chunk of request) {chunks.push(Buffer.from(chunk))}
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as SourceAnswerInput

        if (cloudDocument.status !== 'ready' || !cloudStorageConfigured || input.revision !== 'c'.repeat(64) ||
          input.anchor_ids.length !== 1 || input.anchor_ids[0] !== 'a1') {
          json(409, { detail: { code: 'answer_output_invalid' } })

          return
        }

        const item = { id: 'cloud-model-answer', question: input.question, answer: input.answer,
          answer_type: input.answer_type, source_revision: input.revision,
          citations: [{ anchor_id: 'a1', location: { paragraph: 1 } }] }

        cloudQuestions.push(item)
        json(200, { item })

        return
      }

      if (url.pathname === `${cloudPath}/questions` && request.method === 'POST') {
        const chunks: Buffer[] = []

        for await (const chunk of request) {chunks.push(Buffer.from(chunk))}

        const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { question?: string }

        if (cloudDocument.status !== 'ready' || input.question !== 'Cloud revenue?') {
          json(409, { detail: { code: 'source_not_ready' } })

          return
        }

        const item = {
          id: 'cloud-question-1', question: input.question, answer: 'Cloud revenue 817 units',
          answer_type: 'source_excerpts', citations: [{ anchor_id: 'a1', location: { paragraph: 1 } }]
        }

        cloudQuestions.push(item)
        json(201, { item })

        return
      }

      if (url.pathname === `${cloudPath}/notes` && request.method === 'POST') {
        const chunks: Buffer[] = []

        for await (const chunk of request) {chunks.push(Buffer.from(chunk))}

        const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { body?: string; anchor_id?: string }

        if (cloudDocument.status !== 'ready' || input.anchor_id !== 'a1' || input.body !== 'Review cloud source') {
          json(400, { detail: { code: 'invalid_analysis_review_note' } })

          return
        }

        const item = { id: 'cloud-note-1', body: input.body, anchor_id: input.anchor_id }

        cloudNotes.push(item)
        json(201, { item })

        return
      }

      if (url.pathname === `${cloudPath}/notes/cloud-note-1` && request.method === 'DELETE') {
        cloudNotes = cloudNotes.filter(item => item.id !== 'cloud-note-1')
        json(200, { ok: true })

        return
      }

      if (url.pathname === cloudPath && request.method === 'DELETE') {
        cloudDocument = null
        cloudQuestions = []
        cloudNotes = []
        json(200, { ok: true })

        return
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/v1/account/analysis/documents/parse') {
      const chunks: Buffer[] = []

      for await (const chunk of request) {chunks.push(Buffer.from(chunk))}

      const uploadBytes = Buffer.concat(chunks)
      const sample = ANALYSIS_FORMAT_SAMPLES.find(item => uploadBytes.includes(Buffer.from(`filename="${item.filename}"`)))

      if (sample) {
        const originalBytes = fs.readFileSync(path.resolve(import.meta.dirname, 'media', sample.filename))

        if (request.headers.authorization !== `Bearer ${ANALYSIS_REVIEW_TOKEN}` || !uploadBytes.includes(originalBytes)) {
          json(400, { detail: { code: 'invalid_analysis_review_upload' } })

          return
        }

        json(200, { filename: sample.filename, user_id: ANALYSIS_REVIEW_USER_ID, kind: sample.kind, parse_version: 1, anchors: sample.anchors })

        return
      }

      const upload = uploadBytes.toString('utf8')

      if (request.headers.authorization !== `Bearer ${ANALYSIS_REVIEW_TOKEN}` ||
        !upload.includes('filename="local-review-document.txt"') ||
        !upload.includes('# Quarterly report\n\nRevenue 423 units')) {
        json(400, { detail: { code: 'invalid_analysis_review_upload' } })

        return
      }

      json(200, {
        filename: 'local-review-document.txt', user_id: ANALYSIS_REVIEW_USER_ID,
        kind: 'text', parse_version: 1,
        anchors: [
          { id: 'a1', location: { paragraph: 1, heading: 'Quarterly report' }, text: '# Quarterly report' },
          { id: 'a2', location: { paragraph: 2, heading: 'Quarterly report' }, text: 'Revenue 423 units' }
        ]
      })

      return
    }

    if (request.method === 'POST' && url.pathname === '/api/v1/account/analysis/video-links/upload-transcribe') {
      const chunks: Buffer[] = []

      for await (const chunk of request) {chunks.push(Buffer.from(chunk))}
      const bytes = Buffer.concat(chunks)

      if (request.headers.authorization !== `Bearer ${ANALYSIS_REVIEW_TOKEN}` ||
        !bytes.includes(fs.readFileSync(path.resolve(import.meta.dirname, 'media/local-frame-evidence.webm')))) {
        json(400, { detail: { code: 'invalid_video_review_upload' } })

        return
      }

      json(200, { parsed: { filename: 'native-review-video.srt', evidence_origin: 'uploaded_video_audio',
        srt: '1\n00:00:01,000 --> 00:00:02,000\n[本地测试] 开头原文\n\n2\n00:00:02,000 --> 00:00:03,000\n[本地测试] 中段原文\n',
        anchors: [ { id: 'a1', location: { start_seconds: 1, end_seconds: 2 }, text: '[本地测试] 开头原文' },
          { id: 'a2', location: { start_seconds: 2, end_seconds: 3 }, text: '[本地测试] 中段原文' } ] } })

      return
    }

    if (request.method === 'POST' && url.pathname === '/api/v1/account/analysis/video-links/resolve') {
      const chunks: Buffer[] = []

      for await (const chunk of request) {chunks.push(Buffer.from(chunk))}

      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { url?: string }

      if (input.url !== ANALYSIS_REVIEW_VIDEO_URL || request.headers.authorization !== `Bearer ${ANALYSIS_REVIEW_TOKEN}`) {
        json(400, { detail: { code: 'invalid_analysis_review_request' } })

        return
      }

      json(200, {
        platform: 'douyin', status: 'original_site_only', capability: 'download_candidate',
        source_url: ANALYSIS_REVIEW_VIDEO_URL, evidence_status: 'not_read', can_answer: false,
        can_play_in_app: false
      })

      return
    }

    if (request.method === 'POST' && url.pathname === '/api/v1/account/analysis/video-links/transcribe') {
      const chunks: Buffer[] = []

      for await (const chunk of request) {chunks.push(Buffer.from(chunk))}

      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { url?: string; storage_mode?: string }

      if (input.url !== ANALYSIS_REVIEW_VIDEO_URL || input.storage_mode !== 'local' ||
        request.headers.authorization !== `Bearer ${ANALYSIS_REVIEW_TOKEN}`) {
        json(400, { detail: { code: 'invalid_analysis_review_request' } })

        return
      }

      json(200, { parsed: {
        filename: 'local-review-video-transcript.srt', evidence_origin: 'linked_video_audio', source_url: ANALYSIS_REVIEW_VIDEO_URL,
        srt: '1\n00:00:01,000 --> 00:00:03,000\n[本地测试] 开头原文\n\n2\n00:00:40,000 --> 00:00:43,000\n[本地测试] 中段原文\n',
        anchors: [
          { id: 'a1', location: { start_seconds: 1, end_seconds: 3 }, text: '[本地测试] 开头原文' },
          { id: 'a2', location: { start_seconds: 40, end_seconds: 43 }, text: '[本地测试] 中段原文' }
        ]
      } })

      return
    }

    if (request.method === 'GET' && url.pathname === '/api/v1/workflow-domain/access') {
      json(200, { enabled: workflowEnabled })

      return
    }

    if (request.method === 'GET' && url.pathname === '/api/v1/workflow-domain/projects') {
      const token = String(request.headers.authorization || '').replace(/^Bearer /, '')
      const owner = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).sub
      const items = owner === ANALYSIS_REVIEW_USER_ID ? reviewProjects : []
      json(200, { items, nextCursor: null, total: items.length })

      return
    }

    if (request.method === 'GET' && url.pathname.startsWith('/api/v1/workflow-domain/projects/')) {
      const completionRead = url.pathname.endsWith('/completion')
      const projectId = decodeURIComponent(url.pathname.slice('/api/v1/workflow-domain/projects/'.length).replace(/\/completion$/, ''))
      const token = String(request.headers.authorization || '').replace(/^Bearer /, '')
      const owner = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).sub
      const project = owner === ANALYSIS_REVIEW_USER_ID ? reviewProjects.find(item => item.id === projectId) : undefined

      if (completionRead && project) {
        // This fixture has one workflow, attached only to the running Project.
        const states = project.id === REVIEW_PROJECT_RUNNING_ID
          ? [{ workflowId: REVIEW_WORKFLOW_ID, runId: REVIEW_RUN_ID, runStatus: reviewRun.run.status }]
          : []

        const succeeded = states.filter(state => state.runStatus === 'succeeded').length
        const ready = states.length > 0 && succeeded === states.length

        json(200, { projectStatus: project.status, workflowTotal: states.length,
          workflowSucceeded: succeeded, readyForReview: ready,
          canComplete: project.status === 'active' && ready, workflowStates: states })

        return
      }

      json(project ? 200 : 404, project ? { item: project } : { detail: 'not found' })

      return
    }

    if (request.method === 'GET' && url.pathname === '/api/v1/workflow-domain/catalog') {
      json(200, { items: reviewCatalog, version: 'workflow-catalog/local-review' })

      return
    }

    if (request.method === 'GET' && url.pathname === '/api/v1/workflow-domain/workflows') {
      json(200, {
        items: [
          {
            createdAt: '2026-09-05T18:00:00Z',
            description: '仅用于本地 Phase 1 视觉评审，不代表生产数据。',
            id: REVIEW_WORKFLOW_ID,
            name: '[本地测试] 我的选品流程',
            projectId: REVIEW_PROJECT_RUNNING_ID,
            slug: 'market-launch',
            status: 'active',
            updatedAt: '2026-09-05T21:05:00Z',
            version: 1
          }
        ].filter(item => !url.searchParams.has('projectId') || item.projectId === url.searchParams.get('projectId'))
      })

      return
    }

    if (request.method === 'GET' && url.pathname === '/api/v1/workflow-domain/deliverables') {
      json(200, { items: reviewRun.deliverables, nextCursor: null })

      return
    }

    if (
      request.method === 'GET' &&
      url.pathname === '/api/v1/workflow-domain/deliverables/local-review-deliverable-1'
    ) {
      json(200, {
        item: reviewRun.deliverables[0],
        project: reviewProjects[0],
        run: { ...reviewRun.run, executorType: 'hermes' },
        workflow: {
          createdAt: '2026-09-05T18:00:00Z',
          description: '仅用于本地 Phase 2B 视觉评审，不代表生产数据。',
          id: REVIEW_WORKFLOW_ID,
          name: '[本地测试] 我的选品流程',
          projectId: REVIEW_PROJECT_RUNNING_ID,
          slug: 'market-launch',
          status: 'active',
          updatedAt: '2026-09-05T21:05:00Z',
          version: 1
        }
      })

      return
    }

    if (request.method === 'GET' && url.pathname === '/api/v1/workflow-domain/activity') {
      json(200, {
        items: [
          {
            happenedAt: '2026-09-06T17:05:00Z',
            id: 'review:local-review-review-1',
            kind: 'review',
            status: 'changes_requested',
            summary: '[本地测试] 已要求补充主要来源。',
            target: { id: 'local-review-deliverable-1', kind: 'deliverable' },
            title: '[本地测试] 审阅意见已保存'
          },
          {
            happenedAt: '2026-09-06T17:01:00Z',
            id: 'run:local-review-event-2',
            kind: 'run',
            status: 'running',
            summary: '[本地测试] 正在比较公开市场证据。',
            target: { id: REVIEW_RUN_ID, kind: 'run' },
            title: '[本地测试] 我的选品流程'
          }
        ],
        nextCursor: null
      })

      return
    }

    if (
      request.method === 'POST' &&
      url.pathname === '/api/v1/workflow-domain/deliverables/local-review-deliverable-1/reviews'
    ) {
      const chunks: Buffer[] = []

      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk))
      }

      lastReview = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      json(201, { item: { id: 'local-review-review-2' } })

      return
    }

    if (
      request.method === 'GET' &&
      url.pathname === '/api/v1/account/files/00000000-0000-4000-8000-000000000831/download'
    ) {
      json(200, { download_url: 'https://files.example/report.pdf?signature=local-test', filename: 'report.pdf' })

      return
    }

    if (request.method === 'GET' && url.pathname === `/api/v1/workflow-domain/runs/${REVIEW_RUN_ID}`) {
      json(runAvailable ? 200 : 503, runAvailable ? reviewRun : { detail: 'local test: Run unavailable' })

      return
    }

    json(404, { detail: 'not found' })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo

  return {
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
    getLastReview: () => lastReview,
    setLoginUser: (id: string) => { loginUserId = id },
    seedAccountSource: () => {
      cloudDocument = { id: ANALYSIS_REVIEW_CLOUD_ID, filename: 'account-private.txt', kind: 'text', status: 'ready',
        created_at: '2026-09-29T01:00:00Z', anchors: [{ id: 'a1', location: { paragraph: 1 }, text: 'Owner-only fixture text' }] }
    },
    holdAnalysisResponse: (suffix: string, renew = false) => {
      let received!: () => void
      const pending = new Promise<void>(resolve => { received = resolve })
      heldResponse = { path: `/api/v1/account/analysis/${suffix}`, received,
        ...(renew ? { renewedToken: `local.${Buffer.from(JSON.stringify({ sub: ANALYSIS_REVIEW_USER_ID, renewed: true })).toString('base64url')}.review` } : {}) }

      return { received: pending, release: () => { const held = heldResponse; heldResponse = null; held?.send?.() } }
    },
    setRelayBaseUrl: (value: string) => {
      relayBaseUrl = value
    },
    setRunAvailable: (value: boolean) => {
      runAvailable = value
    },
    setAnalysisPolicy: (mode: 'cloud' | 'local', configured = mode === 'cloud') => {
      analysisMode = mode
      cloudStorageConfigured = configured
    },
    setAnalysisPolicyUnavailable: (unavailable: boolean) => {failAnalysisPolicy = unavailable},
    policyReadStatuses: () => [...policyStatuses],
    setCloudSourceSnapshot: (label: string | null) => {
      cloudDocument = label ? { id: ANALYSIS_REVIEW_CLOUD_ID, filename: `${label}.txt`, kind: 'text', status: 'ready',
        created_at: '2026-09-29T01:00:00Z', anchors: [{ id: 'a1', location: { paragraph: 1 }, text: `${label} original evidence` }] } : null
      cloudNotes = label ? [{ id: 'external-note', body: `${label} note from another device`, anchor_id: null }] : []
      cloudQuestions = []
    },
    failNextCloudDetail: () => {failCloudDetail = true},
    setWorkflowEnabled: (value: boolean) => {
      workflowEnabled = value
    },
    url: `http://127.0.0.1:${address.port}`
  }
}

test.setTimeout(180_000)

test.beforeAll(
  async () => {
    test.setTimeout(180_000)
    reviewApi = await startPhase1ReviewApi()
    fixture = await setupPackagedMockBackend({
      APEXNODES_API_BASE: reviewApi.url,
      APEXNODES_AUTH_BASE: reviewApi.url
    }, { models: ['mock-model', 'mock-answer-model', 'deepseek-v4-pro', 'deepseek-v4-pro-APEX'], apiPrefixes: ['/v1', '/relay/v1'] }, mockUrl => `auxiliary:
  title_generation:
    enabled: false
  source_question:
    provider: custom
    base_url: ${mockUrl}/v1
    model: mock-model
    api_key: e2e-mock-key
  video_overview:
    provider: custom
    base_url: ${mockUrl}/v1
    model: mock-model
    api_key: e2e-mock-key
`)
    reviewApi.setRelayBaseUrl(`${fixture.mockUrl}/relay/v1`)
    await fixture.page.getByRole('button', { name: '使用自己的密钥' }).click()
    const chooseLater = fixture.page.getByRole('button', { name: '稍后再选择提供方' })

    const providerPickerVisible = await chooseLater.waitFor({ state: 'visible', timeout: 3_000 }).then(
      () => true,
      () => false
    )

    if (providerPickerVisible) {
      await chooseLater.click()
    }

    await waitForAppReady(fixture, 120_000)

    const signIn = await fixture.page.evaluate(() =>
      (window as Window & { hermesDesktop?: { managed?: {
        signIn: (input: { email: string; password: string }) => Promise<{ ok: boolean; hasRelayKey: boolean }>
      } } }).hermesDesktop?.managed?.signIn({ email: 'phase1-review@local.test', password: 'local-review-only' })
    )

    expect(signIn?.ok, String((signIn as { message?: string } | undefined)?.message)).toBe(true)
    expect(signIn?.hasRelayKey).toBe(true)
    await fixture.page.reload()
    await waitForAppReady(fixture, 120_000)
  }
)

test.afterAll(async () => {
  await fixture?.cleanup()
  await reviewApi?.close()
  fixture = null
  reviewApi = null
})

test('fresh packaged app exposes the business workspace without implementation vocabulary', async () => {
  const page = fixture!.page

  await expect(page.getByRole('button', { name: '开始 ⌘ N' })).toBeAttached({ timeout: 60_000 })
  const sidebarButtons = page.locator('[data-sidebar="menu-button"]')

  await expect(sidebarButtons).toHaveCount(BUSINESS_NAV_LABELS.length)

  const businessLabels = (await sidebarButtons.allTextContents())
    .map(label => label.replace(/\s+/g, ' ').trim())
    .map(label => label.replace(/\s*⌘\s*N$/, ''))

  expect(businessLabels).toEqual(BUSINESS_NAV_LABELS)
  await expect(page.getByText(/\b(?:MCP|Skill|Skills)\b/)).toHaveCount(0)
  await expect(page.getByText('模型', { exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: '打开账户菜单: 本地 UI 评审' }).click()
  await expect(page.getByRole('menuitem', { name: '个人资料' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: '设置' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: '项目', exact: true })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: '定时运行', exact: true })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: '连接助手' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: '历史会话' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: '交付物' })).toBeVisible()
  await expect(page.getByText('渠道 · 分身在哪', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('group', { name: '连接你的分身' })).toHaveCount(0)
  await expect(page.getByText(/手机正遥控本机/u)).toHaveCount(0)

  const screenshotRoot = process.env.PHASE1_SCREENSHOT_DIR

  if (screenshotRoot) {
    fs.mkdirSync(screenshotRoot, { recursive: true })
    await page.screenshot({
      animations: 'disabled',
      caret: 'hide',
      path: path.join(screenshotRoot, 'sidebar-account-menu-1220x800.png')
    })
  }

  await page.keyboard.press('Escape')

  for (const [label, title] of [['项目', '项目'], ['定时运行', '定时任务']] as const) {
    await openAccountDestination(page, label)
    await expect(page.getByRole('heading', { name: title, exact: true, level: 1 })).toBeVisible()
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(sidebarButtons).toHaveCount(2)
  }
})

test('hc-845 packaged video picker persists the real runtime preference and default', async () => {
  const { page } = fixture!
  const configPath = path.join(fixture!.sandbox.hermesHome, 'config.yaml')
  await expect.poll(() => fs.readFileSync(configPath, 'utf8')).toMatch(/generation_video_model: doubao-seedance-2-0-mini-260615/)
  await page.getByRole('button', { name: '开始 ⌘ N' }).click()
  await page.getByRole('textbox', { name: '业务目标' }).fill('Local video model preference test')
  await page.getByRole('button', { name: '开始执行' }).click()
  const composer = page.locator('[data-slot="composer-root"]:visible').first()
  await expect(composer).toBeVisible({ timeout: 60_000 })
  await expect(composer.getByRole('button', { name: 'Add context', exact: true })).toBeEnabled()
  await composer.getByRole('button', { name: 'Add context', exact: true }).click()
  await page.getByRole('menuitem', { name: /^视频/ }).hover()
  await page.getByRole('menuitemradio', { name: 'MiniMax H3', exact: true }).click()
  await expect.poll(() => fs.readFileSync(configPath, 'utf8')).toMatch(/generation_video_model: MiniMax-H3/)
  await expect.poll(() => composer.getByRole('textbox').evaluate(element => element.textContent)).toContain('使用模型：MiniMax H3')
  await page.reload()
  await waitForAppReady(fixture!, 120_000)
  const reopened = page.locator('[data-slot="composer-root"]:visible').first()
  await reopened.getByRole('button', { name: 'Add context', exact: true }).click()
  await page.getByRole('menuitem', { name: /^视频/ }).hover()
  await expect(page.getByRole('menuitemradio', { name: 'MiniMax H3', exact: true })).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('menuitemradio', { name: 'Seedance 2.0 Mini', exact: true }).click()
  await expect.poll(() => fs.readFileSync(configPath, 'utf8')).toMatch(/generation_video_model: doubao-seedance-2-0-mini-260615/)
})

test('packaged sidebar uses the APEX app mark and keeps Chinese assistant creation reachable', async () => {
  const page = fixture!.page

  const sessionsTab = page
    .getByRole('button', { exact: true, name: '会话' })
    .or(page.getByRole('tab', { exact: true, name: '会话' }))
    .first()

  const assistantsTab = page
    .getByRole('button', { exact: true, name: '助手' })
    .or(page.getByRole('tab', { exact: true, name: '助手' }))
    .first()

  await expect(sessionsTab).toBeVisible()
  await expect(assistantsTab).toBeVisible()

  const brandImage = page.locator('[data-apex-sidebar-brand] img')

  await expect(brandImage).toHaveCount(1)
  await expect(brandImage).toHaveAttribute('src', /apple-touch-icon\.png$/)
  await assistantsTab.click()

  const createMenu = page.getByRole('button', { name: '添加助手或创建群聊' })
  const screenshotRoot = process.env.PHASE1_SCREENSHOT_DIR

  await expect(createMenu).toBeVisible()
  await createMenu.click()

  if (screenshotRoot) {
    fs.mkdirSync(screenshotRoot, { recursive: true })
    await page.screenshot({
      animations: 'disabled',
      caret: 'hide',
      path: path.join(screenshotRoot, 'assistant-menu-1220x800.png')
    })
  }

  await expect(page.getByRole('menuitem', { exact: true, name: '添加助手' })).toBeEnabled()

  const createGroup = page.getByRole('menuitem', { exact: true, name: '创建群聊' })

  await expect(createGroup).toBeEnabled()
  await createGroup.click()

  const dialog = page.getByRole('dialog', { name: '创建群聊' })

  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('status')).toContainText('至少需要 2 个助手')
  await expect(dialog.getByRole('button', { exact: true, name: '创建群聊' })).toBeDisabled()
  await expect(dialog.getByRole('button', { exact: true, name: '添加助手' })).toBeEnabled()

  if (screenshotRoot) {
    await page.screenshot({
      animations: 'disabled',
      caret: 'hide',
      path: path.join(screenshotRoot, 'assistant-entry-1220x800.png')
    })
  }

  await page.keyboard.press('Escape')
  await sessionsTab.click()
  await expect(page.getByRole('button', { name: '开始 ⌘ N' })).toBeVisible()
})

test('fresh default glass keeps every Phase 1 business route on one opaque APEX shell', async () => {
  const page = fixture!.page

  await page.getByRole('button', { name: '开始 ⌘ N' }).click()
  await expect(page.getByRole('heading', { name: '今天想推进什么业务？', level: 1 })).toBeVisible()
  await expectApexShellPaint(page, 'business-canvas', 'start')

  await openAccountDestination(page, '项目')
  await expect(page.getByRole('heading', { name: '项目', level: 1 })).toBeVisible()
  await expectApexShellPaint(page, 'business-canvas', 'projects')
  await page.getByRole('button', { name: /\[本地测试\] 美国宠物用品机会分析/ }).click()
  await expect(page.locator('[data-project-detail]')).toBeVisible()
  await expectApexShellPaint(page, 'business-canvas', 'project-drawer')
  await page.keyboard.press('Escape')

  await openWorkflowCatalog(page)
  await expectApexShellPaint(page, 'business-canvas', 'workflows')
})

test('primary navigation dismisses only the narrow sidebar overlay, including keyboard activation', async () => {
  const { app, page } = fixture!

  const winHandle = await app.browserWindow(page)
  await winHandle.evaluate(win => {
    win.unmaximize()
    win.setMinimumSize(400, 620)
    win.setBounds({ height: 800, width: 752, x: 0, y: 0 }, false)
  })
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(752)
  await expect(page.locator('[data-sidebar="menu-button"]')).toHaveCount(0)

  for (const [index, label] of BUSINESS_NAV_LABELS.entries()) {
    await page.getByRole('button', { name: /(?:显示|隐藏)侧边栏/ }).click()
    const overlay = page.locator('[data-narrow-overlay]')
    await expect(overlay).toBeVisible()
    const navButton = overlay.getByRole('button', { name: new RegExp(`^${label}(?:\\s|⌘|$)`) })

    if (index === 1) {
      await navButton.focus()
      await page.keyboard.press('Enter')
    } else {
      await navButton.click()
    }

    await expect(overlay).toHaveCount(0)
  }

  for (const label of ['项目', '定时运行'] as const) {
    await page.getByRole('button', { name: /(?:显示|隐藏)侧边栏/ }).click()
    await expect(page.locator('[data-narrow-overlay]')).toBeVisible()
    await openAccountDestination(page, label)
    await expect(page.locator('[data-narrow-overlay]')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: label === '项目' ? '项目' : '定时任务', exact: true, level: 1 })).toBeVisible()
  }

  await winHandle.evaluate(win => win.setBounds({ height: 800, width: 1220, x: 0, y: 0 }, false))
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeGreaterThanOrEqual(1220)
  await expect(page.locator('[data-sidebar="menu-button"]')).toHaveCount(BUSINESS_NAV_LABELS.length)
  await openAccountDestination(page, '项目')
  await expect(page.locator('[data-sidebar="menu-button"]')).toHaveCount(BUSINESS_NAV_LABELS.length)
  await expect(page.getByRole('heading', { name: '项目', level: 1 })).toBeVisible()
})

test('Start mounts exactly one accessible and focusable primary input', async () => {
  const page = fixture!.page

  await page.getByRole('button', { name: '开始 ⌘ N' }).click()
  await expect(page.locator('[data-business-start-home]')).toBeVisible()
  await expect(page.getByRole('textbox')).toHaveCount(1)
  await expect(page.getByRole('textbox', { name: '业务目标' })).toBeVisible()
  await expect(page.locator('[data-slot="composer-root"]')).toHaveCount(0)

  await page.getByRole('textbox', { name: '业务目标' }).fill('本地测试焦点顺序')
  await page.getByRole('textbox', { name: '业务目标' }).focus()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: '开始执行' })).toBeFocused()
  await page.getByRole('textbox', { name: '业务目标' }).fill('')
})

test('hc-841 Start keeps the primary task brief readable without exposing internal execution details', async () => {
  const { app, page } = fixture!

  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]

    win?.unmaximize()
    win?.setBounds({ height: 900, width: 1440, x: 0, y: 0 }, false)
    win?.show()
    win?.focus()
  })
  await page.bringToFront()
  await page.getByRole('button', { name: '开始 ⌘ N' }).click()

  const content = page.locator('[data-business-start-content]')
  const launcher = page.locator('[data-business-goal-launcher]')
  const textbox = page.getByRole('textbox', { name: '业务目标' })

  await expect(content).toBeVisible()
  await expect(launcher).toBeVisible()
  await expect(textbox).toBeVisible()

  const geometry = await page.evaluate(() => {
    const contentBox = document.querySelector('[data-business-start-content]')!.getBoundingClientRect()
    const launcherBox = document.querySelector('[data-business-goal-launcher]')!.getBoundingClientRect()
    const textboxBox = document.querySelector('[data-slot="business-goal-input"]')!.getBoundingClientRect()

    return {
      contentWidth: contentBox.width,
      launcherWidth: launcherBox.width,
      textboxHeight: textboxBox.height
    }
  })

  expect(geometry.contentWidth).toBeGreaterThanOrEqual(860)
  expect(geometry.contentWidth).toBeLessThanOrEqual(900)
  expect(geometry.launcherWidth).toBeCloseTo(geometry.contentWidth, 0)
  expect(geometry.textboxHeight).toBeGreaterThanOrEqual(128)

  await page.getByRole('button', { name: /拆解并复刻爆款视频/ }).click()
  await expect(textbox).toHaveValue(
    '请分析这个爆款短视频，并参考它的结构和节奏，用我提供或已获授权的素材制作一条可编辑的同类视频。完成后交付成片和工程文件；如果素材不足，请直接告诉我需要补充什么。'
  )
  await expect(textbox).not.toHaveValue(/豆包|Hypit|WhisperX|Brief|Treatment|复现命令|价格|套餐/u)

  const screenshotRoot = process.env.HC841_SCREENSHOT_DIR

  const screenshotPath = screenshotRoot
    ? path.join(screenshotRoot, 'start-task-brief-1440x900.png')
    : test.info().outputPath('start-task-brief-1440x900.png')

  if (screenshotRoot) {
    fs.mkdirSync(screenshotRoot, { recursive: true })
  }

  await page.screenshot({ animations: 'disabled', caret: 'hide', path: screenshotPath })
})

test('hc-840 Start presents three readable video task rows with generated artwork', async () => {
  const { app, page } = fixture!

  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]

    win?.unmaximize()
    win?.setBounds({ height: 800, width: 1220, x: 0, y: 0 }, false)
    win?.show()
    win?.focus()
  })
  await page.bringToFront()
  await page.getByRole('button', { name: '开始 ⌘ N' }).click()
  await expect(page.getByRole('heading', { name: '选择一个任务开始', level: 2 })).toBeVisible()

  const taskRows = page.locator('[data-start-recommended-workflows] [data-workflow-starter="shelf"]')
  await expect(taskRows).toHaveCount(3)
  await expect(
    page.locator('[data-start-recommended-workflows] [data-workflow-artwork="video-transcript"]')
  ).toBeVisible()
  await expect(
    page.locator('[data-start-recommended-workflows] [data-workflow-artwork="viral-video-remake"]')
  ).toBeVisible()
  await expect(
    page.locator('[data-start-recommended-workflows] [data-workflow-artwork="social-intelligence"]')
  ).toBeVisible()
  await expect(
    page.getByText(
      '支持的平台：抖音、小红书、微信视频号、快手、哔哩哔哩、YouTube、TikTok 和 Instagram；也可以直接上传视频。'
    )
  ).toBeVisible()

  const rowGeometry = await taskRows.evaluateAll(rows =>
    rows.map(row => {
      const box = row.getBoundingClientRect()

      return { bottom: box.bottom, left: box.left, right: box.right, top: box.top }
    })
  )

  expect(rowGeometry[1].top).toBeGreaterThan(rowGeometry[0].bottom)
  expect(rowGeometry[2].top).toBeGreaterThan(rowGeometry[1].bottom)
  expect(new Set(rowGeometry.map(row => Math.round(row.left))).size).toBe(1)
  expect(new Set(rowGeometry.map(row => Math.round(row.right))).size).toBe(1)

  const screenshotRoot = process.env.HC840_SCREENSHOT_DIR

  const screenshotPath = screenshotRoot
    ? path.join(screenshotRoot, 'start-video-tasks-1220x800.png')
    : test.info().outputPath('start-video-tasks-1220x800.png')

  if (screenshotRoot) {
    fs.mkdirSync(screenshotRoot, { recursive: true })
  }

  await page.screenshot({ animations: 'disabled', caret: 'hide', path: screenshotPath })
})

test('packaged workflow entries follow each real content container around the sidebar edge', async () => {
  const { app, page } = fixture!

  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setBounds({ height: 800, width: 1220, x: 0, y: 0 }, false)
  )

  const surfaces = [
    {
      cases: [
        { columns: 1, width: 700 },
        { columns: 1, width: 752 },
        { columns: 1, width: 899 },
        { columns: 1, width: 900 },
        { columns: 1, width: 1000 },
        { columns: 1, width: 1220 },
        { columns: 1, width: 1235 }
      ],
      key: 'start',
      nav: '开始',
      selector: '[data-start-recommended-workflows]',
      variant: 'shelf'
    },
    {
      cases: [
        { columns: 1, width: 700 },
        { columns: 1, width: 752 },
        { columns: 3, width: 899 },
        { columns: 2, width: 900 },
        { columns: 3, width: 1000 },
        { columns: 3, width: 1220 },
        { columns: 3, width: 1235 }
      ],
      key: 'workflows',
      nav: '工作流',
      selector: '[data-recommended-workflows]',
      variant: 'featured'
    }
  ] as const

  for (const surface of surfaces) {
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setBounds({ height: 800, width: 1220, x: 0, y: 0 }, false)
    )
    await page.bringToFront()
    await page.waitForTimeout(400)

    if (surface.nav === '工作流') {
      await openWorkflowCatalog(page)
    } else {
      await page.locator('[data-sidebar="menu-button"]').filter({ hasText: surface.nav }).first().click()
    }

    await expect(page.locator(surface.selector)).toBeVisible()

    for (const testCase of surface.cases) {
      const bounds = await app.evaluate(({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows()[0]

        if (!win) {
          return null
        }

        win.unmaximize()
        win.setMinimumSize(400, 620)
        win.setBounds({ height: 800, width: size.width, x: 0, y: 0 }, false)
        win.show()
        win.focus()

        return win.getBounds()
      }, testCase)

      await page.bringToFront()
      await page.waitForTimeout(400)

      const metrics = await page.locator(surface.selector).evaluate((element, variant) => {
        const gridBox = element.getBoundingClientRect()
        const gridStyle = window.getComputedStyle(element)
        const rootFontSize = Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize)

        const cards = Array.from(element.querySelectorAll<HTMLElement>(`[data-workflow-starter="${variant}"]`))
        const cardBoxes = cards.map(card => card.getBoundingClientRect())
        const firstRowTop = Math.min(...cardBoxes.map(box => box.top))

        const lineCount = (node: Element | null) => {
          if (!node) {
            return 0
          }

          const range = document.createRange()
          range.selectNodeContents(node)

          const tops = Array.from(range.getClientRects())
            .filter(rect => rect.width > 0 && rect.height > 0)
            .map(rect => Math.round(rect.top))

          return new Set(tops).size
        }

        return {
          cardWidths: cardBoxes.map(box => box.width),
          columnGap: Number.parseFloat(gridStyle.columnGap),
          copyWidths: cards.map(card => card.querySelector<HTMLElement>('[data-workflow-card-copy]')?.clientWidth ?? 0),
          firstRowColumns: cardBoxes.filter(box => Math.abs(box.top - firstRowTop) <= 1).length,
          fullyContained: cardBoxes.every(box => box.left >= gridBox.left - 1 && box.right <= gridBox.right + 1),
          gridWidth: gridBox.width,
          rootClientWidth: document.documentElement.clientWidth,
          rootFontSize,
          rootScrollWidth: document.documentElement.scrollWidth,
          summaryLines: cards.map(card => lineCount(card.querySelector('[data-workflow-card-summary]'))),
          summariesUnclipped: cards.every(card => {
            const summary = card.querySelector<HTMLElement>('[data-workflow-card-summary]')

            return summary !== null && summary.scrollHeight <= summary.clientHeight + 1
          }),
          titleLines: cards.map(card => lineCount(card.querySelector('[data-workflow-card-title]'))),
          titlesUnclipped: cards.every(card => {
            const title = card.querySelector<HTMLElement>('[data-workflow-card-title]')

            return title !== null && title.scrollHeight <= title.clientHeight + 1
          })
        }
      }, surface.variant)

      const minimumTrackWidth = 14.25 * metrics.rootFontSize
      const threeColumnThreshold = minimumTrackWidth * 3 + metrics.columnGap * 2

      await test.info().attach(`${surface.key}-workflow-entry-geometry-${testCase.width}`, {
        body: JSON.stringify({ ...metrics, minimumTrackWidth, threeColumnThreshold }, null, 2),
        contentType: 'application/json'
      })

      expect(bounds?.width).toBe(testCase.width)
      expect(metrics.rootFontSize).toBe(17)
      expect(metrics.firstRowColumns).toBe(testCase.columns)
      expect(Math.min(...metrics.cardWidths)).toBeGreaterThanOrEqual(minimumTrackWidth - 1)
      expect(Math.min(...metrics.copyWidths)).toBeGreaterThanOrEqual(110)
      expect(Math.max(...metrics.titleLines)).toBeLessThanOrEqual(2)
      expect(Math.max(...metrics.summaryLines)).toBeLessThanOrEqual(3)
      expect(metrics.titlesUnclipped).toBe(true)
      expect(metrics.summariesUnclipped).toBe(true)
      expect(metrics.fullyContained).toBe(true)
      expect(metrics.rootScrollWidth).toBeLessThanOrEqual(metrics.rootClientWidth)

      if (testCase.width >= 760 && testCase.columns === 3) {
        expect(metrics.gridWidth).toBeGreaterThanOrEqual(threeColumnThreshold - 1)
      }

      if (testCase.width >= 760 && testCase.columns === 2) {
        expect(metrics.gridWidth).toBeLessThan(threeColumnThreshold)
      }
    }
  }
})

test('packaged Phase 1 pages keep local review data explicit across the approved window matrix', async () => {
  const { app, page } = fixture!
  const testInfo = test.info()
  const screenshotRoot = process.env.PHASE1_SCREENSHOT_DIR

  if (screenshotRoot) {
    fs.mkdirSync(screenshotRoot, { recursive: true })
  }

  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setBounds({ height: 800, width: 1220, x: 0, y: 0 }, false)
  )
  await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '开始' }).first().click()
  await expect(page.locator('[data-business-start-shelf]')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('[本地测试] 美国宠物用品机会分析')).toBeVisible()

  const pages = [
    { name: 'start', nav: '开始 ⌘ N', title: '今天想推进什么业务？' },
    { name: 'projects', nav: '项目', title: '项目' },
    { name: 'workflows', nav: '工作流', title: '工作流' },
    { name: 'scheduled-runs', nav: '定时运行', title: '定时任务' },
    { name: 'deliverables', nav: '交付物', title: '交付物' }
  ] as const

  for (const phasePage of pages) {
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]

      if (win) {
        win.unmaximize()
        win.setMinimumSize(400, 620)
        win.setSize(1220, 800, false)
      }
    })

    if (phasePage.nav === '工作流') {
      await openWorkflowCatalog(page)
    } else if (phasePage.nav === '交付物') {
      await openDeliverables(page)
    } else if (phasePage.nav === '项目' || phasePage.nav === '定时运行') {
      await openAccountDestination(page, phasePage.nav)
    } else {
      await page
        .locator('[data-sidebar="menu-button"]')
        .filter({ hasText: phasePage.nav.replace(' ⌘ N', '') })
        .first()
        .click()
    }

    await expect(page.getByRole('heading', { name: phasePage.title, level: 1 })).toBeVisible()

    for (const viewport of PHASE1_VIEWPORTS) {
      const bounds = await app.evaluate(({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows()[0]

        if (!win) {
          return null
        }

        win.unmaximize()
        win.setMinimumSize(400, 620)

        win.setSimpleFullScreen(false)
        win.setBounds({ height: size.height, width: size.width, x: 0, y: 0 }, false)
        win.show()
        win.focus()

        return win.getBounds()
      }, viewport)

      await page.bringToFront()
      await page.waitForTimeout(400)

      expect(bounds?.width).toBe(viewport.width)
      await expectWindowHeight(app, bounds?.height, viewport.height)

      const layout = await page.evaluate(() => ({
        clientHeight: document.documentElement.clientHeight,
        clientWidth: document.documentElement.clientWidth,
        scrollHeight: document.documentElement.scrollHeight,
        scrollWidth: document.documentElement.scrollWidth
      }))

      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth)

      const screenshotName = `${phasePage.name}-${viewport.width}x${viewport.height}.png`
      await page.screenshot({
        animations: 'disabled',
        caret: 'hide',
        path: screenshotRoot ? path.join(screenshotRoot, screenshotName) : testInfo.outputPath(screenshotName)
      })

      if (viewport.name === 'narrow-752') {
        const sidebarTrigger = page.getByRole('button', { name: /(?:显示|隐藏)侧边栏/ })

        await expect(sidebarTrigger).toBeVisible()
        await expect(page.locator('[data-sidebar="menu-button"]')).toHaveCount(0)

        if (process.platform === 'darwin') {
          const triggerBox = await sidebarTrigger.boundingBox()

          expect(triggerBox?.x).toBeGreaterThanOrEqual(70)
        }

        const lowerContent = {
          start: page.getByRole('heading', { name: '应用连接', level: 2 }),
          projects: page.getByText('[本地测试] APEX GEO 品牌诊断', { exact: true }),
          workflows: page.getByText('[本地测试] 我的选品流程', { exact: true }),
          'scheduled-runs': page.getByText('暂无排程任务', { exact: true }),
          deliverables: page.getByText('[本地测试] 美国宠物用品分析报告', { exact: true })
        }[phasePage.name]

        await lowerContent.scrollIntoViewIfNeeded()
        await expect(lowerContent).toBeVisible()

        const heading = page.getByRole('heading', { name: phasePage.title, level: 1 })
        await heading.scrollIntoViewIfNeeded()
        await expect(heading).toBeVisible()
      }
    }
  }
})

test('packaged Deliverables and Activity keep typed targets, review notes and renderer-safe data', async () => {
  const { app, page } = fixture!
  const screenshotRoot = process.env.HC831_SCREENSHOT_DIR

  if (screenshotRoot) {
    fs.mkdirSync(screenshotRoot, { recursive: true })
  }

  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setBounds({ height: 800, width: 1220, x: 0, y: 0 }, false)
  )
  await openDeliverables(page)

  const opener = page.getByRole('button', { name: /\[本地测试\] 美国宠物用品分析报告/ })

  await expect(page.getByRole('heading', { level: 1, name: '交付物' })).toBeVisible()
  await expect(opener).toBeVisible()
  await opener.focus()
  await opener.click()

  const drawer = page.getByRole('dialog', { name: '交付物详情' })

  await expect(drawer).toBeVisible()
  await expectDrawerBelowNativeChrome(drawer)
  await expect(drawer.getByRole('heading', { level: 1, name: '[本地测试] 美国宠物用品分析报告' })).toBeVisible()
  await expect(drawer.getByText('[本地测试] 有证据的美国宠物用品市场结论。')).toBeVisible()
  await expect(drawer.getByText('来源采集时间')).toBeVisible()
  await expect(drawer.getByText('引用覆盖率', { exact: true })).toBeVisible()
  await expect(drawer.getByText('80%')).toBeVisible()
  await expect(drawer.getByText('[本地测试] 公开市场来源')).toBeVisible()
  await expect(drawer.getByText('[本地测试] 请补充主要来源。')).toBeVisible()
  await expect(drawer.getByRole('button', { name: '打开成果' })).toBeEnabled()
  await expect(
    drawer.getByText(
      /e2e-payload-secret|private-schema|tenant-user|e2e-evidence-secret|e2e-next-action-secret|e2e-file-secret|e2e-verifier-secret/
    )
  ).toHaveCount(0)

  for (const viewport of [
    { height: 800, width: 1220 },
    { height: 800, width: 752 }
  ]) {
    await app.evaluate(({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]

      win?.unmaximize()
      win?.setMinimumSize(400, 620)
      win?.setBounds({ height: size.height, width: size.width, x: 0, y: 0 }, false)
    }, viewport)
    await page.bringToFront()
    await page.waitForTimeout(400)
    await expectDrawerBelowNativeChrome(drawer)
    await expect(drawer).toHaveAttribute('data-layout', viewport.width < 1100 ? 'fullscreen' : 'drawer')

    const screenshotName = `deliverable-detail-${viewport.width}x${viewport.height}.png`
    await page.screenshot({
      animations: 'disabled',
      caret: 'hide',
      path: screenshotRoot ? path.join(screenshotRoot, screenshotName) : test.info().outputPath(screenshotName)
    })
  }

  const reviewNote = '请在结论页增加第二个公开来源。'
  await drawer.getByRole('textbox', { name: '修改说明' }).fill(reviewNote)
  await drawer.getByRole('button', { name: '需要修改' }).click()
  await expect
    .poll(() => reviewApi?.getLastReview())
    .toEqual({ metrics: {}, nextAction: null, notes: reviewNote, status: 'changes_requested' })

  await page.keyboard.press('Escape')
  await expect(drawer).toHaveCount(0)
  await expect(opener).toBeFocused()

  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setBounds({ height: 800, width: 1220, x: 0, y: 0 }, false)
  )
  await page.getByRole('button', { name: '打开账户菜单: 本地 UI 评审' }).click()
  await page.getByRole('menuitem', { name: '历史会话' }).click()
  await expect(page.getByRole('heading', { level: 1, name: '历史' })).toBeVisible()
  await page.getByRole('button', { name: '业务活动' }).click()

  const activity = page.getByRole('button', { name: /\[本地测试\] 审阅意见已保存/ })
  await expect(activity).toBeVisible()
  await activity.focus()
  await activity.click()
  await expect(page.getByRole('dialog', { name: '交付物详情' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1, name: '[本地测试] 美国宠物用品分析报告' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(activity).toBeFocused()
})

test('packaged real Run drawer preserves context, safe data and focus across the approved window matrix', async () => {
  const { app, page } = fixture!
  const testInfo = test.info()
  const screenshotRoot = process.env.HC820_SCREENSHOT_DIR

  if (screenshotRoot) {
    fs.mkdirSync(screenshotRoot, { recursive: true })
  }

  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setBounds({ height: 800, width: 1220, x: 0, y: 0 }, false)
  )
  await page.getByRole('button', { name: '开始 ⌘ N' }).click()
  const opener = page.getByRole('button', { name: /\[本地测试\] 美国宠物用品机会分析/ })

  await expect(opener).toBeVisible()
  await opener.focus()
  await opener.click()
  await page.locator('[data-project-detail]').getByRole('button', { name: '打开当前运行', exact: true }).and(page.locator('[data-variant="default"]')).click()

  const drawer = page.getByRole('dialog', { name: '工作流运行' })

  await expect(drawer).toBeVisible()
  await expect(drawer.getByText('[本地测试] 验证真实 Run 抽屉、事件顺序与诚实空态。')).toBeVisible()
  await expect(drawer.getByText('暂时没有可展示的阶段进度')).toBeVisible()
  await expect(drawer.getByRole('button', { name: '打开交付物' })).toBeEnabled()
  await expect(drawer.getByText(/伪造阶段|88%|e2e-payload-secret|private-schema|tenant-user/)).toHaveCount(0)
  await expect(drawer.getByRole('heading', { name: '工作流运行', level: 1 })).toBeVisible()
  expect(await drawer.locator('[data-run-scroll-container]').evaluate(element => element.scrollTop)).toBe(0)

  for (const viewport of [...PHASE1_VIEWPORTS, { height: 800, width: 899 }, { height: 800, width: 900 }]) {
    const bounds = await app.evaluate(({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]

      if (!win) {
        return null
      }

      win.unmaximize()
      win.setMinimumSize(400, 620)
      win.setBounds({ height: size.height, width: size.width, x: 0, y: 0 }, false)
      win.show()
      win.focus()

      return win.getBounds()
    }, viewport)

    await page.bringToFront()
    await page.waitForTimeout(400)

    const layout = await drawer.evaluate(element => {
      const root = document.documentElement
      const rect = element.getBoundingClientRect()

      return {
        activeInside: element.contains(document.activeElement),
        clientWidth: root.clientWidth,
        drawerLeft: rect.left,
        drawerRight: rect.right,
        drawerWidth: rect.width,
        layout: element.getAttribute('data-layout'),
        scrollWidth: root.scrollWidth
      }
    })

    const runScroll = drawer.locator('[data-run-scroll-container]')
    const runTitle = drawer.getByRole('heading', { name: '工作流运行', level: 1 })
    const reviewHeading = drawer.getByRole('heading', { name: '需要审阅', level: 2 })
    const approveButton = drawer.getByRole('button', { name: '批准交付物' })
    const stageHeading = drawer.getByRole('heading', { name: '阶段进度', level: 2 })
    const stageSection = stageHeading.locator('..')

    expect(bounds?.width).toBe(viewport.width)
    await expectWindowHeight(app, bounds?.height, viewport.height)
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth)

    if (viewport.width < 900) {
      expect(layout.layout).toBe('fullscreen')
      expect(layout.drawerWidth).toBeCloseTo(layout.clientWidth, 0)
      expect(layout.drawerLeft).toBeCloseTo(0, 0)
      expect(layout.drawerRight).toBeCloseTo(layout.clientWidth, 0)
    } else {
      expect(layout.layout).toBe('drawer')
      expect(layout.drawerWidth).toBeCloseTo(Math.min(540, layout.clientWidth - 16), 0)
      expect(layout.drawerRight).toBeCloseTo(layout.clientWidth, 0)
      expect(layout.drawerLeft).toBeGreaterThan(0)
    }

    expect(layout.activeInside).toBe(true)
    expect(await runScroll.evaluate(element => element.scrollTop)).toBe(0)
    await expect(runTitle).toBeVisible()

    await expectDrawerBelowNativeChrome(drawer)
    await expectReadablePageGutters(runScroll)

    const [drawerBox, runTitleBox, reviewBox, approveBox, stageBox, stageSectionBox] = await Promise.all([
      drawer.boundingBox(),
      runTitle.boundingBox(),
      reviewHeading.boundingBox(),
      approveButton.boundingBox(),
      stageHeading.boundingBox(),
      stageSection.boundingBox()
    ])

    expect(runTitleBox?.y).toBeGreaterThanOrEqual(drawerBox?.y ?? 0)
    expect(reviewBox?.y).toBeLessThan(stageBox?.y ?? Number.POSITIVE_INFINITY)
    expect(approveBox?.y).toBeLessThan(stageBox?.y ?? Number.POSITIVE_INFINITY)
    expect((approveBox?.y ?? 0) + (approveBox?.height ?? 0)).toBeLessThanOrEqual(
      (drawerBox?.y ?? 0) + (drawerBox?.height ?? 0)
    )
    expect(stageSectionBox?.height).toBeLessThan(160)

    const progressName = `run-progress-${viewport.width}x${viewport.height}.png`
    await page.screenshot({
      animations: 'disabled',
      caret: 'hide',
      path: screenshotRoot ? path.join(screenshotRoot, progressName) : testInfo.outputPath(progressName)
    })

    await drawer.getByRole('tab', { name: '执行详情' }).click()
    await expect(drawer.getByText('运行已排队')).toBeVisible()
    await expect(drawer.getByText('运行已开始')).toBeVisible()
    await expect(drawer.getByText('工具活动')).toBeVisible()
    await expect(drawer.getByText('已加入队列，准备开始。')).toBeVisible()
    await expect(drawer.getByText('APEX 已开始处理。')).toBeVisible()
    await expect(drawer.getByText('APEX / Hermes 使用了工具，参数和结果已隐藏。')).toBeVisible()
    await expect(drawer.getByText('第 1 次尝试（最多 2 次）')).toBeVisible()

    const eventOrder = await drawer.locator('text=/^#\\d+/').allTextContents()
    expect(eventOrder.map(item => Number(item.match(/^#(\d+)/)?.[1]))).toEqual([1, 2, 3])
    await expect(drawer.getByText(/e2e-raw-result-secret|private-event-key|e2e-private-stack/)).toHaveCount(0)

    const detailsName = `run-details-${viewport.width}x${viewport.height}.png`
    await page.screenshot({
      animations: 'disabled',
      caret: 'hide',
      path: screenshotRoot ? path.join(screenshotRoot, detailsName) : testInfo.outputPath(detailsName)
    })
    await runScroll.evaluate(element => {
      element.scrollTop = 180
    })
    await drawer.getByRole('tab', { name: '进展' }).click()
    expect(await runScroll.evaluate(element => element.scrollTop)).toBe(0)
    await expect(runTitle).toBeVisible()
  }

  for (let index = 0; index < 6; index += 1) {
    await page.keyboard.press('Tab')
    expect(await drawer.evaluate(element => element.contains(document.activeElement))).toBe(true)
  }

  await page.keyboard.press('Escape')
  await expect(drawer).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '今天想推进什么业务？', level: 1 })).toBeVisible()
  await expect(page.getByRole('button', { name: /\[本地测试\] 美国宠物用品机会分析/ })).toBeFocused()
})

for (const surfaceName of ['run-error', 'legacy-projects'] as const) {
  test(`packaged ${surfaceName} preserves page gutters across native windows`, async () => {
    const { app, page } = fixture!
    const screenshotRoot = process.env.HC820_SCREENSHOT_DIR

    if (screenshotRoot) {
      fs.mkdirSync(screenshotRoot, { recursive: true })
    }

    try {
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.setBounds({ height: 800, width: 1220, x: 0, y: 0 }, false)
      )
      reviewApi!.setRunAvailable(surfaceName !== 'run-error')
      reviewApi!.setWorkflowEnabled(surfaceName !== 'legacy-projects')
      await page.reload()
      await waitForAppReady(fixture!, 120_000)

      if (surfaceName === 'run-error') {
        await page.getByRole('button', { name: '开始 ⌘ N' }).click()
        await page.getByRole('button', { name: /\[本地测试\] 美国宠物用品机会分析/ }).click()
        await page.locator('[data-project-detail]').getByRole('button', { name: '打开当前运行', exact: true }).and(page.locator('[data-variant="default"]')).click()
      } else {
        await openAccountDestination(page, '项目')
      }

      const surface =
        surfaceName === 'run-error'
          ? page.getByRole('heading', { name: '运行暂时不可用', level: 2 }).locator('..').locator('..').locator('..')
          : page.locator('[data-legacy-projects]')

      await expect(surface).toBeVisible()

      for (const viewport of PHASE1_VIEWPORTS) {
        const bounds = await app.evaluate(({ BrowserWindow }, size) => {
          const win = BrowserWindow.getAllWindows()[0]!
          win.unmaximize()
          win.setBounds({ height: size.height, width: size.width, x: 0, y: 0 }, false)
          win.show()
          win.focus()

          return win.getBounds()
        }, viewport)

        expect(bounds.width).toBe(viewport.width)
        await expectWindowHeight(app, bounds.height, viewport.height)
        await page.bringToFront()
        await page.waitForTimeout(400)

        if (surfaceName === 'run-error') {
          await expectDrawerBelowNativeChrome(page.locator('[data-route-drawer]'))
        }

        await expectReadablePageGutters(surface)
        const name = `${surfaceName}-${viewport.width}x${viewport.height}.png`
        await page.screenshot({
          animations: 'disabled',
          caret: 'hide',
          path: screenshotRoot ? path.join(screenshotRoot, name) : test.info().outputPath(name)
        })
      }

      if (surfaceName === 'run-error') {
        await page.keyboard.press('Escape')
      }
    } finally {
      reviewApi!.setRunAvailable(true)
      reviewApi!.setWorkflowEnabled(true)
      await page.evaluate(() => {
        window.location.hash = '/'
      })
      await page.reload()
      await waitForAppReady(fixture!, 120_000)
    }
  })
}

test('packaged Settings shows the running APEX app version separately from the engine', async () => {
  const { app, page } = fixture!

  const version = await page.evaluate(() => (window as Window & { hermesDesktop?: {
    getVersion: () => Promise<{ appVersion: string; engineVersion: string }>
  } }).hermesDesktop?.getVersion())

  expect(version?.appVersion).toBe(PACKAGED_VERSION)
  expect(version?.engineVersion).toBeTruthy()

  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setBounds({ height: 800, width: 1220, x: 0, y: 0 }, false)
  )
  await openWorkflowCatalog(page)
  await page.getByRole('button', { name: /打开账户菜单.*本地 UI 评审/ }).click()
  await page.getByRole('menuitem', { name: '设置' }).click()
  await expect(page.getByText(`版本 ${PACKAGED_VERSION}`, { exact: true }).first()).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: '关闭设置' }).click()
  await expect(page.getByRole('heading', { name: '工作流', level: 1 })).toBeVisible()
})

test('a legacy Project envelope opens an honest detail before its goal can continue', async () => {
  const { app, page } = fixture!

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ height: 800, width: 1220 }))
  await openAccountDestination(page, '项目')
  const row = page.getByRole('button', { name: /尚未启动的业务目标/ })

  await expect(row).toBeVisible()
  await row.click()
  const detail = page.locator('[data-project-detail]')

  await expect(detail).toBeVisible()
  await expect(detail.getByText('运行摘要暂时不可用')).toBeVisible()
  await expect(detail.getByText(/当前接口没有提供运行摘要/)).toBeVisible()
  await expect(detail.getByText('[本地测试] 尚未启动的业务目标', { exact: true })).toHaveCount(1)
  await expect(page.getByRole('textbox', { name: '业务目标' })).toHaveCount(0)
  await expect(detail.getByText(/百分比|待处理事项/)).toHaveCount(0)
  await expect(detail.locator('[data-project-completion]')).toContainText('0 / 0')
  await expect(detail.locator('[data-project-completion]').getByRole('button', { name: '完成项目', exact: true })).toBeDisabled()

  for (const viewport of [...PHASE1_VIEWPORTS, { height: 800, width: 1099 }, { height: 800, width: 1100 }]) {
    const bounds = await app.evaluate(({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]!
      win.unmaximize()
      win.setBounds({ height: size.height, width: size.width, x: 0, y: 0 }, false)

      return win.getBounds()
    }, viewport)

    expect(bounds.width).toBe(viewport.width)
    await expectWindowHeight(app, bounds.height, viewport.height)
    await page.waitForTimeout(400)
    const drawer = page.locator('[data-route-drawer]')
    await expectDrawerBelowNativeChrome(drawer)
    await expect(drawer).toHaveAttribute('data-layout', viewport.width < 1100 ? 'fullscreen' : 'drawer')
    const box = await drawer.boundingBox()
    const rem = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize))
    expect(box?.width).toBeCloseTo(
      viewport.width < 1100 ? viewport.width : Math.min(42 * rem, viewport.width * 0.52),
      0
    )
    const name = `project-detail-${viewport.width}x${viewport.height}.png`
    const screenshotRoot = process.env.HC820_SCREENSHOT_DIR

    if (screenshotRoot) {
      fs.mkdirSync(screenshotRoot, { recursive: true })
    }

    await page.screenshot({
      animations: 'disabled',
      caret: 'hide',
      path: screenshotRoot ? path.join(screenshotRoot, name) : test.info().outputPath(name)
    })
  }

  await page.keyboard.press('Escape')
  await expect(detail).toHaveCount(0)
  await expect(row).toBeFocused()
  await row.click()
  await expect(detail).toBeVisible()
  await page.getByRole('button', { name: '继续这个目标' }).click()
  await expect(page.getByRole('textbox', { name: '业务目标' })).toHaveValue('[本地测试] 尚未启动的业务目标')
})

test('workflow Run uses a roomy drawer on wide windows and a collision-free full-screen surface when narrow', async () => {
  const { app, page } = fixture!
  const screenshotRoot = process.env.PHASE1_SCREENSHOT_DIR

  if (screenshotRoot) {
    fs.mkdirSync(screenshotRoot, { recursive: true })
  }

  for (const viewport of PHASE1_VIEWPORTS) {
    await app.evaluate(({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]

      win?.unmaximize()
      win?.setMinimumSize(400, 620)
      win?.setBounds({ height: size.height, width: size.width, x: 0, y: 0 }, false)
    }, viewport)
    await page.bringToFront()
    await page.waitForTimeout(400)

    if (viewport.width < 900) {
      await page.getByRole('button', { name: /(?:显示|隐藏)侧边栏/ }).click()
    }

    await openAccountDestination(page, '项目')
    await page.getByRole('button', { name: /\[本地测试\] 美国宠物用品机会分析/ }).click()
    await page.locator('[data-project-detail]').getByRole('button', { name: '打开当前运行', exact: true }).and(page.locator('[data-variant="default"]')).click()

    const drawer = page.locator('[data-route-drawer]')
    const content = drawer.locator('section').first()
    const close = drawer.getByRole('button', { name: '关闭' })
    const approve = drawer.getByRole('button', { name: '批准交付物' })

    await expect(drawer).toBeVisible()
    await expect(content).toBeVisible()
    await expect(close).toBeVisible()
    await expect(approve).toBeVisible()
    await expect(drawer).toHaveAttribute('data-layout', viewport.width >= 900 ? 'drawer' : 'fullscreen')

    const geometry = await page.evaluate(() => {
      const drawerElement = document.querySelector<HTMLElement>('[data-route-drawer]')
      const contentElement = drawerElement?.querySelector<HTMLElement>('section > div')
      const closeElement = drawerElement?.querySelector<HTMLElement>('button[aria-label="关闭"]')

      const approveElement = Array.from(drawerElement?.querySelectorAll<HTMLElement>('button') ?? []).find(button =>
        button.textContent?.includes('批准交付物')
      )

      if (!drawerElement || !contentElement || !closeElement || !approveElement) {
        return null
      }

      const drawerBox = drawerElement.getBoundingClientRect()
      const contentBox = contentElement.getBoundingClientRect()
      const closeBox = closeElement.getBoundingClientRect()
      const approveBox = approveElement.getBoundingClientRect()

      const overlaps = !(
        closeBox.right <= approveBox.left ||
        closeBox.left >= approveBox.right ||
        closeBox.bottom <= approveBox.top ||
        closeBox.top >= approveBox.bottom
      )

      return {
        contentInset: contentBox.left - drawerBox.left,
        drawerWidth: drawerBox.width,
        overlaps,
        rootClientWidth: document.documentElement.clientWidth,
        rootScrollWidth: document.documentElement.scrollWidth
      }
    })

    expect(geometry).not.toBeNull()
    expect(geometry!.contentInset).toBeGreaterThanOrEqual(23)
    expect(geometry!.overlaps).toBe(false)
    expect(geometry!.rootScrollWidth).toBeLessThanOrEqual(geometry!.rootClientWidth)

    if (viewport.width >= 900) {
      expect(geometry!.drawerWidth).toBeCloseTo(Math.min(540, geometry!.rootClientWidth - 16), 0)
    } else {
      expect(geometry!.drawerWidth).toBeCloseTo(geometry!.rootClientWidth, 0)
    }

    const screenshotName = `workflow-run-${viewport.width}x${viewport.height}.png`

    await page.screenshot({
      animations: 'disabled',
      caret: 'hide',
      path: screenshotRoot ? path.join(screenshotRoot, screenshotName) : test.info().outputPath(screenshotName)
    })
    await close.click()
    await expect(drawer).toHaveCount(0)
  }
})

test('local workflow catalog opens template details before project attachment', async () => {
  const { app, page } = fixture!

  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setBounds({ height: 800, width: 1220, x: 0, y: 0 }, false)
  )
  await openWorkflowCatalog(page)
  await expect(page.getByText(/本地测试数据：此目录仅用于实包视觉与交互验收/)).toBeVisible()
  await page.getByRole('button', { name: /竞品监控/ }).click()

  const details = page.getByRole('dialog', { name: '竞品监控' })

  await expect(details).toContainText('版本 1')
  await expect(details).toContainText('示例目标')
  await expect(details).toContainText('加入项目不会自动运行')
  await expect(details.getByRole('button', { name: '加入当前项目' })).toBeEnabled()
  await expect(details.getByRole('button', { name: '加入已有项目' })).toBeEnabled()
  await expect(details.getByRole('button', { name: '新建项目并加入' })).toBeEnabled()
  await details.getByRole('button', { name: '取消' }).click()
  await expect(details).toHaveCount(0)
})

test('packaged plain goal stays separate from a previewed workflow and starts a real chat turn', async () => {
  const { app, page } = fixture!
  const prompt = '分析美国宠物用品市场，并生成选品报告和上架素材'
  const longPrompt = `${prompt}\n\n${TASK_PANEL_RESUME_TRIGGER}`
  const translucencyBefore = await page.evaluate(() => window.localStorage.getItem('hermes.desktop.translucency.v2'))

  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setBounds({ height: 800, width: 1220, x: 0, y: 0 }, false)
  )
  reviewApi!.setWorkflowEnabled(true)
  await openWorkflowCatalog(page)
  await page.getByRole('button', { name: /竞品监控/ }).click()
  const details = page.getByRole('dialog', { name: '竞品监控' })

  await expect(details).toBeVisible()
  await details.getByRole('button', { name: '取消' }).click()
  await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '开始' }).first().click()
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setBounds({ height: 800, width: 752, x: 0, y: 0 }, false)
  )
  const goal = page.getByRole('textbox', { name: '业务目标' })

  await expect(goal).toBeVisible()
  await expect(page.getByRole('dialog', { name: '竞品监控' })).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: '本地测试数据' })).toHaveCount(0)
  await goal.fill(longPrompt)
  await page.getByRole('button', { name: '开始执行' }).click()

  await expect(page.getByText(longPrompt, { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/Task-panel clearance line 24/)).toBeVisible({ timeout: 60_000 })

  const composer = page.locator('[data-slot="composer-root"]:visible').first()
  const viewport = page.locator('[data-slot="aui_thread-viewport"]:visible').first()

  await expect(composer).toBeVisible()
  await expect(page.locator('[data-slot="aui_composer-clearance"]:visible')).toHaveCount(1)
  await viewport.evaluate(element => {
    element.scrollTop = element.scrollHeight
  })
  await page.waitForTimeout(200)

  const clearance = await page.evaluate(() => {
    const composerRoot = document.querySelector<HTMLElement>('[data-slot="composer-root"]:not([data-popped-out])')
    const transcript = document.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]')
    const latest = Array.from(document.querySelectorAll<HTMLElement>('[data-role="assistant"]')).at(-1)

    if (!composerRoot || !transcript || !latest) {
      return null
    }

    return {
      composerTop: composerRoot.getBoundingClientRect().top,
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      latestMessageBottom: latest.getBoundingClientRect().bottom,
      remainingScroll: transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop
    }
  })

  expect(clearance).not.toBeNull()
  expect(clearance!.remainingScroll).toBeLessThanOrEqual(1)
  expect(clearance!.latestMessageBottom).toBeLessThanOrEqual(clearance!.composerTop)
  expect(clearance!.documentScrollWidth).toBeLessThanOrEqual(clearance!.documentClientWidth)
  await expectApexShellPaint(page, 'session', 'ordinary-session')
  expect(await page.evaluate(() => window.localStorage.getItem('hermes.desktop.translucency.v2'))).toBe(
    translucencyBefore
  )

  const screenshotRoot = process.env.PHASE1_SCREENSHOT_DIR

  if (screenshotRoot) {
    fs.mkdirSync(screenshotRoot, { recursive: true })
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setBounds({ height: 900, width: 1440, x: 0, y: 0 }, false)
    )
    await expect(page.getByText(/手机正遥控本机/u)).toHaveCount(0)
    await page.screenshot({
      animations: 'disabled',
      caret: 'hide',
      path: path.join(screenshotRoot, 'session-1440x900.png')
    })
  }

  const composerStopButton = page.locator('form').getByRole('button', { name: '停止', exact: true })

  if (await composerStopButton.isVisible()) {
    await composerStopButton.click()
    await expect(composerStopButton).toHaveCount(0, { timeout: 15_000 })
  }
})

async function verifySelectedDeepReport(app: ElectronApplication, page: Page) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hc884-report-e2e-'))
  const file = path.join(directory, 'ANALYSIS.md')
  const body = '# [本地测试] 保存的报告\n<script>window.reportExecuted = true</script>'
  fs.writeFileSync(file, body)
  await app.evaluate(({ dialog }, selectedPath) => {
    const host = globalThis as typeof globalThis & { restoreReportDialog?: () => void }
    const original = dialog.showOpenDialog

    host.restoreReportDialog = () => { dialog.showOpenDialog = original }
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] })
  }, file)

  try {
    const tools = page.locator('details.analysis-conversation-advanced')

    if (await tools.getAttribute('open') === null) {await tools.locator(':scope > summary').click()}
    const reports = page.getByRole('region', { name: '深度分析报告' })
    await reports.getByRole('button', { name: '保存报告文件' }).click()
    await expect(reports.locator('summary')).toContainText('ANALYSIS.md')
    await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '开始' }).first().click()
    await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '沉浸式分析' }).first().click()
    await page.getByRole('button', { name: /local-review-video-transcript.srt/ }).click()

    if (await tools.getAttribute('open') === null) {await tools.locator(':scope > summary').click()}
    await reports.locator('summary').click()
    await expect(reports.locator('pre')).toHaveText(body)
    await expect(reports.locator('script')).toHaveCount(0)
    await expect(reports).toContainText('应用不核验文件作者或 Hypit 执行，验收只代表你的判断。')
    await expect(reports).toContainText('未记录对应发送（手动导入或旧版报告）。')
    await expect(reports).toContainText('待你验收')
    await reports.getByRole('button', { name: '删除副本 · ANALYSIS.md' }).click()
    await expect(reports).toContainText('尚未保存报告。')

    const retained = await page.evaluate(async () => {
      const api = (window as Window & { hermesDesktop?: { analysisDocuments: AnalysisDocumentsBridge } }).hermesDesktop!.analysisDocuments
      const source = (await api.list()).items!.find(item => item.filename === 'local-review-video-transcript.srt')!

      return (await api.get(source.id)).item!.deep_reports
    })

    expect(retained).toEqual([])
    expect(fs.readFileSync(file, 'utf8')).toBe(body)
    await test.info().attach('hc884-report-roundtrip', { body: JSON.stringify({ retainedReports: retained, originalPreserved: true, provenance: 'selected_file' }), contentType: 'application/json' })
  } finally {
    await app.evaluate(() => { (globalThis as typeof globalThis & { restoreReportDialog?: () => void }).restoreReportDialog?.() })
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test('hc-872 packaged analysis stores timed speech locally and prepares a reviewable deep draft', async () => {
  // This flow deliberately rejects a pending-seek screenshot and an empty
  // accepted output folder; assert both exact errors without hiding others.
  allowErrorBanners()
  const { app, page } = fixture!

  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setBounds({ height: 800, width: 1220, x: 0, y: 0 }, false)
  )
  await expect(page.locator('[data-sidebar="menu-button"]')).toHaveCount(BUSINESS_NAV_LABELS.length)

  await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '沉浸式分析' }).first().click()
  await expect(page.getByRole('heading', { name: '沉浸式分析', level: 1 })).toBeVisible()
  await expect(page.getByText('本地保存', { exact: true }).first()).toBeVisible()
  await page.getByRole('textbox', { name: '粘贴资料链接' }).fill(ANALYSIS_REVIEW_VIDEO_URL)
  await page.getByRole('button', { name: '打开链接' }).click()

  const overview = page.locator('details.analysis-conversation-advanced')
  await expect(page.getByRole('log')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(ANALYSIS_REVIEW_VIDEO_URL, { exact: true })).toBeVisible()
  await expect(page.getByRole('textbox')).toHaveCount(1)
  await expect(page.locator('#analysis-anchor-a2')).toContainText('[本地测试] 中段原文')
  await expect(page.getByRole('region', { name: '语音内容摘要' })).toHaveCount(0)

  const localItems = await page.evaluate(() => (window as AnalysisReviewWindow).hermesDesktop?.analysisDocuments?.list())

  expect(localItems?.ok).toBe(true)
  expect(localItems?.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ filename: 'local-review-video-transcript.srt', storageMode: 'local' })
  ]))

  const retained = await page.evaluate(async () => {
    const api = (window as Window & { hermesDesktop?: { analysisDocuments: AnalysisDocumentsBridge } }).hermesDesktop!.analysisDocuments
    const listed = await api.list()
    const id = listed.items!.find(item => item.filename === 'local-review-video-transcript.srt')!.id
    const opened = await api.get(id)
    const source = opened.item!

    const summary = { schema: 1 as const, revision: source.analysis_revision!, locale: 'zh' as const,
      points: [{ text: '[本地测试] 视频包含开场与中段讲述。', anchor_ids: ['a1', 'a2'] }] }

    const saved = await api.saveOverview(id, source.analysis_scope!, summary)

    if (!saved.ok) {throw new Error(saved.code)}
    const rejected = await api.saveOverview(id, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', summary)

    const staleTranscript = await api.transcriptForDraft(id, source.analysis_scope!, 'stale')
    const wrongOwnerTranscript = await api.transcriptForDraft(id, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', source.analysis_revision!)

    return { summary, rejected, staleTranscript, wrongOwnerTranscript,
      anchors: source.anchors!.map(anchor => ({ id: anchor.id, ...anchor.location, text: anchor.text })) }
  })

  expect(retained.summary.points[0].anchor_ids).toEqual(['a1', 'a2'])
  expect(retained.rejected).toMatchObject({ ok: false, code: 'analysis_account_changed' })
  expect(retained.staleTranscript).toMatchObject({ ok: false, code: 'transcript_source_changed' })
  expect(retained.wrongOwnerTranscript).toMatchObject({ ok: false, code: 'analysis_account_changed' })

  await verifySourceAnswer(page, localItems!.items!.find(item => item.filename === 'local-review-video-transcript.srt')!.id, 'a2')
  await verifySelectedDeepReport(app, page)

  await page.getByLabel('选择本地视频播放').setInputFiles(path.resolve(import.meta.dirname, 'media/local-frame-evidence.webm'))
  const player = page.getByLabel('本地视频: local-frame-evidence.webm')

  await expect.poll(() => player.evaluate(video => (video as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2)

  // A seek updates currentTime before the new frame has decoded. Capture in
  // that same browser task so an old image cannot inherit the requested time.
  const seekingDuringCapture = await page.getByRole('button', { name: '截取当前画面' }).evaluate(button => {
    if (!(button instanceof HTMLButtonElement)) {throw new Error('Frame capture control must be a button')}
    const video = document.querySelector('video')!
    video.currentTime = 2.5
    const seeking = video.seeking
    button.click()

    return seeking
  })

  expect(seekingDuringCapture).toBe(true)
  await expect(page.getByRole('alert')).toContainText('当前画面无法截取')
  await expect(page.getByRole('region', { name: '本次查看的画面截图' })).toHaveCount(0)
  await player.evaluate(video => new Promise<void>(resolve => {
    video.addEventListener('seeked', () => resolve(), { once: true }); (video as HTMLVideoElement).currentTime = 1
  }))
  await page.getByRole('button', { name: '截取当前画面' }).click()
  const frame = page.getByRole('img', { name: /本次查看的画面截图 · 0:01/ })
  const frameDataUrl = await frame.getAttribute('src')

  expect(frameDataUrl?.startsWith('data:image/jpeg;base64,')).toBe(true)
  expect(frameDataUrl!.length).toBeGreaterThan(1000)
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByText(/尚未经过模型分析/)).toBeVisible()

  const pasteDirectory = path.join(await app.evaluate(({ app }) => app.getPath('userData')), 'composer-pastes')
  const previousPastes = new Set(fs.existsSync(pasteDirectory) ? fs.readdirSync(pasteDirectory) : [])

  if (await overview.getAttribute('open') === null) {await overview.locator(':scope > summary').click()}
  await expect(overview).toContainText('仅在你点击发送后交给助手')
  await overview.getByRole('button', { name: '准备深度拆解' }).click()
  const goalWithFrame = page.getByRole('textbox', { name: '业务目标' })

  await expect(goalWithFrame).toHaveValue(/已附完整的已保存语音转写/)
  await expect(page.getByRole('button', { name: /移除.*完整语音转写/ })).toHaveCount(1)
  const newPastes = fs.readdirSync(pasteDirectory).filter(file => !previousPastes.has(file))
  expect(newPastes).toHaveLength(1)
  const fullTranscript = JSON.parse(fs.readFileSync(path.join(pasteDirectory, newPastes[0]), 'utf8'))
  expect(fullTranscript.anchors).toEqual(retained.anchors)
  expect(fullTranscript.evidence_kind).toBe('stored_audio_transcript')
  await expect(goalWithFrame).toHaveValue(/已附画面截图/)
  await expect(goalWithFrame).toHaveValue(/0:01\.0/)
  await expect(page.locator('[data-slot="composer-attachments"]')).toContainText(/apex-frame-1-0s_[a-f0-9]{6}\.jpg/)
  await expect(page.getByRole('button', { name: /移除.*apex-frame-.*\.jpg/ })).toHaveCount(2)
  await expect(page.locator('[data-role="assistant"]')).toHaveCount(0)

  for (let index = 0; index < 2; index++) {
    await page.getByRole('button', { name: /移除.*apex-frame-.*\.jpg/ }).first().click()
  }

  await expect(goalWithFrame).not.toHaveValue(/已附画面截图/)
  await expect(goalWithFrame).not.toHaveValue(/0:01\.0/)
  await expect(goalWithFrame).toHaveValue(/已从草稿移除 2 张截图/)
  await expect(goalWithFrame).toHaveValue(/已附完整的已保存语音转写/)
  await page.getByRole('button', { name: /移除.*完整语音转写/ }).click()
  await expect(goalWithFrame).not.toHaveValue(/已附完整的已保存语音转写/)
  await expect(goalWithFrame).toHaveValue(/未附完整转写/)
  await expect(page.locator('[data-slot="composer-attachments"]')).toHaveCount(0)

  await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '沉浸式分析' }).first().click()
  await page.getByRole('button', { name: /local-review-video-transcript.srt/ }).click()
  await expect(overview).toBeVisible()
  await expect(page.getByRole('log')).toContainText('[本地测试] 视频包含开场与中段讲述。')

  if (await overview.getAttribute('open') === null) {await overview.locator(':scope > summary').click()}
  expect(fixture!.mock.receivedPrompts.filter(text => text.includes('"transcript"') && text.includes('[本地测试] 中段原文'))).toHaveLength(0)
  await expect(page.getByRole('region', { name: '本次查看的画面截图' })).toHaveCount(0)
  await overview.getByRole('button', { name: '准备深度拆解' }).click()

  const goal = page.getByRole('textbox', { name: '业务目标' })

  await expect(goal).toBeVisible()
  await expect(goal).toHaveValue(/先读取当前可用的 short-video-studio 与 Hypit Skill/)
  await expect(goal).toHaveValue(/\[0:40–0:43\] "\[本地测试\] 中段原文"/)
  await expect(goal).toHaveValue(/https:\/\/www\.iesdouyin\.com\/share\/video\/123456/)
  await expect(goal).toHaveValue(/只有实际检查本条消息仍附着的原视频或截图后才分析镜头/)
  await expect(goal).not.toHaveValue(/已附画面截图/)
  await expect(goal).toHaveValue(/已附完整的已保存语音转写/)
  await expect(page.getByRole('button', { name: /移除.*完整语音转写/ })).toHaveCount(1)
  await page.getByRole('button', { name: /移除.*完整语音转写/ }).click()
  await expect(goal).toHaveValue(/未附完整转写/)
  await expect(page.locator('[data-slot="composer-attachments"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '开始执行' })).toBeVisible()
  await expect(page.locator('[data-role="assistant"]')).toHaveCount(0)
  await verifyWorkspaceReport(app, page)
  expect(await collectErrorBanners(page)).toEqual(['视频暂时无法加载，可重试或在原站打开。', '当前画面无法截取，请先播放或跳到可播放的时间。', '指定报告尚未生成。请在助手完成后重试。'])
})

test('hc-901 packaged video upload opens a playable native lease and one continuous conversation', async () => {
  const { app, page } = fixture!
  const originalPath = path.resolve(import.meta.dirname, 'media/local-frame-evidence.webm')
  await app.evaluate(({ dialog }, selectedPath) => {
    const host = globalThis as typeof globalThis & { restoreAnalysisDialog?: () => void }
    const original = dialog.showOpenDialog

    host.restoreAnalysisDialog = () => {dialog.showOpenDialog = original}
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] })
  }, originalPath)

  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ width: 1440, height: 900 }, false))
    await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '沉浸式分析' }).first().click()
    const back = page.getByRole('button', { name: '返回资料入口' })

    if (await back.isVisible()) {await back.click()}
    await page.getByRole('button', { name: '选择本地视频转写' }).click()
    const player = page.getByLabel('本地视频: local-frame-evidence.webm')
    await expect(player).toHaveAttribute('src', /^hermes-media:\/\/analysis\/[a-f0-9-]+\.webm$/)
    const mediaUrl = (await player.getAttribute('src'))!
    await expect.poll(() => player.evaluate(video => (video as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2)
    await player.evaluate(video => (video as HTMLVideoElement).play())
    await expect.poll(() => player.evaluate(video => (video as HTMLVideoElement).currentTime)).toBeGreaterThan(0)
    await player.evaluate(video => (video as HTMLVideoElement).pause())
    await expect(page.getByRole('textbox')).toHaveCount(1)
    await expect(page.getByRole('tab', { name: '快速分析' })).toHaveCount(0)
    const items = await page.evaluate(() => (window as AnalysisReviewWindow).hermesDesktop!.analysisDocuments!.list())
    const sourceId = items.items!.find(item => item.filename === 'native-review-video.srt')!.id
    const composer = page.locator('.analysis-conversation-composer')
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => {
        const key = 'hermes-desktop-profile-modes-v1'
        const profile = localStorage.getItem('hermes-desktop-active-profile-v1') ?? 'default'
        localStorage.setItem(key, JSON.stringify({ [profile]: theme }))
        window.dispatchEvent(new StorageEvent('storage', { key }))
      }, theme)
      await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(theme === 'dark')
      const border = await composer.evaluate(element => {
        const style = getComputedStyle(element)

        return { width: style.borderTopWidth, style: style.borderTopStyle, color: style.borderTopColor,
          token: style.getPropertyValue('--ui-stroke-secondary').trim() }
      })
      expect(border.width).toBe('1px')
      expect(border.style).toBe('solid')
      expect(border.token).not.toBe('')
      expect(border.color).not.toBe('rgba(0, 0, 0, 0)')
    }
    await page.evaluate(() => {
      const key = 'hermes-desktop-profile-modes-v1'
      const profile = localStorage.getItem('hermes-desktop-active-profile-v1') ?? 'default'
      localStorage.setItem(key, JSON.stringify({ [profile]: 'light' }))
      window.dispatchEvent(new StorageEvent('storage', { key }))
    })
    const picker = page.getByRole('combobox', { name: '选择问答模型' })
    await picker.click()
    await page.getByRole('option', { name: 'Mock Answer Model', exact: true }).click()
    await expect(picker).toContainText('Mock Answer Model')
    await verifySourceAnswer(page, sourceId, 'a2', false)
    const completion = fixture!.mock.receivedCompletions.find(item => item.prompt.includes(`HC886_SOURCE_QUESTION ${sourceId}`))
    expect(completion?.model).toBe('mock-answer-model')
    // Answering and citing preserve playback; closing the source releases the view lease.
    await expect(page.locator('video')).toHaveAttribute('src', mediaUrl)
    await page.getByRole('button', { name: '返回资料入口' }).click()
    expect(await app.evaluate(async ({ net }, url) => (await net.fetch(url)).status, mediaUrl)).toBe(404)
    await page.getByRole('button', { name: /native-review-video.srt/ }).click()
    await expect(page.locator('video')).toHaveCount(0)
    await page.getByLabel('选择本地视频播放').setInputFiles(originalPath)
    await page.getByRole('combobox', { name: '选择问答模型' }).click()
    await page.getByRole('option', { name: '默认（助手配置）', exact: true }).click()
    await page.getByRole('textbox', { name: '针对当前资料提问' }).fill(`HC886_SOURCE_QUESTION Follow up ${sourceId}`)
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect(page.getByRole('log').getByText('[本地测试] 当前资料的回答已附出处。', { exact: true })).toHaveCount(2, { timeout: 90_000 })
    expect(fixture!.mock.receivedCompletions.find(item => item.prompt.includes(`HC886_SOURCE_QUESTION Follow up ${sourceId}`))?.model).toBe('mock-model')
    await expect(page.getByRole('textbox')).toHaveValue('')
    await page.getByRole('log').getByRole('button', { name: '查看出处 · 0:02 起', exact: true }).last().click()
    await expect.poll(() => page.locator('video').evaluate(video => (video as HTMLVideoElement).currentTime)).toBeCloseTo(2, 1)

    for (const width of [1440, 900]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]?.setBounds({ width, height: 900 }, false), width)
      await page.getByRole('textbox').scrollIntoViewIfNeeded()
      await expect(page.getByRole('textbox')).toBeInViewport()
      expect(await page.locator('.analysis-workspace-frame').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      const screenshot = test.info().outputPath(`hc901-video-conversation-${width}.png`)
      await page.screenshot({ path: screenshot })
      await test.info().attach(`hc901-video-conversation-${width}`, { path: screenshot, contentType: 'image/png' })
    }

    const pairedUrl = (await page.locator('video').getAttribute('src'))!
    await openAccountDestination(page, '项目')
    await expect(page.getByRole('heading', { name: '项目', exact: true, level: 1 })).toBeVisible()
    expect(pairedUrl).toMatch(/^blob:/)
    expect(await page.evaluate(url => fetch(url).then(() => false, () => true), pairedUrl)).toBe(true)
    await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '沉浸式分析' }).first().click()
    await page.getByRole('button', { name: /native-review-video.srt/ }).click()
    await expect(page.getByRole('log').getByText('[本地测试] 当前资料的回答已附出处。', { exact: true })).toHaveCount(2)
    expect(fs.existsSync(originalPath)).toBe(true)
  } finally {
    await app.evaluate(() => { (globalThis as typeof globalThis & { restoreAnalysisDialog?: () => void }).restoreAnalysisDialog?.() })
  }
})

test('hc-901 packaged native policy HTTP 503 recovers with explicit retry and preserves the cloud storage gate', async () => {
  allowErrorBanners()
  const { app, page } = fixture!
  const host = await app.browserWindow(page)
  await host.evaluate(win => {win.unmaximize(); win.setBounds({ height: 800, width: 1220, x: 0, y: 0 }, false); win.show(); win.focus()})
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1220)
  const showSidebar = page.getByRole('button', { name: /^显示侧边栏/ })

  if (await showSidebar.isVisible()) {await showSidebar.click()}
  await openAccountDestination(page, '项目')
    await expect(page.getByRole('heading', { name: '项目', level: 1 })).toBeVisible()
    await expect(page.getByRole('heading', { name: '沉浸式分析', level: 1 })).toHaveCount(0)
  reviewApi!.setAnalysisPolicy('local')
  const policyReadsBefore = reviewApi!.policyReadStatuses().length
  reviewApi!.setAnalysisPolicyUnavailable(true)

  try {
    await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '沉浸式分析' }).first().click()
    await expect(page.getByRole('alert').filter({ hasText: '无法读取资料保存设置，请检查连接后重试。' })).toBeVisible()
    await expect(page.getByRole('button', { name: '导入文档或字幕' })).toBeDisabled()
    await expect(page.getByRole('button', { name: '选择本地视频转写' })).toBeDisabled()
    const failures = reviewApi!.policyReadStatuses().slice(policyReadsBefore)
    expect(failures.length).toBeGreaterThan(0)
    expect(failures.every(status => status === 503)).toBe(true)
    reviewApi!.setAnalysisPolicyUnavailable(false)
    await page.getByRole('button', { name: '重试保存设置' }).click()
    await expect(page.getByRole('button', { name: '导入文档或字幕' })).toBeEnabled()
    await expect(page.getByRole('button', { name: '选择本地视频转写' })).toBeEnabled()
    await expect(page.getByRole('button', { name: '重试保存设置' })).toHaveCount(0)
    await expect(page.getByText('本地保存', { exact: true }).first()).toBeVisible()
    expect(reviewApi!.policyReadStatuses().at(-1)).toBe(200)

    reviewApi!.setAnalysisPolicy('cloud', false)
    await openAccountDestination(page, '项目')
    await expect(page.getByRole('heading', { name: '项目', level: 1 })).toBeVisible()
    await expect(page.getByRole('heading', { name: '沉浸式分析', level: 1 })).toHaveCount(0)
    await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '沉浸式分析' }).first().click()
    await expect(page.getByText('云端资料存储尚未配置，请联系平台管理员。')).toBeVisible()
    await expect(page.getByRole('button', { name: '导入文档或字幕' })).toBeDisabled()
    await expect(page.getByRole('button', { name: '重试保存设置' })).toHaveCount(0)
    expect(await collectErrorBanners(page)).toEqual(['无法读取资料保存设置，请检查连接后重试。'])
  } finally {
    reviewApi!.setAnalysisPolicyUnavailable(false)
    reviewApi!.setAnalysisPolicy('local')
    await openAccountDestination(page, '项目')
    await expect(page.getByRole('heading', { name: '项目', level: 1 })).toBeVisible()
    await expect(page.getByRole('heading', { name: '沉浸式分析', level: 1 })).toHaveCount(0)
  }
})

test('hc-901 packaged Analysis rereads cloud evidence and notes while preserving drafts through native HTTP failure and retry', async () => {
  allowErrorBanners()
  const { app, page } = fixture!
  const host = await app.browserWindow(page)
  await host.evaluate(win => {win.unmaximize(); win.setBounds({ height: 800, width: 1220, x: 0, y: 0 }, false); win.show(); win.focus()})
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1220)
  const showSidebar = page.getByRole('button', { name: /^显示侧边栏/ })

  if (await showSidebar.isVisible()) {await showSidebar.click()}
  await openAccountDestination(page, '项目')
    await expect(page.getByRole('heading', { name: '项目', level: 1 })).toBeVisible()
    await expect(page.getByRole('heading', { name: '沉浸式分析', level: 1 })).toHaveCount(0)
  reviewApi!.setAnalysisPolicy('cloud')
  reviewApi!.setCloudSourceSnapshot('Original cloud source')

  try {
    await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '沉浸式分析' }).first().click()
    await page.getByRole('button', { name: /Original cloud source.txt/ }).click()
    await page.getByRole('tab', { name: '研究笔记' }).click()
    await expect(page.getByText('Original cloud source note from another device')).toBeVisible()
    await page.getByRole('textbox', { name: '针对当前资料提问' }).fill('Unsaved question')
    await page.getByRole('textbox', { name: '记录你的发现' }).fill('Unsaved note')
    reviewApi!.setCloudSourceSnapshot('Other device')
    await expect(page.getByRole('heading', { name: 'Other device.txt' })).toBeVisible({ timeout: 25_000 })
    await expect(page.locator('#analysis-anchor-a1')).toContainText('Other device original evidence')
    await expect(page.getByText('Other device note from another device')).toBeVisible()
    await expect(page.getByRole('textbox', { name: '针对当前资料提问' })).toHaveValue('Unsaved question')
    await expect(page.getByRole('textbox', { name: '记录你的发现' })).toHaveValue('Unsaved note')

    reviewApi!.failNextCloudDetail()
    await expect(page.getByText('暂时无法刷新最新状态，请检查连接后重试。')).toBeVisible({ timeout: 25_000 })
    await expect(page.getByText('Other device note from another device')).toBeVisible()
    reviewApi!.setCloudSourceSnapshot('Reconnected')
    await page.getByRole('button', { name: '重试刷新' }).click()
    await expect(page.getByRole('heading', { name: 'Reconnected.txt' })).toBeVisible()
    await expect(page.getByText('Reconnected note from another device')).toBeVisible()
    await expect(page.getByRole('button', { name: '重试刷新' })).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: '记录你的发现' })).toHaveValue('Unsaved note')
    reviewApi!.setCloudSourceSnapshot(null)
    await expect(page.getByRole('heading', { name: 'Reconnected.txt' })).toHaveCount(0, { timeout: 25_000 })
    expect(await collectErrorBanners(page)).toEqual(['暂时无法刷新最新状态，请检查连接后重试。重试刷新'])
  } finally {
    reviewApi!.setCloudSourceSnapshot(null)
    reviewApi!.setAnalysisPolicy('local')
    await openAccountDestination(page, '项目')
    await expect(page.getByRole('heading', { name: '项目', level: 1 })).toBeVisible()
    await expect(page.getByRole('heading', { name: '沉浸式分析', level: 1 })).toHaveCount(0)
  }
})

test('hc-878 packaged local document import persists cited answers and notes under the signed-in account', async () => {
  const { app, page } = fixture!
  const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-analysis-e2e-'))
  const sourcePath = path.join(sourceDirectory, 'local-review-document.txt')

  fs.writeFileSync(sourcePath, '# Quarterly report\n\nRevenue 423 units')
  await app.evaluate(({ dialog }, selectedPath) => {
    const host = globalThis as typeof globalThis & { restoreAnalysisDialog?: () => void }
    const original = dialog.showOpenDialog

    host.restoreAnalysisDialog = () => { dialog.showOpenDialog = original }
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] })
  }, sourcePath)

  try {
    await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '沉浸式分析' }).first().click()
    await page.getByRole('button', { name: '导入文档或字幕' }).click()
    await expect(page.getByRole('heading', { name: 'local-review-document.txt' })).toBeVisible()
    await expect.poll(async () => {
      const result = await page.evaluate(() => (window as AnalysisReviewWindow).hermesDesktop?.analysisDocuments?.list())
      const current = result?.items?.find(source => source.filename === 'local-review-document.txt')

      return current?.status === 'failed' ? `failed:${current.error_code}` : current?.status
    }).toBe('ready')
    await expect(page.locator('#analysis-anchor-a2')).toContainText('Revenue 423 units')

    const imported = await page.evaluate(() => (window as AnalysisReviewWindow).hermesDesktop?.analysisDocuments?.list())
    const item = imported?.items?.find(source => source.filename === 'local-review-document.txt')

    expect(item?.storageMode).toBe('local')
    expect(item?.status).toBe('ready')
    expect(item?.id).toMatch(/^local-/)
    fs.rmSync(sourcePath)

    await page.getByRole('textbox', { name: '针对当前资料提问' }).fill('Revenue?')
    await page.getByRole('button', { name: '查找证据' }).click()
    await expect(page.getByRole('button', { name: '查看出处 · 第 2 段' })).toBeVisible()
    await page.locator('#analysis-anchor-a2').evaluate(element => {
      element.scrollIntoView = () => { element.setAttribute('data-jumped', 'true') }
    })
    await page.getByRole('button', { name: '查看出处 · 第 2 段' }).click()
    await expect(page.locator('#analysis-anchor-a2')).toHaveAttribute('data-jumped', 'true')
    await page.locator('#analysis-anchor-a2').evaluate(element => { element.scrollIntoView = Element.prototype.scrollIntoView })

    await page.locator('#analysis-anchor-a2').getByRole('button', { name: '记到此处' }).click()
    await page.getByRole('textbox', { name: '记录你的发现' }).fill('Check the revenue source')
    await page.getByRole('button', { name: '保存笔记' }).click()
    await expect(page.getByText('Check the revenue source')).toBeVisible()

    await openAccountDestination(page, '项目')
    await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '沉浸式分析' }).first().click()
    await page.getByRole('button', { name: /local-review-document.txt/ }).click()
    await page.getByRole('tab', { name: '研究笔记' }).click()
    await expect(page.getByText('Check the revenue source')).toBeVisible()
    await expect(page.getByRole('button', { name: '查看出处 · 第 2 段' })).toBeVisible()

    await verifySourceAnswer(page, item!.id, 'a2')
    await page.getByRole('button', { name: '删除资料' }).click()
    await expect(page.getByRole('button', { name: /local-review-document.txt/ })).toHaveCount(0)
    const afterDelete = await page.evaluate(id => (window as AnalysisReviewWindow).hermesDesktop?.analysisDocuments?.get(id), item!.id)

    expect(afterDelete).toEqual({ ok: false, code: 'source_not_found' })
  } finally {
    await app.evaluate(() => {
      const host = globalThis as typeof globalThis & { restoreAnalysisDialog?: () => void }

      host.restoreAnalysisDialog?.()
      delete host.restoreAnalysisDialog
    })
    fs.rmSync(sourceDirectory, { recursive: true, force: true })
  }
})

test('hc-879 packaged cloud document import reopens server-owned evidence and fails closed without cloud storage', async () => {
  const { app, page } = fixture!
  const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-analysis-cloud-e2e-'))
  const sourcePath = path.join(sourceDirectory, 'cloud-review-document.txt')

  fs.writeFileSync(sourcePath, 'Cloud revenue 817 units')
  reviewApi!.setAnalysisPolicy('cloud')
  await app.evaluate(({ dialog }, selectedPath) => {
    const host = globalThis as typeof globalThis & { restoreCloudAnalysisDialog?: () => void }
    const original = dialog.showOpenDialog

    host.restoreCloudAnalysisDialog = () => { dialog.showOpenDialog = original }
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] })
  }, sourcePath)

  try {
    await openAccountDestination(page, '项目')
    await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '沉浸式分析' }).first().click()
    await expect(page.getByText('云端保存', { exact: true }).first()).toBeVisible()
    await page.getByRole('button', { name: '导入文档或字幕' }).click()
    await expect(page.getByRole('heading', { name: 'cloud-review-document.txt' })).toBeVisible()
    await expect(page.getByRole('textbox', { name: '针对当前资料提问' })).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: '针对当前资料提问' })).toBeVisible()
    await expect(page.locator('#analysis-anchor-a1')).toContainText('Cloud revenue 817 units')

    const listed = await page.evaluate(() => (window as AnalysisReviewWindow).hermesDesktop?.analysisDocuments?.list())
    const cloudItem = listed?.items?.find(item => item.filename === 'cloud-review-document.txt')

    expect(cloudItem?.id).toBe(ANALYSIS_REVIEW_CLOUD_ID)
    expect(cloudItem?.storageMode).toBe('cloud')
    expect(cloudItem?.status).toBe('ready')

    await page.getByRole('textbox', { name: '针对当前资料提问' }).fill('Cloud revenue?')
    await page.getByRole('button', { name: '查找证据' }).click()
    await expect(page.getByRole('button', { name: '查看出处 · 第 1 段' })).toBeVisible()
    await page.locator('#analysis-anchor-a1').getByRole('button', { name: '记到此处' }).click()
    await page.getByRole('textbox', { name: '记录你的发现' }).fill('Review cloud source')
    await page.getByRole('button', { name: '保存笔记' }).click()
    await expect(page.getByText('Review cloud source')).toBeVisible()

    await openAccountDestination(page, '项目')
    await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '沉浸式分析' }).first().click()
    await page.getByRole('button', { name: /cloud-review-document.txt/ }).click()
    await page.getByRole('tab', { name: '研究笔记' }).click()
    await expect(page.getByText('Review cloud source')).toBeVisible()
    await expect(page.getByRole('button', { name: '查看出处 · 第 1 段' })).toBeVisible()
    await page.getByRole('button', { name: '删除笔记' }).click()
    await expect(page.getByText('Review cloud source')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '查看出处 · 第 1 段' })).toBeVisible()

    await verifySourceAnswer(page, ANALYSIS_REVIEW_CLOUD_ID, 'a1')
    await page.getByRole('button', { name: '删除资料' }).click()
    await expect(page.getByRole('button', { name: /cloud-review-document.txt/ })).toHaveCount(0)
    const afterDelete = await page.evaluate(id => (window as AnalysisReviewWindow).hermesDesktop?.analysisDocuments?.get(id), ANALYSIS_REVIEW_CLOUD_ID)

    expect(afterDelete).toEqual({ ok: false, code: 'source_not_found' })

    reviewApi!.setAnalysisPolicy('cloud', false)
    await openAccountDestination(page, '项目')
    await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '沉浸式分析' }).first().click()
    await expect(page.getByRole('button', { name: '导入文档或字幕' })).toBeDisabled()
    const refused = await page.evaluate(() => (window as AnalysisReviewWindow).hermesDesktop?.analysisDocuments?.importFile())

    expect(refused).toEqual({ ok: false, code: 'analysis_cloud_write_disabled' })
    const afterRefusal = await page.evaluate(() => (window as AnalysisReviewWindow).hermesDesktop?.analysisDocuments?.list())

    expect(afterRefusal?.items?.filter(item => item.filename === 'cloud-review-document.txt')).toEqual([])
  } finally {
    reviewApi!.setAnalysisPolicy('local')
    await app.evaluate(() => {
      const host = globalThis as typeof globalThis & { restoreCloudAnalysisDialog?: () => void }

      host.restoreCloudAnalysisDialog?.()
      delete host.restoreCloudAnalysisDialog
    })
    fs.rmSync(sourceDirectory, { recursive: true, force: true })
  }
})

test('hc-880 packaged PDF Word and Excel imports keep real file bytes and cited locations', async () => {
  const { app, page } = fixture!

  try {
    await openAccountDestination(page, '项目')
    await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '沉浸式分析' }).first().click()

    for (const sample of ANALYSIS_FORMAT_SAMPLES) {
      const selectedPath = path.resolve(import.meta.dirname, 'media', sample.filename)

      await app.evaluate(({ dialog }, filePath) => {
        const host = globalThis as typeof globalThis & { restoreFormatAnalysisDialog?: () => void }

        if (!host.restoreFormatAnalysisDialog) {
          const original = dialog.showOpenDialog

          host.restoreFormatAnalysisDialog = () => { dialog.showOpenDialog = original }
        }

        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] })
      }, selectedPath)
      await page.getByRole('button', { name: '导入文档或字幕' }).click()
      await expect(page.getByRole('heading', { name: sample.filename })).toBeVisible()
      await expect(page.locator(`#analysis-anchor-${sample.anchorId}`)).toContainText(sample.evidence)

      const listed = await page.evaluate(() => (window as AnalysisReviewWindow).hermesDesktop?.analysisDocuments?.list())
      const item = listed?.items?.find(source => source.filename === sample.filename)

      expect(item?.storageMode).toBe('local')
      expect(item?.kind).toBe(sample.kind)
      expect(item?.status).toBe('ready')
      expect(item?.id).toMatch(/^local-/)

      await page.getByRole('textbox', { name: '针对当前资料提问' }).fill(sample.question)
      await page.getByRole('button', { name: '查找证据' }).click()
      const citation = page.getByRole('button', { name: `查看出处 · ${sample.citation}` })

      await expect(citation).toBeVisible()
      await page.locator(`#analysis-anchor-${sample.anchorId}`).evaluate(element => {
        element.scrollIntoView = () => { element.setAttribute('data-jumped', 'true') }
      })
      await citation.click()
      await expect(page.locator(`#analysis-anchor-${sample.anchorId}`)).toHaveAttribute('data-jumped', 'true')

      if (sample.kind === 'pdf') {
        await expect(page.getByRole('heading', { name: 'PDF 原件 · 第 2 页' })).toBeVisible()
        await expect(page.getByTitle('PDF 原件')).toHaveAttribute('src', /#page=2$/)
      }

      await openAccountDestination(page, '项目')
      await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '沉浸式分析' }).first().click()
      await page.getByRole('button', { name: new RegExp(sample.filename.replaceAll('.', '\\.')) }).click()
      await expect(page.getByRole('button', { name: `查看出处 · ${sample.citation}` })).toBeVisible()
      await expect(page.locator(`#analysis-anchor-${sample.anchorId}`)).toContainText(sample.evidence)
      await page.getByRole('button', { name: '删除资料' }).click()
      await expect(page.getByRole('button', { name: new RegExp(sample.filename.replaceAll('.', '\\.')) })).toHaveCount(0)
    }
  } finally {
    await app.evaluate(() => {
      const host = globalThis as typeof globalThis & { restoreFormatAnalysisDialog?: () => void }

      host.restoreFormatAnalysisDialog?.()
      delete host.restoreFormatAnalysisDialog
    })
  }
})

test('hc-889 packaged cron records actual script success and failure without chat sessions', async () => {
  if (!fixture) {throw new Error('Packaged fixture unavailable')}
  await verifyCronExecutionHistory(fixture)
})

test('hc-889 packaged timer fires a future occurrence and leaves a paused sibling untouched', async () => {
  if (!fixture) {throw new Error('Packaged fixture unavailable')}
  await verifyCronTimerExecution(fixture)
})

test('hc-889 packaged late session recovery preserves the chosen cron page', async () => {
  if (!fixture) {throw new Error('Packaged fixture unavailable')}
  await verifyLateSessionRecovery(fixture)
})


test('hc-890 packaged analysis links only an accepted chat and reopens its durable conversation', async () => {
  await verifyAnalysisChatLink(fixture!)
})

for (const outcome of ['error', 'interrupted'] as const) {
  test(`hc-891 packaged analysis retains the actual ${outcome} attempt outcome`, async () => {
    await verifyAnalysisChatLink(fixture!, outcome)
  })
}


test('hc-894 packaged account switch rejects old analysis responses and renewal headers', async () => {
  await verifyAccountIsolation(fixture!.app, fixture!.page, reviewApi!, ANALYSIS_REVIEW_USER_ID, ANALYSIS_REVIEW_CLOUD_ID)
})

test('hc-894 packaged document picker never retargets an in-flight import to the next account', async () => {
  await verifyPickerAccountIsolation(fixture!.app, fixture!.page, reviewApi!, ANALYSIS_REVIEW_USER_ID)
})


test('hc-895 packaged logout and handoff sign-in discard the previous account workspace', async () => {
  await verifyAccountWorkspaceReset(fixture!.app, fixture!.page, reviewApi!, ANALYSIS_REVIEW_USER_ID)
})
