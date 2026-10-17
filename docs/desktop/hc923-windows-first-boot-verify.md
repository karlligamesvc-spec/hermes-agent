# hc-923: Windows first-boot engine verify keeps 16 reads in flight

## Problem

After every install or upgrade, APEX Desktop prepares the bundled engine: extract, fixup, per-file
verify against `.runtime/files.tsv`, move to the final path, fixup and verify again, probe, activate.
On win-5090 (Ryzen 9 9950X3D, 128 GB, one NVMe SSD, Windows 11 23H2, Microsoft Defender real-time
protection on) the first verify took 3m13s on the 0.17.57 first install and 3m23s on the 0.17.58
upgrade (hc-906 acceptance logs), out of 3m45s of engine setup. The final-path verify took about
3 s. Those runs started the app through a scheduled task, which runs it at low I/O priority (see
"Low I/O priority" below). Started normally, the same verify takes about 87 s on this host.

## Where the time goes

`apps/desktop/scripts/bundle-verify-bench.mjs` reproduces the packaged first boot on a fresh
directory per trial: System32 `tar.exe -xzf` as Desktop runs it, then the fresh tree's own node and
tool `fixup`, then one timed pass over the still-cold tree and the same pass again warm. It reads
Defender's CPU time (`MsMpEng.exe`, read-only); no antivirus setting was changed. All numbers below
use the 0.17.58 candidate's engine `runtime-bundle-d33534879169-win-x64` (67,596 verified files,
1.77 GB) on `C:\Users\<user>\AppData\Local`, the volume real installs use. D: gave the same result
(86.3 s for the unchanged verify).

Cold pass over a fresh tree, with the shipped verifier's 4 opens in flight:

| Pass | Cold | Warm |
|---|---|---|
| Attribute query only (`stat`) | 0.6 s | 0.6 s |
| Open and close, no read | 86.1 s | 0.9 s |
| Open and read, no hashing | 86.8 s | 1.7 s |
| Full verify | 86.3–87.7 s (6 runs) | 2.4 s |

About 98% of the cold time is the first open of each freshly extracted file. Hashing all 1.77 GB
costs under a second. A first open waits 4.7 ms at the median (p90 8.1 ms, p99 13.1 ms), growing
with file size from 3.8 ms under 1 KB to about 55 ms above 4 MB, which is the shape of an on-access
content scan. Besides Defender's `WdFilter`, this host also runs Alibaba's `AliPaladin` file-system
filter on every volume, as e-commerce sellers' machines often do.

The verifier runs 8 async read loops, but `fs.promises` work runs on libuv's threadpool, 4 threads by
default and sized once at process start. With the bundled Node 22.23.3 on win-5090, setting
`UV_THREADPOOL_SIZE` inside the script is ignored; only the spawn environment changes it. So the
shipped verify has only 4 opens in flight, and its time is the per-open wait divided by 4.

Cold verify against the number of opens in flight (fresh tree each):

| Opens in flight | Cold verify | Defender CPU during it |
|---|---|---|
| 4 (shipped) | 86.3–87.7 s | 12–41 s |
| 8 | 46.4–46.5 s | 16–31 s |
| 16 | 26.1–26.7 s (6 runs) | 13–31 s |
| 32 | 19.3 s | 122 s |
| 64 | 19.2 s | 452 s |

The median open wait rises only from 4.7 ms to 5.4 ms between 4 and 16 in flight, so the scans run
in parallel and the pass is latency-bound. Past 32, Defender burns cores without finishing sooner.
Hence 16.

Other findings:

- Largest-first ordering did not help at 16 in flight (26.7 s).
- Skipping the read-back would not make the cost disappear. On a cold tree the engine's import probe
  took 10.9 s against 3.0 s warm, because Python opens files one at a time.

## Low I/O priority

The in-app runs above were about 2.3 times slower than this harness for the same step (193–203 s
against 86–88 s). The hc-906 acceptance started APEX through a scheduled task (`apex-acc`, created
with `schtasks`). Task Scheduler's default task priority, 7, starts the action at
BELOW_NORMAL_PRIORITY_CLASS with IoPriorityLow and MEMORY_PRIORITY_LOW (Microsoft's Task Scheduler
schema, Priority element), and on win-5090 a child spawned through Node keeps its parent's low I/O
priority and priority class. The verifier at each priority, fresh tree each:

| CPU priority class | I/O priority | Opens in flight | Cold verify |
|---|---|---|---|
| Normal | Normal | 4 | 87.1 s |
| Below normal | Normal | 4 | 89.2 s |
| Normal | Low | 4 | 192.7 s |
| Below normal | Low | 4 | 187.4 s |
| Below normal | Low | 16 (this change) | 195.2 s |

Low I/O priority alone accounts for the gap. At low I/O priority the opens do not overlap, so this
change does not help there. No Desktop launch path uses Task Scheduler or lowers its own priority:
a user starting APEX from the Start menu, a shortcut, the installer or the updater gets the
launcher's normal I/O priority (Explorer reads Normal on win-5090). An acceptance run that times
first boot should start the app with task priority 4–6 or from Explorer; at the default 7 it
measures about 190 s with or without this change.

## Change

- `scripts/build-runtime-bundle.mjs`: the verifier keeps `VERIFY_READS_IN_FLIGHT = 16` reads in
  flight (was 8). Its own `smoke` spawns `verify` with `UV_THREADPOOL_SIZE=16`.
