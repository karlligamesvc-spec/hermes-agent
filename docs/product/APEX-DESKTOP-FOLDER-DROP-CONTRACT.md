# hc-906: Desktop home folder drop

## Behavior

On the connected, idle business home, dropping a native folder stages a visible
folder attachment. Sending the business request includes the directory reference
through the existing composer submission path. Chinese names, spaces and nested
directories preserve the exact local path. Dropping mixed files and folders uses
the existing attachment pipeline once.

The home has its own textarea while the rich chat composer is hidden. Therefore
the parent drop zone must be enabled for this home, and its drops must go to the
shared attachment draft rather than inserting references into the hidden editor.
Disconnected or busy home surfaces do not accept drops.

## Entry-point inventory

| Entry | Disposition |
| --- | --- |
| Business home, parent chat drop region | Fixed: enabled when connected and idle; stages visible attachments |
| Workflow Run / Project drawer over the business home (chat composer visible) | Existing inline-reference / attachment routing preserved |
| Normal chat, parent region | Existing inline-reference / attachment routing preserved |
| Rich composer input and form | Existing drop handling preserved |
| Message edit composer | Existing drop handling preserved |
| Native file/folder picker | Existing attachment path reused; unchanged |
| Bot group composer | Separate image attachment surface; unchanged |

## Verification

Run from `apps/desktop` after installing workspace dependencies at the root:

```sh
npx vitest run src/app/chat/index.test.tsx src/app/chat/hooks/use-composer-actions.test.ts src/app/business-workspace/business-workspace.test.tsx
npm run typecheck
npm run typecheck:e2e
npm run lint
npm run build
# Set HERMES_DESKTOP_PYTHON to a prepared runtime Python when needed.
npx playwright test e2e/folder-drop.spec.ts --reporter=list
```

Verified on macOS: 101 unit tests, type checks, lint, build and one Electron E2E.
The E2E uses native Chromium drag events with a real directory containing 60
video-named fixtures and a nested directory. It checks the visible attachment card
and the exact full folder path in the request received by the mock model endpoint
through the real Python backend. It does not mock native path extraction.

Before the fix, the same native drop produced a valid File/path but no attachment
card. Two independent negative checks also make the ready-home regression fail:
restore `enabled: showChatBar`, or remove the home-specific attachment dispatch.
Each mutation asserts a unique source anchor and verifies that it was applied;
the source is restored after each check.

### 2026-10-17: after rebasing onto Hermes v0.22.2 + Desktop 0.17.58

The routing lives in `src/app/chat/hooks/use-chat-file-drops.ts` and the enable
rule is `shouldAcceptFileDrops` in `src/app/chat/intro-visibility.ts`. They moved
out of `ChatViewContent` to stay within the code-health ratchet. The home branch
applies only while the rich composer is hidden, so a drawer over the home keeps
the normal routing. Add these to the unit run above:
`src/app/chat/intro-visibility.test.ts src/app/chat/hooks/use-chat-file-drops.test.tsx`.
The E2E needs `HERMES_DESKTOP_PYTHON` set to a Python that can import the v0.22
backend: the macOS system Python 3.9 cannot. Negative checks now also cover the
idle and connected gates, the hook ignoring the rule, the component not passing
the home state, and the drawer taking the home branch. Each check turns its case
red.

## Failure states and limits

The tests catch a disabled home drop zone, routing into the hidden rich composer,
loss of the directory path before model dispatch, and accepting drops on a busy
or disconnected home. The fixtures are not playable video; this does not validate
decoding, transcription or editing. Native Windows drag behavior and packaged
installer behavior are not covered by this macOS E2E. Remote directory transfer
is outside this change: local folders remain references, not recursive uploads.

## 2026-11-09 hc-1207: folders outside the working directory

### What was wrong

The E2E above asserted that the folder's path appeared in the request. The
engine's refusal line (`@folder:<path>: path is outside the allowed workspace`)
contains the path too, so the check passed while the agent never got the
folder: it sat outside the session's working directory (for an assistant, its
profile home) and nothing admitted it. The same refusal hit + 添加文件夹, a
folder dropped or pasted into the chat composer, and the edit composer. Files
were not affected: `file.attach` already copies them into `attachments/`.

### Behavior

- A folder the user hands over (the native open dialog, a Finder drop, a
  Finder paste) becomes a folder attachment, in the chat composer too, where it
  used to become an inline `@folder:` chip. At send, a folder outside the
  working directory is granted to that session and the engine expands it to its
  📁 listing. A folder inside the working directory is sent as before.
- A reference the user types or takes from the @ completions is text: it gets
  no grant, and outside the working directory the engine still refuses it.

### Trust boundary

- Desktop main holds one random key per app launch
  (`HERMES_DESKTOP_REFERENCE_GRANT_KEY`), given only to the engines it spawns
  for chats (the primary engine and pooled assistant engines; the IM messaging
  gateway gets none). It is never written to disk, and the engine strips it from
  agent subprocesses (`tools/environments/local_env_policy.py`, both lists).
