import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

import type { Locator, Page } from '@playwright/test'

import { type PackagedMockBackendFixture, setupPackagedMockBackend, waitForAppReady } from './fixtures'
import { TASK_PANEL_RESUME_TRIGGER } from './mock-server'
import { expect, test } from './test'

const BUSINESS_NAV_LABELS = ['开始', '项目', '工作流', '定时运行', '交付物'] as const

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
  expect(paint.glassKeep).toBe('34%')
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
    id: 'local-review-project-running',
    name: '[本地测试] 美国宠物用品机会分析',
    objective: '验证项目列表的长标题、真实生命周期文案与点击入口。',
    status: 'active',
    summary: {
      attention: 'none',
      currentRunId: 'local-review-run-running',
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
    id: 'local-review-project-complete',
    name: '[本地测试] APEX GEO 品牌诊断',
    objective: '验证已完成状态、窄窗换行与返回路径。',
    status: 'completed',
    summary: {
      attention: 'none',
      currentRunId: 'local-review-run-complete',
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
    id: 'local-review-project-no-run',
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
      projectId: 'local-review-project-running',
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
      runId: 'local-review-run-running',
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
    id: 'local-review-run-running',
    maxAttempts: 2,
    startedAt: '2026-09-06T17:01:00Z',
    status: 'waiting_review',
    triggerRef: '[本地测试] 验证真实 Run 抽屉、事件顺序与诚实空态。',
    updatedAt: '2026-09-06T17:05:00Z',
    userId: 'tenant-user'
  },
  steps: [{ progress: 88, title: '伪造阶段，不得展示' }]
}

async function startPhase1ReviewApi() {
  let lastReview: null | Record<string, unknown> = null
  let relayBaseUrl = ''
  let runAvailable = true
  let workflowEnabled = true
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }

    if (request.method === 'POST' && url.pathname === '/api/v1/auth/login') {
      json(200, {
        access_token: 'local.phase1.review',
        email: 'phase1-review@local.test',
        name: '本地 UI 评审',
        plan: 'review'
      })

      return
    }

    if (request.method === 'POST' && url.pathname === '/api/v1/desktop/provision-key') {
      json(200, {
        api_key: 'sk-apex-local-phase1-review',
        base_url: relayBaseUrl,
        email: 'phase1-review@local.test',
        model: 'mock-model',
        name: '本地 UI 评审',
        plan: 'review'
      })

      return
    }

    if (request.method === 'GET' && url.pathname === '/api/v1/workflow-domain/access') {
      json(200, { enabled: workflowEnabled })

      return
    }

    if (request.method === 'GET' && url.pathname === '/api/v1/workflow-domain/projects') {
      json(200, { items: reviewProjects, nextCursor: null, total: reviewProjects.length })

      return
    }

    if (request.method === 'GET' && url.pathname.startsWith('/api/v1/workflow-domain/projects/')) {
      const projectId = decodeURIComponent(url.pathname.slice('/api/v1/workflow-domain/projects/'.length))
      const project = reviewProjects.find(item => item.id === projectId)

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
            id: 'local-review-workflow',
            name: '[本地测试] 我的选品流程',
            projectId: 'local-review-project-running',
            slug: 'market-launch',
            status: 'active',
            updatedAt: '2026-09-05T21:05:00Z',
            version: 1
          }
        ]
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
          id: 'local-review-workflow',
          name: '[本地测试] 我的选品流程',
          projectId: 'local-review-project-running',
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
            target: { id: 'local-review-run-running', kind: 'run' },
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

    if (request.method === 'GET' && url.pathname === '/api/v1/workflow-domain/runs/local-review-run-running') {
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
    setRelayBaseUrl: (value: string) => {
      relayBaseUrl = value
    },
    setRunAvailable: (value: boolean) => {
      runAvailable = value
    },
    setWorkflowEnabled: (value: boolean) => {
      workflowEnabled = value
    },
    url: `http://127.0.0.1:${address.port}`
  }
}

test.setTimeout(180_000)

