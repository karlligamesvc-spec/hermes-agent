# OpenFilm toolkit (hc-1175, hc-1176)

APEX opens an agent's `film.html` in OpenFilm Studio (prototype hc-1173). The toolkit Studio runs from is:

- the pinned upstream package (`pin.json`, MIT),
- the patches in `patches/`, applied when the toolkit is built,
- its pinned dependencies beside it,
- `apex-toolkit.json`, which names what went in.

Upgrading means changing the versions in `pin.json` and checking each patch still applies and still passes. A patch
goes away once upstream ships the same fix.

## Patches

- **0001-keep-track-fields.** In openfilm 0.3.0, once the person edits anything in Studio, the next time the agent
  writes `film.html` Studio's keep-the-person's-edits merge (`studio/server/person-merge.mjs`) drops every caption
  track. It can also drop a track's `attrs`, a caption track's flags, and a person's change to them.
  - Cause: kept versions held only each track's clips and its three flags, the merge kept only tracks that have clips,
    and tracks were told apart by their clips, which a caption track does not have.
  - Fix: the merge keeps every track field, taken from `film-doc.mjs`'s `TRACK_FIELDS` (now exported), and merges
    each three ways the way flags already were. A caption track is named by its WebVTT file wherever a clip is named
    by its id. Clips merge as before.
- **0002-host-chromium.** Every headless browser OpenFilm starts is the one `OPENFILM_CHROMIUM` names. APEX sets it to
  the agent browser's Chromium. A missing one fails to launch; OpenFilm does not download Playwright's in its place.
  - On a Mac that browser is Chrome for Testing 153. Rendering 3 s of a real project with it and with Playwright's
    headless shell 149 gave frames with SSIM ≥ 0.985, the difference looking like encoder noise.
  - On Windows it is the headless shell 152 that Hypit renders with.
- **0003-hosted-studio.** With `OPENFILM_HOSTED=1`, OpenFilm's CLI never starts, restarts or replaces a Studio. It
  uses the one that is running, or carries on without one, as `look` and `render` already can.
  - Why: in APEX, Desktop runs Studio and stops it when APEX quits. Without the patch, an agent's `openfilm look` or
    `render` on a project Desktop has not opened starts a detached Studio of its own, which nothing stops.
  - APEX sets `OPENFILM_HOSTED=1` for every `openfilm` the agent runs.

## Checking and building

```
python scripts/media-tools/openfilm/build_toolkit.py [--check] <empty work folder>
```

`build_toolkit.py` runs `verify.mjs`, which does the following:

1. Fetches the pinned package and its dependencies (each checked against its npm integrity) and the upstream source at
   the pinned commit.
2. Checks that the files a patch touches are the same in the package and the source.
3. Applies the patches to both.
4. Runs these checks:
   - The guards (`pin.json` `guards`). `track-fields.test.mjs` takes every field of `TRACK_FIELDS` but `clips` through
     these cases: "the person edits, the agent writes over it", "the agent changes it", "the person changes it", "the
     merge fails", and more. It needs a sample for each field, so a field added upstream fails it until covered.
     `chromium.test.mjs` pins patch 0002, `hosted-studio.test.mjs` patch 0003.
   - `reverse-verify.mjs`, which takes each of the 14 parts of the patches back out of a copy, one at a time. The text
     must be found exactly once, and each removal must turn a guard red.
   - Upstream's own tests of what the patches touch (`upstreamTests`), with no browsers.

`build_toolkit.py` then packs exactly the files it verified into `openfilm-toolkit.tgz`. The same inputs always give
the same bytes. It prints the `openfilm` entry for `../desktop-lock.json`. With `--check` it fails unless that entry is
already the locked one.

`.github/workflows/openfilm-patch.yml` runs `build_toolkit.py --check` on every pull request and `main` push that
touches this folder or `desktop-lock.json`, and on no other.

Locally, behind the CN proxy:

