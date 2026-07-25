#!/usr/bin/env node
// assert-icon.cjs — LOCK the app icon so it can't silently drift between builds.
//
// Repeated past updates kept changing the icon's on-screen size/padding. The
// committed icon is macOS-grid-correct: 1024x1024 canvas, art ~820px (≈80% fill,
// ~10% transparent margin per side) — matching Apple's app-icon standard so it
// renders the SAME size as other Dock apps. This guard fails the build if any
// icon asset changes, forcing an intentional (reviewed) update.
//
// To intentionally change the icon: replace the asset(s), keep 1024x1024 + the
// ~80% art fill (10% margin), then update the sha256 below
// (run: `shasum -a 256 assets/icon.png assets/icon.icns assets/icon.ico \
//         public/apple-touch-icon.png`).
//
// hc-589: public/apple-touch-icon.png is pinned here too. It is not just a
// favicon — it is the in-app brand mark (login screen, onboarding rows, the
// Electron window/taskbar icon), and an upstream rebase silently replaced it
// with the upstream mascot while the three bundle icons above were still
// unguarded (the build script had dropped this check). Both halves are back.
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const EXPECTED = {
  'assets/icon.png': 'fb28595680bbae35b9357ebb40d4866d4e5353b31269a1e8684d66e505193817',
  'assets/icon.icns': '2d9f13eb9be85e243c7268fc5c83bbe66e6b26dc6e8df277c1c596ca3b724155',
  'assets/icon.ico': 'ae2299f9b34252c7dc3834d142319e745e1624f8bdf0b6f51d4fcd0702050eef',
  'public/apple-touch-icon.png': 'cefdffb38638a13d574422d0d91a6a15a8590a2878f206b7717713edc16303bf'
}

let failed = false

for (const [name, expected] of Object.entries(EXPECTED)) {
  let buf
  try {
    buf = fs.readFileSync(path.join(ROOT, name))
  } catch {
    console.error(`[assert-icon] missing icon asset: ${name}`)
    failed = true
    continue
  }
  const got = crypto.createHash('sha256').update(buf).digest('hex')
  if (got !== expected) {
    console.error(
      `[assert-icon] ${name} changed (sha256 ${got.slice(0, 12)}… ≠ pinned ${expected.slice(0, 12)}…).\n` +
        '  The app icon is LOCKED to stop size/padding drift AND upstream-rebase\n' +
        '  brand loss. If intentional: keep 1024x1024 + ~80% art fill (macOS grid),\n' +
        '  then update the sha256 in scripts/assert-icon.cjs.'
    )
    failed = true
  }
}

// Belt-and-suspenders: PNG must be exactly 1024x1024 (IHDR width/height at 16..24).
try {
  const png = fs.readFileSync(path.join(ROOT, 'assets', 'icon.png'))
  const w = png.readUInt32BE(16)
  const h = png.readUInt32BE(20)
  if (w !== 1024 || h !== 1024) {
    console.error(`[assert-icon] assets/icon.png must be 1024x1024, got ${w}x${h}`)
    failed = true
  }
} catch {
  // readFileSync failure already reported above.
}

if (failed) {
  process.exit(1)
}
console.log('[assert-icon] icon locked + valid (1024x1024, pinned sha256, ~80% macOS-grid fill)')