test.beforeAll(
  async () => {
    reviewApi = await startPhase1ReviewApi()
    fixture = await setupPackagedMockBackend({
      APEXNODES_API_BASE: reviewApi.url,
      APEXNODES_AUTH_BASE: reviewApi.url
    })
    reviewApi.setRelayBaseUrl(fixture.mockUrl)
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
      window.hermesDesktop?.managed?.signIn({ email: 'phase1-review@local.test', password: 'local-review-only' })
    )

    expect(signIn?.ok).toBe(true)
    expect(signIn?.hasRelayKey).toBe(true)
    await fixture.page.reload()
    await waitForAppReady(fixture, 120_000)
  },
  { timeout: 180_000 }
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
  await expect(page.getByRole('menuitem', { name: '连接助手' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: '历史会话' })).toBeVisible()
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

  await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '项目' }).first().click()
  await expect(page.getByRole('heading', { name: '项目', level: 1 })).toBeVisible()
  await expectApexShellPaint(page, 'business-canvas', 'projects')
  await page.getByRole('button', { name: /\[本地测试\] 美国宠物用品机会分析/ }).click()
  await expect(page.locator('[data-project-detail]')).toBeVisible()
  await expectApexShellPaint(page, 'business-canvas', 'project-drawer')
  await page.keyboard.press('Escape')

  await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '工作流' }).first().click()
  await expect(page.getByRole('heading', { name: '工作流', level: 1 })).toBeVisible()
  await expectApexShellPaint(page, 'business-canvas', 'workflows')
})

test('primary navigation dismisses only the narrow sidebar overlay, including keyboard activation', async () => {
  const { app, page } = fixture!

  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]

    win?.unmaximize()
    win?.setMinimumSize(400, 620)
    win?.setBounds({ height: 800, width: 752, x: 0, y: 0 }, false)
  })
  await page.waitForTimeout(400)

  for (const [index, label] of BUSINESS_NAV_LABELS.entries()) {
    await page.getByRole('button', { name: /显示侧边栏/ }).click()
    const overlay = page.locator('[data-narrow-overlay]')
    await expect(overlay).toBeVisible()
    const navButton = overlay.getByRole('button', { name: new RegExp(`^${label}(?:\\s|⌘|$)`) })

    if (index === 2) {
      await navButton.focus()
      await page.keyboard.press('Enter')
    } else {
      await navButton.click()
    }

    await expect(overlay).toHaveCount(0)
  }

  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setBounds({ height: 800, width: 1220, x: 0, y: 0 }, false)
  )
  await page.waitForTimeout(400)
  await expect(page.locator('[data-sidebar="menu-button"]')).toHaveCount(BUSINESS_NAV_LABELS.length)
  await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '项目' }).first().click()
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
  await expect(page.locator('[data-start-recommended-workflows] [data-workflow-artwork="video-transcript"]')).toBeVisible()
  await expect(page.locator('[data-start-recommended-workflows] [data-workflow-artwork="viral-video-remake"]')).toBeVisible()
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
    await page.locator('[data-sidebar="menu-button"]').filter({ hasText: surface.nav }).first().click()
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
    await page
      .locator('[data-sidebar="menu-button"]')
      .filter({ hasText: phasePage.nav.replace(' ⌘ N', '') })
      .first()
      .click()
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
      expect(bounds?.height).toBe(viewport.height)

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
        const sidebarTrigger = page.getByRole('button', { name: /显示侧边栏/ })

        await expect(sidebarTrigger).toBeVisible()
        await expect(page.locator('[data-sidebar="menu-button"]')).toHaveCount(0)

        if (process.platform === 'darwin') {
          const triggerBox = await sidebarTrigger.boundingBox()

          expect(triggerBox?.x).toBeGreaterThanOrEqual(70)
        }

        const lowerContent = {
          start: page.getByRole('heading', { name: '可用数据源', level: 2 }),
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
  await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '交付物' }).first().click()

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
  await page.getByRole('button', { name: '打开当前运行' }).click()

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
    expect(bounds?.height).toBe(viewport.height)
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
        await page.getByRole('button', { name: '打开当前运行' }).click()
      } else {
        await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '项目' }).first().click()
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
        expect(bounds.height).toBe(viewport.height)
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
  const version = await page.evaluate(() => window.hermesDesktop?.getVersion())

  expect(version?.appVersion).toBe('0.17.24')
  expect(version?.engineVersion).toBeTruthy()

  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setBounds({ height: 800, width: 1220, x: 0, y: 0 }, false)
  )
  await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '工作流' }).first().click()
  await expect(page.getByRole('heading', { name: '工作流', level: 1 })).toBeVisible()
  await page.getByRole('button', { name: /打开账户菜单.*本地 UI 评审/ }).click()
  await page.getByRole('menuitem', { name: '设置' }).click()
  await expect(page.getByText('版本 0.17.24', { exact: true }).first()).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: '关闭设置' }).click()
  await expect(page.getByRole('heading', { name: '工作流', level: 1 })).toBeVisible()
})

