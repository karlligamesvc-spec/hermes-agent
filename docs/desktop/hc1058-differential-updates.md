# hc-1058: small Desktop updates

## How a shell update downloads

electron-updater 6.8.9 updates the shell differentially:

1. It compares the blockmap of the cached old package with the new one. Blockmaps split a file into content-defined 8–32 KB chunks with blake2b-18 checksums.
2. It fetches only the changed chunks, as single HTTP ranges.
3. It checks the rebuilt file's sha512 and downloads the whole package if that fails.

| Platform | Package | Cached old package |
| --- | --- | --- |
| macOS | `APEX-<v>-mac-arm64.zip` | `update.zip`, the last download |
| Windows | `APEX-<v>-win-x64.exe` (NSIS) | `installer.exe`, the last installed version |

## Why every release downloaded 75–81%

Measured on the published 0.17.60 → 0.17.63 blockmaps:

1. The bundled engine (`Resources/bundled-runtime/runtime-bundle-*.tar.gz`, about 343 MiB of the Mac zip) came from `tar -czf`. Each build changed its bytes throughout:
   - entry order, mtimes and owners followed the runner;
   - the archive was one gzip stream, so everything after the first change differed;
   - every Mach-O file is re-signed with a new timestamp, though its CDHash is identical.
2. The Mac update zip deflated that archive again, and the Windows installer packed it into an LZMA 7z.
3. A download that was never installed left the cached old package and the cached blockmap describing different versions. The differential then failed its sha512 and the full package came down after it. Fixed by fork #485.

## What keeps updates small now

| Piece | Where | Guard |
| --- | --- | --- |
| Deterministic engine archive: sorted entries, fixed mtime 2000-01-01, owner 0/0, hard links stored once (as bsdtar did), gzip in ~64 KiB content-defined segments, each a fresh deflate primed with the previous 32 KiB | `scripts/runtime-bundle-archive.mjs`, used by `build-runtime-bundle.mjs` | `runtime-bundle-archive.node-test.mjs` |
| The Mac update zip stores the engine entry instead of deflating it: Info-ZIP `ZIPOPT -n …:.gz`, set in `afterPack` | `scripts/after-pack.mjs` | `desktop-macos.yml` "Assert update zip stores the engine archive" |
| The Windows installer carries the engine archive verbatim: `nsis.preCompressedFileExtensions` adds `.tar.gz` (out of the LZMA 7z), and `nsis.include` sets `COMPRESS=off` for those files. Under `auto`, NSIS's zlib shrinks gzip data by about 0.25% and stores it compressed; the first real Windows build (run 40345990841) showed exactly that | `package.json`, `scripts/nsis-store-engine.nsh` | `desktop-windows.yml` "Assert installer stores the engine archive" |
| The cached old package and blockmap are proved to match before each check | `electron/shell-update-diff-base.ts` (fork #485) | its tests |

The engine is still installed exactly as before: the packaged-engine gate extracts the bundled archive with the system tar.

## Version rule (Kael, 2026-10-26)

- **Patch releases (0.17.x)** are minor versions. Users get them by self-update, downloading only what changed: the shell code plus the engine files that changed, normally tens of MB.
- **Minor releases (0.18.0 and up)** are major versions and may ship as a full package. Electron major upgrades, a new Python minor version and packaging-format changes belong here.
- The client needs no rule of its own. The planner downloads whatever changed and falls back to the full package by itself.
- These are part of the archive format: the gear table, segment sizes, priming window, deflate level, fixed mtime and the Node major version the release builds with (zlib output). Changing any of them makes the next release a full download once, so change them only in a minor release.

## Measuring a release

```bash
B=https://apexnodes-runtime-202606250443-1300912302.cos.ap-guangzhou.myqcloud.com/desktop/mac-arm64
node apps/desktop/scripts/measure-update-download.mjs $B/APEX-0.17.63-mac-arm64.zip.blockmap $B/APEX-0.17.64-mac-arm64.zip.blockmap
```

Record the result for each platform in the release readback.

## Measured

Real published releases. Each published package was rebuilt the way this pipeline builds it:
- **Mac:** the engine is re-archived by the new writer, then the App is zipped like electron-builder 26 with the `afterPack` ZIPOPT. Code signatures were not redone; that does not change which blocks differ.
- **Windows:** the engine archive comes out of the published installer's 7z and is re-archived.

Mac arm64 update zip:

| Release | Today | With this change |
| --- | --- | --- |
| 0.17.62 → 0.17.63 (engine a2e1a4b5 → 7ae7a561) | 377.7 MB of 502.6 MB (75.1%) | **34.9 MB of 508.6 MB (6.9%)** |
| 0.17.63 → 0.17.64 | 375.1 MB of 502.6 MB (74.6%) | **26.3 MB of 508.7 MB (5.2%)** |

Engine archive alone:

| Release | Today | With this change |
| --- | --- | --- |
| Mac 0.17.62 → 0.17.63 | 360.4 MB (100%) | 16.3 MB (4.5%) |
| Mac 0.17.63 → 0.17.64 | 359.3 MB (99.6%) | 10.1 MB (2.8%) |
| Windows 0.17.62 → 0.17.63 | 494.5 MB (99.9%) | 8.1 MB (1.6%) |

Cost:
- the Mac engine archive grows 1.4% (360.5 → 365.4 MB), so the update zip grows by about 6 MB;
- the Windows engine archive grows 1.5% (495.0 → 502.4 MB).

## Still a full download

- The first release built with this change, because the old format differs from the new one.
- The first self-update after a DMG install: there is no `update.zip` yet.
- MSI installs, which write no `installer.exe`.
- A cleared updater cache.

## Release-only checks

`bundled-runtime-consumer-smoke.mts` runs only inside `desktop-release.yml`. It extracts the archive with the system tar, so it covers the new format.

It passed locally on Mac arm64 with:
- the real 0.17.63 engine re-archived by the new writer;
- a genuine F8 legacy runtime from `legacy-runtime-fixture.mjs`;
- `package.json` temporarily at 0.17.63.

The fresh install, the F8 upgrade with the user's data unchanged, and the restore after an injected post-switch failure all succeeded.

Before a release, a `desktop-windows.yml` dispatch (publish=false) is the cheapest way to see the NSIS store gate and the smoke pass on a real Windows build.
