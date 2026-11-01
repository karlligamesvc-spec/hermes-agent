import fs from 'node:fs'

/**
 * Reveal a path in the OS file manager. `shell.showItemInFolder` says nothing
 * about a missing file and opens nothing, so the file is checked first and the
 * caller hears `false` (hc-1130: a result card can outlive its cached file).
 */
export async function revealInFileManager(
  rawPath: unknown,
  expandUserPath: (value: string) => string,
  show: (target: string) => void
): Promise<boolean> {
  const raw = String(rawPath || '').trim()

  if (!raw) {
    return false
  }

  const target = expandUserPath(raw)

  try {
    await fs.promises.access(target)
    show(target)

    return true
  } catch {
    return false
  }
}