- `apps/desktop/electron/apex-bundle-tool.ts`: `runBundledTool` moved out of `main.ts` unchanged,
  except that it spawns the tool with `UV_THREADPOOL_SIZE=16`.
- `apps/desktop/scripts/bundled-runtime-consumer-smoke.mts`: the same environment, so the consumer
  smoke runs the verify the way Desktop does.

What is checked is unchanged: the authenticated index, every size, the SHA-256 of every byte read back
from disk, and links, in both the staging and the final-path verify.

The verifier is the engine's own copy, so the 16-loop part takes effect once Desktop pins an engine
built from a commit that contains it. A new Desktop with an older engine gets 8 in flight (46 s); an
older Desktop with the new engine stays at 4 (88 s).

## Before and after on win-5090

Interleaved series with `bundle-verify-bench.mjs`, fresh tree each:

| Spawn | Verifier | Cold verify | Warm |
|---|---|---|---|
| Default environment (today) | 0.17.58 engine's own | 87.29 / 87.47 / 87.50 s | 2.43–2.44 s |
| `UV_THREADPOOL_SIZE=16` (this change) | this change | 26.34 / 26.10 / 26.19 s | 2.53–2.55 s |
| `UV_THREADPOOL_SIZE=16` | 0.17.58 engine's own | 46.41 s | 2.54 s |
| Default environment | this change | 88.05 s | 2.49 s |

The first verify drops from about 87 s to about 26 s, so engine preparation is about 61 s shorter on
this host. The every-boot `verify-current` is a warm pass and stays near 2.5 s.

Reproduce, from a directory holding the engine archive and its `.manifest.json`:

```
node bundle-verify-bench.mjs --archive runtime-bundle-<key>-win-x64.tar.gz --work <dir on C:> --threads default,16
node bundle-verify-bench.mjs --archive ... --work ... --threads 16 --verifier <checkout>\scripts\build-runtime-bundle.mjs
node bundle-verify-bench.mjs --archive ... --work ... --pass open    (or stat, read, hash)
```

## Verify call sites

Desktop, all through the injected `runTool`, which `main.ts` wires to `runBundledTool` twice (the
packaged first-boot gate and the online runtime update):

- `apex-bundle-install.ts` `verify` (staging, the cold one), `verify-final` (final path), and
  `verify-final` (repair of an unmarked final tree).
- `packaged-runtime.ts` `verify-current` (every boot, warm) and `verify-final-boot` (committed reuse).

Outside Desktop:

- `build-runtime-bundle.mjs` `smoke` (CI, `desktop-bundle.yml`): changed to the same environment.
- `bundled-runtime-consumer-smoke.mts`: changed to the same environment.
- `runtime-bundle-verify.test.ts` calls `verifyBundle` in process, where the pool size does not matter.

## Options

| Option | Integrity | Decision |
|---|---|---|
| 16 reads in flight (this change) | Unchanged | Done |
| Hash from the archive stream while extracting, no read-back | Weaker: no longer reads back what is on disk, so a write fault or a same-size modification after extraction goes unseen. Needs an in-process extractor instead of `tar.exe`. Part of the cost moves to the first engine start (probe 10.9 s cold vs 3.0 s warm) | Not done |
| Verify while `tar` is still extracting | Unchanged | Not done: extraction is 17–29 s, the most it could hide, for a streaming design |
| Ship fewer files | Unchanged | Separate ticket: about 12,000 of 67,600 entries look unused at runtime (`tests/` 6,170, `apps/` 3,399, `contributors/` 2,000, `website/` 838, dev-only `node_modules`) |
| Raise the verifier's I/O priority when Desktop itself was started at low priority | Unchanged | Not done: needs an undocumented NT call, overrides a priority the user or an admin chose, and no Desktop launch path starts at low priority |
| Skip the verify, or add antivirus exclusions | Drops the check or changes a security setting | Rejected |

## Verification

- `apex-bundle-tool.test.ts` drives the real `runBundledTool` and the real verifier against a bundle
  of named pipes. Each pipe's `open()` blocks until a writer appears, so the test counts the opens in
  flight: 16.
- `runtime-bundle-verify.test.ts` adds 100 entries against 16 loops: every entry checked once and
  each mismatch reported.
- `windows-child-process.test.ts` keeps the hc-537 hidden-console guard on the moved spawn.
- Reverse checks, each injection asserting its anchor matched once and each file restored byte for
  byte: no pool environment (observed 4 in flight), pool 8 (8), verifier at 8 like the 0.17.58 engine
  (8), verifier fixed at 4 (4), a shared-cursor race and an always-true digest comparison (integrity
  tests red), and the spawn without `hiddenWindowsChildOptions` (guard red). The control stayed green.
- Electron suite, typecheck, changed-file lint, release gates and `scripts/check` pass.

## Boundaries

- Not run inside the packaged app. The in-app before/after needs a candidate whose engine includes
  this verifier, started at normal I/O priority (task priority 4–6, or from Explorer); compare the
  `[bundle-install] verify` timestamps.
- Low-core hardware was not measured. On this host Defender used 13–31 s of CPU during the 26 s
  verify at 16 in flight.
- The pipe test runs on macOS and Linux; Windows has no `mkfifo`, so it is skipped there.
- Mac uses the same 16 reads; its first verify was already about 1.3 s and was not re-measured.