test('a legacy Project envelope opens an honest detail before its goal can continue', async () => {
  const { app, page } = fixture!

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ height: 800, width: 1220 }))
  await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '项目' }).first().click()
  const row = page.getByRole('button', { name: /尚未启动的业务目标/ })

  await expect(row).toBeVisible()
  await row.click()
  const detail = page.locator('[data-project-detail]')

  await expect(detail).toBeVisible()
  await expect(detail.getByText('运行摘要暂时不可用')).toBeVisible()
  await expect(detail.getByText(/当前接口没有提供运行摘要/)).toBeVisible()
  await expect(detail.getByText('[本地测试] 尚未启动的业务目标', { exact: true })).toHaveCount(1)
  await expect(page.getByRole('textbox', { name: '业务目标' })).toHaveCount(0)
  await expect(detail.getByText(/0 \/ 0|百分比|待处理事项/)).toHaveCount(0)

  for (const viewport of [...PHASE1_VIEWPORTS, { height: 800, width: 1099 }, { height: 800, width: 1100 }]) {
    const bounds = await app.evaluate(({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]!
      win.unmaximize()
      win.setBounds({ height: size.height, width: size.width, x: 0, y: 0 }, false)
      return win.getBounds()
    }, viewport)
    expect(bounds.width).toBe(viewport.width)
    expect(bounds.height).toBe(viewport.height)
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
      await page.getByRole('button', { name: /显示侧边栏/ }).click()
    }

    await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '项目' }).first().click()
    await page.getByRole('button', { name: /\[本地测试\] 美国宠物用品机会分析/ }).click()
    await page.getByRole('button', { name: '打开当前运行' }).click()

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

test('local workflow catalog is labeled and reaches editable pre-start confirmation', async () => {
  const { app, page } = fixture!

  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setBounds({ height: 800, width: 1220, x: 0, y: 0 }, false)
  )
  await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '工作流' }).first().click()
  await expect(page.getByText(/本地测试数据：此目录仅用于实包视觉与交互验收/)).toBeVisible()
  await page.getByRole('button', { name: /竞品监控/ }).click()

  const goal = page.getByRole('textbox', { name: '业务目标' })
  await expect(page.locator('[data-workflow-start-confirmation]')).toContainText('启动前确认')
  await expect(page.locator('[data-workflow-start-confirmation]')).toContainText('Hermes')
  await expect(page.locator('[data-workflow-start-confirmation]')).toContainText('版本 1')
  await expect(goal).toBeEditable()
  await goal.fill('本地测试：编辑后的竞品监控目标')
  await expect(goal).toHaveValue('本地测试：编辑后的竞品监控目标')
})

test('packaged plain goal clears a retained workflow template and starts a real chat turn', async () => {
  const { app, page } = fixture!
  const prompt = '分析美国宠物用品市场，并生成选品报告和上架素材'
  const longPrompt = `${prompt}\n\n${TASK_PANEL_RESUME_TRIGGER}`
  const translucencyBefore = await page.evaluate(() => window.localStorage.getItem('hermes.desktop.translucency.v2'))

  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setBounds({ height: 800, width: 1220, x: 0, y: 0 }, false)
  )
  reviewApi!.setWorkflowEnabled(true)
  await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '工作流' }).first().click()
  await page.getByRole('button', { name: /竞品监控/ }).click()
  await expect(page.locator('[data-workflow-start-confirmation]')).toBeVisible()
  await expect(page.locator('[data-workflow-start-confirmation]').getByRole('status')).toContainText('本地测试数据')
  await page.getByRole('button', { name: '更换工作流' }).click()
  await expect(page.getByRole('heading', { name: '工作流', level: 1 })).toBeVisible()
  await page.getByRole('button', { name: '开始一个目标' }).click()
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setBounds({ height: 800, width: 752, x: 0, y: 0 }, false)
  )
  const goal = page.getByRole('textbox', { name: '业务目标' })

  await expect(goal).toBeVisible()
  await expect(page.locator('[data-workflow-start-confirmation]')).toHaveCount(0)
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
