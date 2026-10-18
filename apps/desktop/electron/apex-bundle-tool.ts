/**
 * apex-bundle-tool.ts — spawns the engine bundle's own tool (fixup / verify).
 *
 * The bundle ships scripts/build-runtime-bundle.mjs + its own node, so there is
 * no external fixup binary to keep in lockstep (manifest.fixup drives the argv).
 * Kept out of main.ts so the real spawn can be exercised by tests.
 */

import { spawn } from 'node:child_process'

import { hiddenWindowsChildOptions } from './windows-child-options'

// The verifier keeps scripts/build-runtime-bundle.mjs VERIFY_READS_IN_FLIGHT (16)
// reads in flight, but only as many overlap as its libuv threadpool has threads,
// and the child cannot raise that size once it is running (default 4). On
// Windows the first open of each freshly extracted file waits on the antivirus
// scan, so this sets the first-boot verify time (hc-923, win-5090: 87 s with 4,
// 26 s with 16). A verifier from an older engine keeps 8 in flight.
export const BUNDLE_TOOL_THREADPOOL_SIZE = '16'

export function runBundledTool(exe, argv, label, onOutput?: (line: string) => void) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(exe, argv, hiddenWindowsChildOptions({
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, UV_THREADPOOL_SIZE: BUNDLE_TOOL_THREADPOOL_SIZE }
    }))

    let tail = ''

    const cap = d => {
      tail = (tail + String(d)).slice(-2000)
      onOutput?.(String(d))
    }

    child.stdout.on('data', cap)
    child.stderr.on('data', cap)
    child.on('error', reject)
    child.on('close', code =>
      code === 0 ? resolve() : reject(new Error(`bundle ${label} exited ${code}: ${tail.slice(-400)}`))
    )
  })
}
