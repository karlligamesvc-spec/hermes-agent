# hc-901 Desktop video playback and source conversation

## Behavior

A supported video link stays visible under its imported transcript's title. The analysis workspace has the player and transcript on the left, and one ordered source conversation with one composer on the right. Import controls stay on the source hub. Cached summaries appear as conversation content; opening a video no longer automatically generates a model summary. More analysis contains evidence search, the existing deep draft action and saved reports.

Linked Douyin and Xiaohongshu sources can obtain a fresh playback URL through the existing authenticated `/api/v1/media/social-download` endpoint. Native code sends the managed key only to that API, then fetches bounded HTTPS media bytes without credentials. Playback incurs the existing media-download accounting. Bilibili's current resolver provides audio, so it cannot supply an in-app video; retry, original-site and local-pairing actions remain available. This does not add a scheduler endpoint or change server storage policy.

After a local video upload finishes ASR, its original selected file is immediately leased to the player for the current view. Saved transcripts never retain the selected native file path. Reopening an uploaded transcript after explicitly closing the workspace or restarting the app requires selecting the video again. Navigation that preserves the mounted workspace also preserves its active view lease. Linked originals can be fetched again. No model visual analysis is implied by playback.

## Ownership and lifetime

Native preview rereads the document through its authoritative local/cloud ownership seam, checks its revision and timed-video provenance, fences both HTTP legs to the signed-in account, and rechecks revision before returning. Only opaque `hermes-media://analysis/<random-token>.<extension>` URLs and a basename reach the renderer. The protocol serves byte ranges from a private lease; it never resolves arbitrary paths or uses remote-session authentication for this mode.

Changing source/account, explicitly returning to the hub, replacing playback or unmounting releases the previous URL. Late playback results are released. Window destruction and application quit attempt cleanup of view caches. Crashes can leave OS temporary files; the ordinary lifetime checks do not prove crash cleanup. Releasing a selected original never deletes the user's file.

Video follow-ups use at most six validated, current-revision answer pairs with a 12,000-character total bound. Prior turns clarify intent and are untrusted context, never evidence; all factual claims still require current extracted anchors. The operation stays on `llm.oneshot`, with no unrelated chat/session history. Answer storage rechecks owner/revision. Citations seek the current player and reveal the corresponding transcript; stale citations stay disabled. Typing the next question while an answer is pending does not discard that draft.

## Outlets

Checked: linked and uploaded videos; local and cloud transcripts; manual subtitle pairing; initial import, reopen, source change, return to hub, account change, late completion and window destruction; cached summaries and existing source answers; notes, frame capture and deep report/draft handoff; all five Desktop locales; narrow versus wide containers. PDF/Word/Excel/text/Feishu keep their existing reader and question actions. Mac/Windows use the same bridge and renderer. No public release is authorized or performed by this source fix.

## Smoke and limits

From `apps/desktop`:

- `npx vitest run electron/apex-analysis-playback.test.ts electron/media-protocol.test.ts electron/apex-analysis-video-upload.test.ts electron/apex-analysis-local.test.ts src/app/business-workspace/pages/analysis-video-flow.test.tsx src/app/business-workspace/pages/analysis-page.test.tsx src/app/business-workspace/source-question-answer.test.ts src/app/business-workspace/components/source-question-answer.test.tsx`
- `npm run typecheck && npm run lint`; `npx tsc -p tsconfig.e2e.json --noEmit`
- `npx vitest run --project ui --maxWorkers=4`
- `CSC_IDENTITY_AUTO_DISCOVERY=false npm run pack`
- `npx playwright test e2e/business-workspace-packaged.spec.ts -g 'hc-901 packaged video upload|hc-872 packaged' --workers=1 --reporter=list`

Native tests import the actual protocol/store, use real temporary files and a loopback media body, check byte ranges, window/account fences, late-account rejection and preservation of selected originals. UI tests cover carried links, one composer, automatic native pairing and stale source results. Packaged Mac arm64 tests use isolated HERMES_HOME/userData with the OS HOME preserved, a real synthetic VP8/WebM file, native multipart upload, native lease playback, model RPC/account HTTP fixtures, saved answers, seek and width measurements. They do not prove live social provider availability, real ASR quality, every codec, Windows hardware, production feeds or crash cleanup. Reverse-validation receipts and exact final checks belong in the PR.
