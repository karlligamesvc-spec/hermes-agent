/**
 * apex-chatcut.ts — ChatCut on the main-process side (hc-1122).
 *
 * The switch is the platform client config's `desktop_features.chatcut`, off by
 * default; `APEXNODES_CHATCUT` overrides it for one install. Main settles it into
 * APEX_CHATCUT_ACTIVE=1 before the engine spawns, and the engine
 * (apex_overlay/chatcut.py) does the rest. Off, the variable is removed, and that
 * seam registers nothing and takes back whatever an earlier launch left.
 *
 * The other half is what leaves with an APEX account. ChatCut's tokens belong to
 * whoever connected them, and the next person to sign in on this computer is not
 * necessarily that person, so signing out or changing account removes them from
 * every assistant, the same way the relay key leaves (hc-1114). That runs whatever
 * the switch says: the switch going off must not strand a credential. Removing the
 * local copy is all that can be done: ChatCut publishes no revocation endpoint.
 *
 * The editor runs in the preview panel, whose session (`persist:hermes-preview`)
 * has no download handling and keeps its own sign-in and locally stored footage:
 * without the seam below an export stops on a native save dialog, and the next person
 * to sign in on this computer would find the last one's ChatCut in the panel.
 *
 * Electron-free apart from what main hands in: unit-tested with `vitest --project electron`.
 */

import fs from 'node:fs'
import path from 'node:path'

import { desktopFeatureOnForLaunch } from './apex-desktop-features'

/** Written by main for the engine; never an input. */
export const CHATCUT_ACTIVE_ENV = 'APEX_CHATCUT_ACTIVE'

export const CHATCUT_FEATURE = 'chatcut'

const SERVER_NAME = 'chatcut'
const PANEL_PARTITION = 'persist:hermes-preview'
const EDITOR_ORIGIN = 'https://app.chatcut.io'
const API_ORIGIN = 'https://api.chatcut.io'
/** The sign-in cookies sit on the parent domain, where clearing an origin does not reach them. */
const COOKIE_DOMAIN = 'chatcut.io'
/** A developer's own server may share the name; only this endpoint's entry is ours to remove. */
const CHATCUT_HOST = 'api.chatcut.io'

