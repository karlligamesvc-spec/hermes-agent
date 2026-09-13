import { type MockBackendFixture, setupMockBackend, waitForAppReady } from './fixtures'
import { expect, test } from './test'

let fixture: MockBackendFixture | null = null

async function openBots(page: MockBackendFixture['page']): Promise<void> {
  const tab = page
    .getByRole('button', { name: 'Assistants', exact: true })
    .or(page.getByRole('tab', { name: 'Assistants', exact: true }))
    .first()
  await tab.click()
  await expect(page.getByRole('button', { name: 'Add an assistant or create a group chat' })).toBeVisible()
}

async function createAgent(page: MockBackendFixture['page'], name: string, title: string): Promise<void> {
  await page.getByRole('button', { name: 'Add an assistant or create a group chat' }).click()
  await page.getByRole('menuitem', { name: 'Add assistant' }).click()

  const dialog = page.getByRole('dialog', { name: 'Add assistant' })
  await dialog.getByPlaceholder('inbox-triage').fill(name)
  await dialog.getByPlaceholder('Inbox Triage').fill(title)
  await dialog.getByRole('button', { name: 'Add assistant' }).click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: new RegExp(`^${title}\\b`) }).first()).toBeVisible({ timeout: 30_000 })
}

test.beforeAll(async () => {
  fixture = await setupMockBackend()
  await waitForAppReady(fixture, 120_000)
})

test.afterAll(async () => {
  await fixture?.cleanup()
  fixture = null
})

test('local bot replaces an open group main workspace', async () => {
  test.setTimeout(180_000)
  const page = fixture!.page

  await openBots(page)
  await createAgent(page, 'programmer', 'Programmer')
  await createAgent(page, 'reviewer', 'Reviewer')

  await page.getByRole('button', { name: 'Add an assistant or create a group chat' }).click()
  await page.getByRole('menuitem', { name: 'Create group chat' }).click()

  const dialog = page.getByRole('dialog', { name: 'Create group chat' })

  for (const title of ['Programmer', 'Reviewer']) {
    await dialog.getByText(title, { exact: true }).locator('xpath=ancestor::label').getByRole('checkbox').click()
  }

  await dialog.getByRole('textbox', { name: 'Group name' }).fill('Programmer, Reviewer')
  await dialog.getByRole('button', { name: 'Create group chat (2)' }).click()

  const groupTab = page.getByRole('tab', { name: /Programmer, Reviewer Close/ })
  const groupComposer = page.getByRole('textbox', { name: 'Message Programmer, Reviewer' }).filter({ visible: true })
  await expect(groupTab).toBeVisible({ timeout: 20_000 })
  await expect(groupTab).toHaveAttribute('aria-selected', 'true')
  await expect(groupComposer).toBeVisible()

  const programmer = page.getByRole('button', { name: /^Programmer\b/ }).filter({ visible: true }).first()
  await programmer.click()

  const botChatTab = page.getByRole('tab', { name: /Bot Chat Close/ }).filter({ visible: true })
  await expect(botChatTab).toBeVisible({ timeout: 30_000 })
  await expect(botChatTab).toHaveAttribute('aria-selected', 'true')
  await expect(groupTab).toHaveCount(0)
  await expect(groupComposer).toHaveCount(0)
  await expect(page.getByText(/Waking up Programmer/i)).toHaveCount(0)
  await expect(page.locator('[data-slot="composer-root"] [contenteditable="true"]').filter({ visible: true }).first()).toBeVisible()
})
