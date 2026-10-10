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

## Failure states and limits

The tests catch a disabled home drop zone, routing into the hidden rich composer,
loss of the directory path before model dispatch, and accepting drops on a busy
or disconnected home. The fixtures are not playable video; this does not validate
decoding, transcription or editing. Native Windows drag behavior and packaged
installer behavior are not covered by this macOS E2E. Remote directory transfer
is outside this change: local folders remain references, not recursive uploads.