- set `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=…` for the downloads;
- pass git a proxy through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0`.

## Publishing and installing

`publish_toolkit.py <openfilm-toolkit.tgz>` uploads the archive to the immutable APEX COS key the lock names, and
only if its size and SHA-256 equal the lock. It then reads the archive back over HTTPS. It needs the COS credentials
from the server environment. Ask before publishing.

`python -m apex_overlay.media_tools openfilm` installs the toolkit. Desktop starts it in the background the first time
an agent works on a video.

1. It downloads the locked archive from APEX COS, checks it, and unpacks it into
   `HERMES_HOME/tool-cache/openfilm/<sha256>/`.
2. It makes sure the agent browser's Chromium is there.
3. It writes `tool-cache/openfilm/ready.json`, which names both.

Desktop reads only `ready.json`.

## The agent side (hc-1177)

The engine's bundled Node puts `openfilm` on the agent's PATH (`scripts/runtime-node-shims.mjs`). The command is
`apex_overlay/openfilm_cli.mjs`. It is off unless the editor is open to this account (see below). When on,
it installs the toolkit if needed (`python -m apex_overlay.film_project env`, which uses `ensure_openfilm`), then runs
OpenFilm's own CLI unchanged with:

- the same `OPENFILM_HOME` and other folders as Desktop's editor, so `openfilm look` finds that Studio and reports
  the person's edits;
- `OPENFILM_NO_BROWSER=1`;
- `OPENFILM_HOSTED=1` (patch 0003): it uses Desktop's Studio, or carries on without one, and never starts its own;
- the agent browser's Chromium;
- APEX's ffmpeg first on PATH.

No Studio outlives APEX, whoever started it:

- Desktop's own runs as its child and stops when APEX quits.
- Desktop also puts the folders, `OPENFILM_HOSTED=1` and `OPENFILM_NO_BROWSER=1` in main's
  environment, which every engine started after it inherits. Any other OpenFilm the engine runs then works in
  APEX's folders.
- Before Desktop starts its own Studio, it reads `run.json` there. A Studio named in it that is not Desktop's is
  asked to quit (`/api/quit` with its key), and ended if it does not go. Desktop does not take it over: it was
  started with another environment, and OpenFilm's CLI may replace it. Another app's own Studio (it answers 423) is
  left to that app.
- When APEX quits, any other Studio in APEX's folders is ended too, even if no film was ever opened. This covers the
  one `run.json` names and any that would not quit earlier.
  - Ending one: only while its command line still names OpenFilm, so a process that took a gone Studio's pid is
    never touched.
  - macOS and Linux: SIGTERM, which Studio's supervisor passes on, then SIGKILL five seconds later from a shell
    that outlives APEX.
  - Windows: `taskkill /T /F` on the whole tree. A signal there ends one process, and the supervisor would start
    Studio again.

`python -m apex_overlay.film_project` is what the edit skill runs around a `film.html` the person may change:

- `diff <project>` lists what changed since the agent's last write: caption text cue by cue, clips added, removed or
  split, overrides, caption tracks and track flags. `openfilm look` does not report caption text or splits.
- `write <project> <draft>` writes `film.html`, waits for the editor to merge it, then checks that every caption
  track and clip the agent wrote, and every one the person added, is still there. It reads `film.html` with its own
  parser and does not use OpenFilm's merge. A loss exits with code 1 and leaves the agent's copy as it was.

## Who gets the editor (hc-1178)

Only accounts the Scheduler opens it to: the entitlement `openfilm_editor` in apex-nodes, off on every plan and turned
on per user with an admin override, for internal accounts. There is no install switch and no `desktop_features` key.

- **Desktop's main process** (`openfilm-studio.ts`) asks `openfilm.enabled` on the Scheduler's `/tools/v1/check`,
  with the signed-in account's APEX key, and keeps the answer for a minute.
  - Another account (or key) asks afresh. Signed out is no.
  - An answer that cannot be read keeps that account's last one, so a network blip does not take the editor away
    mid-edit. With no earlier answer it is no.
  - While the answer is no:
    - a film.html opens as a page;
    - no toolkit is installed;
    - the window starts nothing.
  - The window asks again whenever an agent starts a tool, so a sign-in after the window opened counts too.
- **The engine** (`film_project`, and through it the agent's `openfilm`) asks the same check with its own
  `TOOLS_GATEWAY_KEY` on every command. It keeps nothing.
- **Skill sync.** Desktop always sends `caps=openfilm`. The Scheduler includes the `film-edit` skill only for an
  account with the entitlement.
- **Even when the account has no editor**, the quit sweep and the hosted environment above still apply: no Studio
  outlives APEX.

