// The commands the engine's bundled Node puts on PATH: thin entries into apex_overlay, which keeps each upstream CLI
// unchanged and adds APEX's setup (Hypit; hc-1177 openfilm). The bin folder is the Node folder itself on Windows and
// its bin/ elsewhere, so each entry climbs to the engine root accordingly.
/** @type {Readonly<Record<string, string>>} */
export const NODE_COMMANDS = Object.freeze({ hypit: 'hypit_cli.mjs', openfilm: 'openfilm_cli.mjs' })

/**
 * Each file to write into the bundled Node's bin folder for `targetOs` ('win' or another), with its mode.
 * @param {string} targetOs @returns {Array<{ file: string, content: string, mode?: number }>}
 */
export function runtimeNodeShims(targetOs) {
  const up = targetOs === 'win' ? '../../' : '../../../'
  return Object.entries(NODE_COMMANDS).flatMap(([name, entry]) => [
    { file: name, content: `#!/usr/bin/env node\nimport '${up}apex_overlay/${entry}'\n`, mode: 0o755 },
    ...(targetOs === 'win'
      ? [{ file: `${name}.cmd`, content: `@echo off\r\n"%~dp0node.exe" "%~dp0..\\..\\apex_overlay\\${entry}" %*\r\n` }]
      : [])
  ])
}