/** Settle the switch for this launch: 1 when on, removed when off. Returns whether it is on. */
export function applyChatcutSwitch(
  env: Record<string, string | undefined>,
  clientConfigPayload: unknown,
  log: (line: string) => void = () => undefined
): boolean {
  if (!desktopFeatureOnForLaunch(CHATCUT_FEATURE, env, clientConfigPayload)) {
    delete env[CHATCUT_ACTIVE_ENV]

    return false
  }

  env[CHATCUT_ACTIVE_ENV] = '1'
  log(`[client-config] ${CHATCUT_ACTIVE_ENV}=1 (desktop_features.chatcut)`)

  return true
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

function isContent(line: string): boolean {
  const text = line.trim()

  return text !== '' && !text.startsWith('#')
}

/** The lines of `key:`'s block among the entries in [from, to), as [start, end). Null when absent. */
function blockRange(lines: readonly string[], key: string, from = 0, to = lines.length): null | [number, number] {
  const firstEntry = lines.slice(from, to).find(isContent)
  const indent = from === 0 || firstEntry === undefined ? 0 : indentOf(firstEntry)

  const head = lines.findIndex(
    (line, index) =>
      index >= from && index < to && indentOf(line) === indent && line.trim().replace(/\s+#.*$/, '') === `${key}:`
  )

  if (head < 0) {
    return null
  }

  let end = head + 1

  while (end < to && (!isContent(lines[end]) || indentOf(lines[end]) > indent)) {
    end += 1
  }

  // Blank lines and comments after the block belong to whatever follows it.
  while (end > head + 1 && !isContent(lines[end - 1])) {
    end -= 1
  }

  return [head, end]
}

/**
 * config.yaml without ChatCut's `mcp_servers` entry, every other byte as it was.
 * Null when there is nothing to remove: no such entry, or one pointing elsewhere.
 */
export function withoutChatcutEntry(text: string): null | string {
  const lines = text.split('\n')
  const servers = blockRange(lines, 'mcp_servers')

  if (!servers) {
    return null
  }

  const entry = blockRange(lines, SERVER_NAME, servers[0] + 1, servers[1])

  if (!entry || !lines.slice(entry[0], entry[1]).some(line => line.includes(CHATCUT_HOST))) {
    return null
  }

  const emptied = !lines
    .slice(servers[0] + 1, servers[1])
    .some((line, index) => {
      const at = index + servers[0] + 1

      return isContent(line) && (at < entry[0] || at >= entry[1])
    })

  const [start, end] = emptied ? servers : entry

  return [...lines.slice(0, start), ...lines.slice(end)].join('\n')
}

/** Where an export from the editor lands: Downloads, never over an existing file. */
export function chatcutDownloadPath(downloadsDir: string, filename: string, exists = fs.existsSync): string {
  const { ext, name } = path.parse(path.basename(filename) || 'chatcut-export')
  let candidate = path.join(downloadsDir, `${name}${ext}`)

  for (let copy = 1; exists(candidate); copy += 1) {
    candidate = path.join(downloadsDir, `${name} (${copy})${ext}`)
  }

  return candidate
}

function isEditorPage(url: null | string | undefined): boolean {
  try {
    return new URL(String(url)).origin === EDITOR_ORIGIN
  } catch {
    return false
  }
}

interface DownloadLike {
  getFilename(): string
  setSavePath(path: string): void
}

interface PanelSessionLike {
  clearCache(): Promise<void>
  clearStorageData(options: { origin: string }): Promise<void>
  cookies: {
    get(filter: { domain: string }): Promise<{ domain?: string; name: string; path?: string }[]>
    remove(url: string, name: string): Promise<void>
  }
  on(event: 'will-download', listener: (event: unknown, item: DownloadLike, contents?: { getURL(): string }) => void): unknown
}

interface OpenPagesLike {
  getAllWebContents(): readonly { getURL(): string; reload(): void }[]
}

let clearPanelSession: (() => void) | null = null

/**
 * The sign-in, the locally stored footage and the cached project pages all go, and an
 * editor still open reloads into the sign-in page instead of keeping the last person's
 * project on screen. Other sites in the panel keep their own sign-ins. The HTTP cache
 * cannot be cleared per site, so it is only cleared when there was a ChatCut sign-in.
 */
async function clearChatcutFromPanel(panel: PanelSessionLike, openPages: OpenPagesLike): Promise<void> {
  const cookies = await panel.cookies.get({ domain: COOKIE_DOMAIN })

  await Promise.all(
    cookies.map(({ domain = COOKIE_DOMAIN, name, path: at = '/' }) =>
      panel.cookies.remove(`https://${domain.replace(/^\./, '')}${at}`, name)
    )
  )
  await Promise.all([EDITOR_ORIGIN, API_ORIGIN].map(origin => panel.clearStorageData({ origin })))

  if (cookies.length > 0) {
    await panel.clearCache()
  }

  for (const page of openPages.getAllWebContents()) {
    if (isEditorPage(page.getURL())) {
      page.reload()
    }
  }
}

/**
 * Called once at startup. With the switch on, a download started by the editor saves
 * straight to Downloads and every other page in the panel keeps the save dialog. The
 * panel's ChatCut sign-in is cleared with the account whatever the switch says, so a
 * rollback strands nothing; the session is only touched at that moment, so with the
 * switch off and no sign-out nothing here runs at all.
 */
export function installChatcutPanel(
  sessions: { fromPartition(partition: string): PanelSessionLike },
  openPages: OpenPagesLike,
  downloadsDir: () => string,
  env: Record<string, string | undefined>,
  log: (line: string) => void = () => undefined
): void {
  clearPanelSession = () => {
    void clearChatcutFromPanel(sessions.fromPartition(PANEL_PARTITION), openPages).catch(error =>
      log(`[chatcut] could not clear the panel: ${error}`)
    )
  }

  if (env[CHATCUT_ACTIVE_ENV] !== '1') {
    return
  }

  sessions.fromPartition(PANEL_PARTITION).on('will-download', (_event, item, contents) => {
    if (isEditorPage(contents?.getURL())) {
      item.setSavePath(chatcutDownloadPath(downloadsDir(), item.getFilename()))
    }
  })
}

function assistantHomes(root: string): string[] {
  let profiles: string[] = []

  try {
    profiles = fs
      .readdirSync(path.join(root, 'profiles'), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(root, 'profiles', entry.name))
  } catch {
    // No profiles yet.
  }

  return [root, ...profiles]
}

function removeTokenFiles(home: string): boolean {
  const dir = path.join(home, 'mcp-tokens')
  let names: string[] = []

  try {
    names = fs.readdirSync(dir).filter(name => name.startsWith(`${SERVER_NAME}.`))
  } catch {
    return false
  }

  for (const name of names) {
    fs.rmSync(path.join(dir, name), { force: true })
  }

  return names.length > 0
}

/**
 * The account changed or signed out: no ChatCut connection stays on this computer.
 * Every assistant's tokens, config entry and upload consent go. Best-effort per
 * file, so one unreadable file cannot leave the rest behind or block the sign-out.
 * Returns the homes it found something in. A running engine that refreshes its
 * token afterwards is caught by the engine's boot rule: tokens with no entry go.
 */
export function scrubChatcutConnections(root: string): string[] {
  const touched: string[] = []

  clearPanelSession?.()

  for (const home of assistantHomes(root)) {
    let found = false

    try {
      const configPath = path.join(home, 'config.yaml')
      const next = withoutChatcutEntry(fs.readFileSync(configPath, 'utf8'))

      if (next !== null) {
        fs.writeFileSync(configPath, next, { mode: 0o600 })
        found = true
      }
    } catch {
      // No config here, or it cannot be read: the tokens below still go.
    }

    try {
      found = removeTokenFiles(home) || found
      const consent = path.join(home, 'apex', 'chatcut-upload-consent.json')

      if (fs.existsSync(consent)) {
        fs.rmSync(consent, { force: true })
        found = true
      }
    } catch {
      // Best-effort, as above.
    }

    if (found) {
      touched.push(home)
    }
  }

  return touched
}
