import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

import { type PackagedMockBackendFixture, setupPackagedMockBackend, waitForAppReady } from './fixtures'
import { TASK_PANEL_RESUME_TRIGGER } from './mock-server'
import { expect, test } from './test'

const BUSINESS_NAV_LABELS = ['开始', '项目', '工作流', '定时运行', '交付物', '助手', '历史'] as const

const PHASE1_VIEWPORTS = [
  { height: 900, name: 'wide-1440', width: 1440 },
  { height: 800, name: 'desktop-1220', width: 1220 },
  { height: 800, name: 'narrow-752', width: 752 }
] as const

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
    await fixture.page.evaluate(() => {
      const opaqueWindow = {
        fade: 0,
        intensity: 0,
        material: 'under-window' as const,
        mode: 'glass' as const,
        scope: 'window' as const
      }

      window.localStorage.setItem(
        'hermes.desktop.translucency.v2',
        JSON.stringify({ base: opaqueWindow, dark: {}, light: {}, mode: opaqueWindow.mode })
      )
      window.hermesDesktop?.setTranslucency?.(opaqueWindow)
    })
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

  await expect(sidebarButtons).toHaveCount(7)

  const businessLabels = (await sidebarButtons.allTextContents())
    .map(label => label.replace(/\s+/g, ' ').trim())
    .map(label => label.replace(/\s*⌘\s*N$/, ''))

  expect(businessLabels).toEqual(BUSINESS_NAV_LABELS)
  await expect(page.getByText(/\b(?:MCP|Skill|Skills)\b/)).toHaveCount(0)
  await expect(page.getByText('模型', { exact: true })).toHaveCount(0)
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
  await expect(page.locator('[data-sidebar="menu-button"]')).toHaveCount(7)
  await page.locator('[data-sidebar="menu-button"]').filter({ hasText: '项目' }).first().click()
  await expect(page.locator('[data-sidebar="menu-button"]')).toHaveCount(7)
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

test('packaged Phase 1 pages keep local review data explicit across the approved window matrix', async () => {
  const { app, page } = fixture!
  const testInfo = test.info()
  const screenshotRoot = process.env.PHASE1_SCREENSHOT_DIR
  if (screenshotRoot) {
    fs.mkdirSync(screenshotRoot, { recursive: true })
  }

  await expect(page.locator('[data-business-start-shelf]')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('[本地测试] 美国宠物用品机会分析')).toBeVisible()

  const pages = [
    { name: 'start', nav: '开始 ⌘ N', title: '今天想推进什么业务？' },
    { name: 'projects', nav: '项目', title: '项目' },
    { name: 'workflows', nav: '工作流', title: '工作流' }
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

        const lowerContent =
          phasePage.name === 'start'
            ? page.getByRole('heading', { name: '可用数据源', level: 2 })
            : phasePage.name === 'projects'
              ? page.getByText('[本地测试] APEX GEO 品牌诊断', { exact: true })
              : page.getByText('[本地测试] 我的选品流程', { exact: true })

        await lowerContent.scrollIntoViewIfNeeded()
        await expect(lowerContent).toBeVisible()

        const heading = page.getByRole('heading', { name: phasePage.title, level: 1 })
        await heading.scrollIntoViewIfNeeded()
        await expect(heading).toBeVisible()
      }
    }
  }
})

test('packaged Settings shows the running APEX app version separately from the engine', async () => {
  const { app, page } = fixture!
  const version = await page.evaluate(() => window.hermesDesktop?.getVersion())

  expect(version?.appVersion).toBe('0.17.24')
  expect(version?.engineVersion).toBeTruthy()

  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setBounds({ height: 800, width: 1220, x: 0, y: 0 }, false)
  )
  await page.getByRole('button', { name: '本地 UI 评审' }).click()
  await page.getByRole('menuitem', { name: '设置' }).click()
  await expect(page.getByText('版本 0.17.24', { exact: true }).first()).toBeVisible({ timeout: 15_000 })

  await page.goBack()
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

  await page.getByRole('button', { name: '继续这个目标' }).click()
  await expect(page.getByRole('textbox', { name: '业务目标' })).toHaveValue('[本地测试] 尚未启动的业务目标')
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
})
