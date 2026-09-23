import { spawn } from 'node:child_process'

export type LocalVideoTool = 'node' | 'npm' | 'ffmpeg' | 'ffprobe'

export interface LocalVideoReadiness {
  basicToolsReady: boolean
  missing: LocalVideoTool[]
  // Hypit is installed per project; its render browser and provider are
  // prepared separately. A PATH probe must never claim a finished render.
  renderVerified: false
}

type Probe = (tool: LocalVideoTool) => Promise<boolean>

const TOOLS: readonly LocalVideoTool[] = ['node', 'npm', 'ffmpeg', 'ffprobe']

export function probeLocalVideoTool(tool: LocalVideoTool, executablePath = process.env.PATH): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false

    const finish = (available: boolean) => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timer)
      resolve(available)
    }

    // npm is a .cmd launcher on Windows; these command names and arguments
    // are fixed by us, not user input. All other probes avoid a shell.
    const child = spawn(tool, ['--version'], {
      env: { ...process.env, PATH: executablePath },
      shell: process.platform === 'win32' && tool === 'npm',
      stdio: 'ignore',
      windowsHide: true
    })

    const timer = setTimeout(() => {
      child.kill()
      finish(false)
    }, 3000)

    child.once('error', () => finish(false))
    child.once('exit', code => finish(code === 0))
  })
}

export async function checkLocalVideoReadiness(probe: Probe = probeLocalVideoTool): Promise<LocalVideoReadiness> {
  const results = await Promise.all(TOOLS.map(async tool => ({ tool, available: await probe(tool) })))
  const missing = results.filter(result => !result.available).map(result => result.tool)

  return { basicToolsReady: missing.length === 0, missing, renderVerified: false }
}
