import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

import type { Page } from '@playwright/test'

import { type PackagedMockBackendFixture, setupPackagedMockBackend, waitForAppReady } from './fixtures'
import { TASK_PANEL_RESUME_TRIGGER } from './mock-server'
import { expect, test } from './test'

const BUSINESS_NAV_LABELS = ['开始', '项目', '工作流', '定时运行', '交付物'] as const

const PHASE1_VIEWPORTS = [
  { height: 900, name: 'wide-1440', width: 1440 },
  { height: 800, name: 'desktop-1220', width: 1220 },
  { height: 800, name: 'narrow-752', width: 752 }
] as const

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

async function startPhase1ReviewApi() {
  let relayBaseUrl = ''
  let workflowEnabled = true
  const server = http.createServer((request, response) => {
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

    if (
      request.method === 'GET' &&
      url.pathname === '/api/v1/workflow-domain/runs/local-review-run-running'
    ) {
      json(200, {
        deliverables: [],
        events: [
          {
            eventType: 'run.queued',
            happenedAt: '2026-09-05T21:05:00Z',
            id: 'local-review-event-queued',
            payload: {},
            sequence: 1
          },
          {
            eventType: 'run.running',
            happenedAt: '2026-09-05T21:06:00Z',
            id: 'local-review-event-started',
            payload: {},
            sequence: 2
          }
        ],
        run: {
          attempt: 1,
          createdAt: '2026-09-05T21:05:00Z',
          errorMessage: null,
          executorType: 'hermes',
          id: 'local-review-run-running',
          maxAttempts: 2,
          status: 'running',
          triggerRef: '[本地测试] 验证工作流运行抽屉的安全区与关闭入口'
        }
      })

      return
    }

    json(404, { detail: 'not found' })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo

  return {
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
    setRelayBaseUrl: (value: string) => {
      relayBaseUrl = value
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
        { columns: 3, width: 899 },
        { columns: 2, width: 900 },
        { columns: 2, width: 1000 },
        { columns: 3, width: 1220 },
        { columns: 3, width: 1235 }
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
      expect(bounds?.height).toBeLessThanOrEqual(viewport.height)

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
          deliverables: page.getByText('未找到产物', { exact: true })
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
    const cancel = drawer.getByRole('button', { name: '取消运行' })

    await expect(drawer).toBeVisible()
    await expect(content).toBeVisible()
    await expect(close).toBeVisible()
    await expect(cancel).toBeVisible()
    await expect(drawer).toHaveAttribute('data-layout', viewport.width >= 1100 ? 'drawer' : 'fullscreen')

    const geometry = await page.evaluate(() => {
      const drawerElement = document.querySelector<HTMLElement>('[data-route-drawer]')
      const contentElement = drawerElement?.querySelector<HTMLElement>('section > div')
      const closeElement = drawerElement?.querySelector<HTMLElement>('button[aria-label="关闭"]')

      const cancelElement = Array.from(drawerElement?.querySelectorAll<HTMLElement>('button') ?? []).find(button =>
        button.textContent?.includes('取消运行')
      )

      if (!drawerElement || !contentElement || !closeElement || !cancelElement) {
        return null
      }

      const drawerBox = drawerElement.getBoundingClientRect()
      const contentBox = contentElement.getBoundingClientRect()
      const closeBox = closeElement.getBoundingClientRect()
      const cancelBox = cancelElement.getBoundingClientRect()

      const overlaps = !(
        closeBox.right <= cancelBox.left ||
        closeBox.left >= cancelBox.right ||
        closeBox.bottom <= cancelBox.top ||
        closeBox.top >= cancelBox.bottom
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
    expect(geometry!.contentInset).toBeGreaterThanOrEqual(viewport.width >= 1100 ? 31 : 23)
    expect(geometry!.overlaps).toBe(false)
    expect(geometry!.rootScrollWidth).toBeLessThanOrEqual(geometry!.rootClientWidth)

    if (viewport.width >= 1100) {
      expect(geometry!.drawerWidth).toBeGreaterThanOrEqual(630)
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

  const composerStopButton = page.locator('form').getByRole('button', { name: '停止', exact: true })
  if (await composerStopButton.isVisible()) {
    await composerStopButton.click()
    await expect(composerStopButton).toHaveCount(0, { timeout: 15_000 })
  }
})