- Main signs (HMAC-SHA256 over `apexnodes-desktop-folder-grant:v1`, NUL, the
  path) only a path a trusted source handed over during this launch: its own
  open dialog's answer, or the path preload reads with `webUtils.getPathForFile`
  from a real dropped or pasted File. The renderer may ask about any path and
  gets a signature only for those (`electron/apex-reference-grants.ts`).
- Drop and paste paths are reported by the renderer process (its preload).
  Script in the page cannot name one (contextIsolation, and a File built in the
  page has no path), and a `<webview>` guest is ignored. Code that took over the
  renderer process itself could note a path; such code can already drive the
  engine over its WebSocket.
- The engine (`apex_overlay/folder_grants.py`, RPC `folder.attach`) checks the
  signature, resolves the folder (symlinks first), and refuses a whole disk, the
  home folder or an ancestor of it, APEX's data folder or an ancestor of it, and
  anything the reference deny-list refuses (`~/.ssh`, credential files, Hermes
  internals). It records the folder on that session's dict only, so the grant
  ends with the session, a new thread starts with none, and nothing persists.
- Only Desktop turns see a session's grants, as one more allowed root for
  `_resolve_path` while `_prepare_turn_input` runs. Every reference is still
  resolved before the is-under check, and the credential deny-list still runs on
  each one. IM turns (`gateway/run_inbound.py`) and the CLI never see grants.
- Within the session, a reference that points inside a granted folder resolves,
  typed or not: the grant is the folder. Outside every granted folder nothing
  changed.

### Entry inventory

| Entry | Disposition |
| --- | --- |
| + 添加文件夹 (native open dialog) | Fixed: main records the answer; the folder chip is granted at send |
| + 添加文件或视频 (native open dialog) | Already worked (`file.attach` copies into `attachments/`); unchanged |
| Finder folder dropped on the chat composer or the chat region | Fixed: a folder attachment, granted at send (was an inline `@folder:` chip, refused) |
| Finder folder pasted into the composer, or onto the page (paste-to-focus) | Fixed: taken as a drop |
| Folders and files dropped together | Fixed: each its own way (folder granted, file copied) |
| Business Start page drop and paste (hc-906, hc-1159) | Fixed: its folder chips are granted at send |
| Edit-message composer drop | Fixed: the granted ref is inserted; without a grant, the inline ref it always got |
| Session tile composer | Fixed: the same send-time grant |
| `@` completions and typed `@file:` / `@folder:` | Checked, unchanged: text, never granted |
| In-app drag (project tree, gutter) | Checked, unchanged: inline ref; no real File, so never signed |
| Remote gateway, container terminal backend, Windows host with a WSL/Docker backend | Checked, unchanged: that backend cannot see this machine's path, so no grant is asked |
| Bot group composer | Checked, unchanged: uploads image/PDF/file bytes only, no folders |
| IM messaging gateway spawn | Checked: deliberately given no key |
| Windows paths | Same code path; the signature covers the exact path string (a test vector pins a Windows path on both signers). Not run on Windows |

### Verification

```sh
# engine (fork root, Python 3.14 venv)
scripts/run_tests.sh tests/apex_overlay/test_folder_grants_seam.py tests/apex_overlay/test_discovery_import_deadlock.py
# Desktop (apps/desktop)
npx vitest run electron/apex-reference-grants.test.ts electron/apex-profile-wiring.test.ts
npx vitest run --project ui src/app/session/hooks/use-prompt-actions/folder-grants.test.tsx \
  src/app/chat/session-tile-attachments.test.tsx src/components/assistant-ui/thread/user-edit-composer-folder.test.tsx \
  src/app/chat/hooks/use-composer-actions.test.ts src/app/chat/composer/paste-files.test.tsx \
  src/app/chat/hooks/use-chat-file-drops-paste.test.tsx src/app/chat/index.test.tsx
npm run build
HERMES_DESKTOP_PYTHON=<prepared runtime Python> npx playwright test e2e/folder-drop.spec.ts e2e/folder-grants.spec.ts
```

The folder-drop E2E now asserts the engine's 📁 listing (clips, the nested
folder) and the absence of the refusal; on fork main 9f44bfc65a it fails.
`e2e/folder-grants.spec.ts` covers 添加文件夹, 添加文件或视频 (an .xlsx), a
folder dropped on the composer, a folder and a file dropped together, a Finder
paste, a typed outside reference (still refused) and a second assistant on its
own engine.

### Failure states and limits

The tests catch: a grant that never reaches the turn, one that leaks to other
sessions or to IM turns, an unsigned or mis-signed folder, a folder signed that
no trusted source handed over, a too-broad or credential folder, a symlink
checked before it is resolved, the key reaching an agent subprocess or the IM
gateway, a pooled or primary engine without the key, a folder chip skipped at
send (main composer, tile, edit composer), and a typed reference sent for a
grant. They cannot catch a real native dialog panel (E2E answers it from main,
through main's own handler) or Windows native drag and paste (not run on
Windows). The E2E runs dev Electron, not the packaged app. Since hc-1210
(#604) a file picked into a chat that already has a session is staged once,
and the E2E asserts exactly `作品列表.xlsx`.
