# hc-906 — realtime voice entry acceptance

The 0.17.46 Start page had its own BusinessGoalLauncher, without a voice entry,
and omitted the ChatBar that owns the actual microphone/voice engine. The chat
composer also replaced the voice primary with Send whenever a draft was present.

Start and the ordinary chat composer now keep a dedicated circular microphone
button with no engine dropdown or model/vendor label. Desktop selects native
Qwen internally (Flash is the Runtime default), regardless of saved CLI
chained/GPT preferences. Voice settings and the compact voice menu omit realtime
engine/model fields. Dictation, read-aloud settings and text-model choice retain
their separate behavior.

Main calls use a compact floating panel above the conversation: voice settings,
expandable native user/assistant transcript, mute and a red hangup button. Actual
transport callbacks feed the transcript; same-turn deltas join, distinct turns
remain separate and the in-memory fragment tail is bounded. The panel is a portal,
so hiding Start's controller chrome cannot hide the call controls. HUD windows and
session tiles retain the original compact in-window controls instead of a panel
that could land outside their viewport. Dragging the avatar/title handle moves
this panel with pointer capture; the position is clamped inside the viewport,
including after resize or subtitle expansion. Release/cancellation stops movement.
Arrow keys provide an accessible move alternative. Settings, subtitles, mute and
hangup are outside the drag handle.

The existing one-shot voice request mounts the sole main composer behind Start.
That component remains mounted when a delegated voice task creates chat history
or opens settings/task pages. Starting does not submit the typed Start draft.
Activation awaits the owning profile’s Qwen admission before enabling native audio; pending
starts expose a connecting panel and hangup/unmount invalidates their epoch. A
scope-lost status returns null and cannot open audio on the replacement account.
The actual live hook constructs Qwen directly before opening a microphone; it
does not consult an old engine preference. Unavailable admission leaves audio
closed and shows a generic realtime-voice notice, without switching to chained or
GPT. No supplier, billing, permission or auth path is forked.

## Verification

From `apps/desktop`:

```sh
npx vitest run --project ui src/app/chat/composer/voice-entry.test.tsx src/app/chat/composer/hooks/use-composer-voice-start.test.tsx src/app/chat/composer/hooks/use-voice-live-native.test.tsx src/app/settings/voice-field-visible.test.ts src/app/chat/index.test.tsx src/app/chat/composer/controls.test.tsx
npm run test:ui
npm run typecheck
npm run lint
npm run build
```

The full UI suite passed 9,006 tests across 944 files with four workers.
Typecheck passed; lint reports 0 errors and 303 existing warnings. A subsequent
muted-icon resource fix uses the real MicOff icon in both floating and compact
controls; 39 focused tests, typecheck and lint passed again.

The entry/UI regression uses real components and the actual native hook, with
controlled transports and scope-aware admission. It also proves existing GPT
preferences cannot select GPT, unavailable Qwen never opens chained audio, and
legacy engine/model settings cannot mount in the curated Voice page. Reverse checks assert a
unique executable anchor before each mutation: remove Start's microphone → the
home click test fails; remove main-controller retention → the real ChatView
handoff test fails; remove pending-start cancellation → the cancelled-start test
fails. Additional reverse checks replace the native constructor with the legacy GPT
transport → the actual-hook test fails, and remove the pointer-move handler →
the drag/bounds test fails. Each source file is restored in `finally`.

Browser visual inspection uses the actual launcher/panel with an explicitly
labelled simulated call, checking actual pointer dragging, subtitle expansion, mute and hangup. It does
not verify a physical microphone, audio quality or a live Hermes task. The public
0.17.46 package does not contain this subsequent fix; delivery still requires the
paired Mac/Windows release workflow and three public manifest readbacks.

## Local packaged trial: public-edge client identity

The Mac trial exposed a second blocker after the user signed in: Qwen was greyed
out because its status request inherited urllib's generic Python User-Agent.
The actual public Cloudflare edge returned a non-JSON HTTP 403; the same profile
credential and model with an explicit APEX Desktop identity returned HTTP 200
and `available: true`. No credential or quota was changed.

Both Runtime exits now identify the first-party client as `APEX-Desktop/1`:
the HTTP status request and the Relay WebSocket handshake. Auth remains the
same profile-local Bearer credential. The HTTP regression reproduces rejection
of the generic identity; the existing actual WebSocket transport test checks
the handshake option alongside profile auth and real native tool-result flow.
Run `scripts/run_tests.sh tests/hermes_cli/test_qwen_realtime.py` and the existing
native-voice smoke above. Removing either client-identity option must make its
corresponding regression fail. Public-edge readback proves admission only;
physical microphone/audio and a live task still require user acceptance.

## Menu navigation regression

The trial revealed that the route table still mounted ChatView only for chat
routes. A portal escapes CSS clipping, but cannot survive its owner unmounting.
The workspace now keeps one primary ChatView outside the route switch, hiding
only its page chrome on full-page destinations. Once the main ChatBar has mounted,
it stays mounted when Start hides the normal editor, even if voice originally
started in an ordinary chat without a home-launcher request.

The route registry remains the visibility authority, including contributed pages
and Project/Run/Deliverable background locations. Route overlays trap focus and
pointer input; a feature-local portal host follows the active route overlay so
mute/hangup remain inside its interaction boundary. The panel retains its moved
position, subtitles and state while its portal content moves; the Qwen owner
and transport do not move or reconnect. It uses the shared over-modal layer.
HUD/session tiles keep their existing compact controls. The retired unreferenced
DesktopController route table is not the shipping renderer.

The route regression uses the real route table, real Qwen hook and floating
panel, with a controlled transport. It checks one constructor/start and no close
across full-page menus, Start/chat, settings and all three route drawer kinds;
settings mute/hangup still work and panel position/subtitle expansion survive.
The ChatView regression separately checks the real main-composer mounting seam
for ordinary chat → Start/drawer. Reverse mutations remove route retention,
composer retention, or modal portal placement; each corresponding test must fail.
The preview is explicitly simulated: physical microphone and paid/live audio are
still user acceptance, not claimed by these lifecycle tests.

The menu fix passed the complete UI suite: 9,008 tests in 944 files,
plus 66 focused route/owner/identity tests, typecheck and lint (0 errors,
303 existing warnings). The old literal unmount guard was removed; actual
ChatView behavior still verifies the initial Start editor and retained call owner.
Radix delayed focus cleanup completes before the test DOM is disposed.
A real wide-screen drawer preview retained the exact viewport position and
allowed hangup outside the drawer edge; the host had no retained transform.
No microphone was opened by this simulated preview.

## Interrupted utterance / response collision regression

The user's trial returned the exact VAD message `Server VAD turn committed but no
response was created because a manual response is already in progress.` followed
by `voice_error`. The native client treated every error except an idle cancel as
fatal, while tool completion sent `response.create` even during an existing
response or before a previous create had been acknowledged.

Tool output items still reach the same conversation immediately. Their response
request is coalesced and sent only when no response is active/requested and the
user is not speaking. A terminal receipt releases the slot, including cancelled
receipts; duplicate terminal receipts cannot release a subsequent reservation.
Speech-stop leaves automatic creation to VAD. Late output from interrupted
responses remains discarded, and a response created during renewed speech is
cancelled. The observed VAD notification and the protocol's active-response
rejection retain capture and queue one follow-up after the active receipt.
Only identified response-state conflicts are recoverable; Relay admission/quota errors,
unknown errors, malformed events and transport failure still close the call.

The runtime's actual session.update now sets server_vad silence_duration_ms to
1500 (previously 700), allowing longer natural pauses at the cost of about 0.8s
more end-of-utterance latency. Model, voice, threshold, permissions and billing
are unchanged. Smart-turn support has not been proved on this provider route,
so no different detection mode is selected.

The actual transport tests drive tool/automatic/manual response ordering, the
acknowledgement gap, renewed speech, cancellation, duplicate receipts and the
exact trial notification, then verify resumed audio without closing capture.
Fatal-error rows verify capture/socket release for unavailable, failed, invalid
key and unknown errors. The Python transport test independently checks the
actual outgoing VAD object rather than using the config builder as its oracle.
Reverse injections remove response serialization, restore fatal VAD handling,
or restore the 700ms pause: each uniquely anchored mutation fails its behavior
regression and is restored. Physical speech quality is still user acceptance.

Protocol reference: https://docs.qwencloud.com/api-reference/qwen-audio-realtime/websocket-api
(automatic turns, function results and response.create state constraints).

The r5 collision fix passed 9,014 UI tests across 944 files, 29 focused native/
route/controller tests, all 19 Runtime voice smoke tests, typecheck and ruff.
Lint has 0 errors and the same 303 existing warnings. All three collision/pause
reverse injections failed their intended behavioral assertions; restoring the
Runtime source passed its eight tests again. Local diagnostics use this checkout;
the public runtime pin must include this VAD change before a paired release.

## Start / main-chat composer parity

The ordinary chat editor uses Start's shared `.apex-composer-surface` treatment:
15px radius, theme border and focus ring, 18px/10px padding, 48px minimum writing
area and 14px/1.6 text. Start's page stylesheet owns only its page margin; input
geometry and surface paint have one owner. The main chat keeps its rich editor,
attachments/paste/drop, scene and approval controls rather than duplicating the
Start textarea. Its empty draft now shows both the black microphone and disabled
purple Send; a payload enables Send and a busy empty turn still exposes Stop.
Dictation, read-aloud and wake-word toggles remain available through the existing
voice menu, with a small settings glyph distinct from the realtime microphone.
The loading fallback shares the surface; HUD, session tiles and popped-out chat
retain their own compact controls and width ladder. Active native calls still use
the existing floating panel, independent of either toolbar.

Regression rows cover empty/draft/busy-empty/busy-draft, button order/type,
disabled Send, the independent microphone callback and all folded toggle entries.
Restoring the old empty-draft microphone replacement (one asserted executable
anchor) makes the empty-Send behavior test fail, then restoring source passes.
These tests do not prove native microphone quality or geometry in a real window;
the local packaged app is inspected separately before trial delivery.

The r6 parity change passes all 9,019 UI tests in 944 files, the 66 focused
identity/entry/controls tests, typecheck and lint (0 errors / 303 existing
warnings). The pre-existing literal focus-selector guard was updated to the
shared surface owner; the new regressions exercise rendered controls and callbacks.
The empty-Send reverse injection fails its intended behavior assertion and is
restored before the full green run.

## Late cancellation / separate dictation regression

The 2026-10-05 public APEX-route probe reproduced Qwen's exact idle cancellation
receipt: `invalid_value` / `Conversation has no active response.`. A cancellation
can arrive after a completed response, including during barge-in. The Desktop
previously recognized only `response_cancel_not_active`, then closed this call
with `voice_error`. Both observed idle-cancel receipts now retain capture; every
other `invalid_value` remains fatal. Transport regressions drive speech-start,
cancel, terminal receipt, late rejection and renewed audio.

The live hook retains the specific fatal error instead of adding a newer generic
`voice_error` notification that collapses it. Ended-session callbacks cannot
publish into a later call. Unexpected socket closure still notifies and ends
the owning call. Starting realtime cancels dictation and awaits a pending
microphone grant's release; dictation cannot start during realtime admission or
an active call. A cancelled dictation's delayed STT result cannot insert a draft,
steal focus or report no speech. The legacy no-speech warning originates from
dictation, not the native Qwen ASR stream.

Two synthetic-text canaries used the current trial identity through the actual
public Relay, without microphone capture or Hermes tool execution. Connection
readiness was 11.746s and 8.719s; plain spoken replies began in 1.333–2.276s.
The second canary deliberately sent an idle cancellation after round three and
completed round four with audio and a usage receipt. These are observed route
timings, not physical speech or all-task latency guarantees. The existing 1.5s
VAD silence wait and full Hermes task-result wait remain; no pricing, ledger,
admission or production service change is included in this local trial.

This follow-up passed 9,027 UI tests in 945 files, 26 focused transport/hook
tests, typecheck, 19 Runtime smoke tests and 332 Cloud authority/ledger/routing
tests. Three uniquely anchored reverse injections removed the exact idle-cancel
recovery, concrete-error retention and obsolete-dictation guard; each failed its
intended behavioral assertion, and every source file was restored afterward.

## Historical chats / caption chronology / initial disclosure

The 0.17.48 user trial rejected assistant startup history with
`assistant role only supports content type 'output_text', got 'text'.`
The Runtime now emits `input_text` for historical users and `output_text` for
historical assistants. Only user/assistant text is replayed; previous developer
instructions and tool messages do not replace the live persona or create fake
tool receipts. The outgoing transport regression independently verifies a mixed
history, multiple assistant parts and the subsequent real function output.

The Qwen client reserves a bounded turn sequence on speech-start (or audio commit)
and response creation, keyed by the native item/response ID. Delayed ASR uses the
reserved user turn rather than its completion time. The shared append operation
keeps equal-turn assistant deltas stable in both the displayed captions and the
context passed to Hermes; repeated user completion does not duplicate captions.
Legacy timestamped fragments retain their chronology. Cancelled response output,
response-slot serialization and call/profile isolation keep their existing gates.

The shared main-call panel opens captions on every new mount, including during
connection with no text yet. The subtitle button still collapses/reopens them;
status changes, new text and menu/settings navigation retain the user's choice.
HUD/session tiles keep their compact in-window controls.

Smoke from `apps/desktop`:

```sh
npx vitest run --project ui src/lib/qwen-realtime.test.ts src/app/chat/composer/hooks/use-voice-live-native.test.tsx src/app/chat/composer/voice-entry.test.tsx src/app/contrib/surfaces.test.tsx src/app/overlays/overlay-view.test.tsx
npm run test:ui -- --maxWorkers=4
npm run typecheck
npm run lint
npm run build
```

Runtime smoke: `scripts/run_tests.sh tests/hermes_cli/test_qwen_realtime.py`.
Four uniquely anchored and landed reverse mutations restore the invalid history
type, remove speech reservation, remove late-ASR insertion, or restore collapsed
captions. Each corresponding behavior test fails; all files are restored.

The source Runtime's actual `serve` path accepted synthetic user/assistant
history through the public APEX Relay on Flash and Plus, retained the historical
test phrase and returned completed audio. A repeated connection was refused by
the existing single-call gate; no gate was bypassed. This does not verify a
physical microphone or guarantee service availability. Full UI assertions also
exposed an existing overlay-test teardown race: pending route/Radix focus restore
tasks outlived their jsdom realm. That fixture now drains its zero-delay cleanup
before disposal. The synchronized release must pin the corrected engine as well
as packaging the corrected renderer; a renderer-only update leaves the history
error intact.

This follow-up passes all 9,031 UI tests across 945 files, eight Runtime voice
tests, typecheck and build. Changed TypeScript files and the Python seam pass
lint/ruff; the full ESLint run retains the pre-existing warnings. The four
reverse injections fail their intended behavior assertions and restore source.

## Chinese history budget and publication follow-up

Before 0.17.49 finished publishing, a second historical-chat failure was
reproduced: the frontend permits 6,000 text characters, but Runtime counted
ASCII-escaped JSON characters. Five 1,200-character Chinese turns occupy 18,442
UTF-8 bytes and were incorrectly rejected as too long. The byte gate now measures
actual UTF-8 JSON. The 30,000-byte and 24-message limits remain enforced before
any upstream connection. A real transport regression replays all five full
turns; oversized bytes and excess messages still reject without contacting the
vendor. Restoring the escaped-character measurement makes the CJK smoke fail.

All three public feeds still read 0.17.48 when release run37464095256 was
cancelled; no default Runtime pointer had been advanced. Its signed 0.17.49
artifacts and native consumer proofs remain evidence, not a completed release.
The complete follow-up ships as 0.17.50 with a corrected embedded engine.

Both native publication exits use cos-python-sdk-v5 1.9.44 (MIT), the same
installed SDK that successfully published and independently verified the source
mirror on the server. The shared uploader uses 16 workers with 8 MiB parts,
bounded request timeout, MD5 transfer checks and independent public exact-size
HEAD verification. Credentials stay in environment variables and signed SDK
exception details are not emitted. Mac's actual workflow shell preserves
assets-before-feed and stops on a rejected asset; Windows retains its bounded
process/retry/remote-size/feed-reference coordinator. Paired source/version/
runtime/three-feed parity remains mandatory; manual single-platform dispatches
still cannot publish. No speed guarantee is claimed until the native run proves
this actual network path.

Additional smoke:

```sh
scripts/run_tests.sh tests/hermes_cli/test_qwen_realtime.py tests/test_desktop_cos_uploader.py
cd apps/desktop
node --test scripts/desktop-macos-workflow.test.cjs
npm run test:release-gates
```

Reverse injections restore escaped history measurement, remove served-size
verification or publish the Mac feed first. Each uniquely landed mutation makes
its behavior regression fail, then source is restored. SDK fixtures cover
truncation, foreign/mismatched object keys and credential-bearing exceptions;
the native production workflow, not these fixtures, proves real COS delivery.

## Delegated query result and voice contradiction

User acceptance on 0.17.48 showed a successful main-chat Douyin query while
the voice said it could not query. The matching persisted turn records
`social_trending` returning at 12.18 seconds and the final 19-item answer at
18.83 seconds. Those records prove the Hermes query succeeded; they do not
record the original realtime wire events. Source regression reproduces a
separate premature-completion path: idle/empty state after 15 seconds, or
after any observed busy interval, closed the voice tool without an answer.

Native delegation now waits for prompt acceptance and the actual reply. An
idle/empty cache is never a completion receipt. Submit rejection returns an
honest failure; a superseded submission cannot clear or speak into a newer
call. Interrupt settles before submitting the next request. The live selector
collects only the latest user turn rather than an older spoken cursor, so an
interrupted earlier reply cannot be mistaken for this tool's answer. Legacy
chained and automatic read-aloud selectors keep their existing cursor behavior.
If an accepted request never produces any text, voice remains pending until a
new request, explicit failure, user close or service close; no timeout invents
a result or a capability refusal.

Qwen playback and captions suppress assistant media while a tool is pending,
including late media from its original response after the result arrives.
VAD recovery cannot request another model response while Hermes is working.
The server persona tells the voice to use APEX's actual abilities and read the
returned prose with its sample/verification limits. A normal greeting and the
new response generated after the tool receipt still play. User ASR and newer
tool calls remain available during the wait.

Both Flash and Plus were tested through the actual modified Runtime `serve`
path and public APEX Relay: text input requested the hot list, the tool fixture
waited 19 seconds, and the completed audio/transcript reported 19 entries and
the fixture's sample limitation without denying query capability. This is a
synthetic fixture, not fresh market data or a physical microphone acceptance.
The repeated immediate Plus connection hit the existing single-call gate;
after that connection released, Plus passed without bypassing admission.

Additional smoke from `apps/desktop`:

```sh
npx vitest run --project ui src/lib/qwen-realtime.test.ts src/app/chat/composer/hooks/use-voice-live-native.test.tsx src/app/chat/composer/hooks/use-composer-voice-start.test.tsx src/app/chat/index.test.tsx
```

Six uniquely anchored reverse mutations restore empty-result completion,
premature assistant playback/captions, stale submit failure, discarded submit
acceptance, older-turn selection or a pending-tool response retry. Each must
fail its corresponding behavior assertion, then restore source. This change
also requires a newly pinned embedded engine for the updated server persona.

## Chinese spoken close without a delegated task

0.17.48 acceptance also showed “OK，你关闭吧。” answered with goodbye while
the panel stayed listening. The shared whole-utterance matcher recognized only
English phrases and ASCII punctuation. It now accepts explicit Simplified and
Traditional Chinese voice-end phrases and APEX/acknowledgement prefixes with
Chinese punctuation. Whole-utterance matching remains mandatory: “关闭浏览器”,
“停止下载”, “取消订单” and negated/question forms are real tasks. Typed commands
still pass through when voice is inactive or attachments accompany the text.

All five entry paths were inspected: native completed ASR, native delegation,
chained initial transcription, chained barge transcription and typed composer
interception. They share the same matcher. Native Qwen emits one complete user
ASR item; that item is judged immediately. It is not concatenated with another
user turn during a 1.5-second window. The stop callback closes the native session
and disables its owner, rather than treating the model's goodbye as a receipt.
Late ASR/delegation callbacks after closing cannot submit another chat turn.
Chained initial/barge tests exercise the existing teardown with the Chinese
request, alongside the native close/duplicate callback regression.

Smoke from `apps/desktop`:

```sh
npx vitest run --project ui src/lib/voice-stop-word.test.ts src/app/chat/composer/hooks/use-voice-live-native.test.tsx src/app/chat/composer/hooks/use-voice-conversation.test.tsx src/app/chat/composer/hooks/use-voice-conversation-rearm.test.tsx src/lib/qwen-realtime.test.ts src/app/chat/composer/voice-entry.test.tsx
```

Four reverse faults remove Chinese punctuation handling, remove the actual
native close, concatenate two distinct ASR turns or replace whole-utterance
matching with substring matching. Each uniquely landed fault must fail a
behavior assertion before restoring source. No server protocol/persona change
is needed here: the 0.17.50 embedded engine remains 40d4bee9. This does not claim
physical microphone or every possible ASR spelling acceptance.

## Single App notarization and 0.17.51 recovery

The paired 0.17.50 run37541633454 completed Windows publication and all three
native engine consumer proofs. Its first Mac attempt hit an Apple 30-minute
processing timeout (arm64) and CFNetwork -1001 (x64). The same-SHA retry accepted
both runtime payloads and passed fresh/F8/RPC/reopen/rollback/data checks. The
arm64 outer-App log then reported electron-builder's `notarization successful`
at 2026-10-07 00:02 UTC, followed by a second submission from the configured
`afterSign` hook. That duplicate failed with CFNetwork -1009 / no network route.
This is not a successful paired Desktop release: Windows feed advanced to
0.17.50, both Mac feeds remained 0.17.48 and Runtime default remained ba8e344e.
The incomplete run is cancelled before starting its replacement.

Production now explicitly enables electron-builder's built-in Mac notarization
and registers no second `afterSign` submitter. Native runtime-payload notarization
is a distinct required gate; the signed/notarized App and distribution DMG
checks remain required by the unchanged paired workflow. Standalone old CJS/MJS
helpers are not registered in production. Windows had no effective Mac hook and
keeps its existing native/PE/unsigned-installer checks.

The installed app-builder-lib helper and hook resolver/emitter are exercised
with a controlled Apple client: exactly one App request is made, no afterSign
handler is registered, and client rejection propagates. Restoring the old
structured afterSign field or disabling Mac notarization must make this guard
fail, with each mutation independently asserted before testing. This fixture
does not prove actual Apple service availability; the replacement native
release must still pass signed/notarized package and public-feed checks.

The complete replacement version is 0.17.51, so an already public Windows
0.17.50 installer is not silently replaced by different source under the same
filename/version. All platforms retain voice engine 40d4bee9 and pin minimum
Desktop 0.17.51; source tarball bytes are unchanged.

Smoke from `apps/desktop`:

```sh
node --test scripts/desktop-macos-workflow.test.cjs
npm run test:release-gates
```


## Same-day confirmed engine update and bounded continuation

The physical macOS update from0.17.48 to0.17.51 installed the new shell but retained
engineba8e344e. Both engine labels were from2026.10.6; the existing calendar-version comparator correctly treats them
as equal, but the package consumer did not honor the exact user-confirmed source. Offline
preparation repeatedly returned preserved, while the renderer retried the frozen
plan415 times before a lookup timed out with no_admin_latest_available. The
primary error was failure to apply the confirmed source, not proof that the public latest API was absent.

Automatic source ordering retains the existing calendar-version comparator.
A usable same-day or unknown engine remains intact by default. The existing
user-confirmed update override can authorize exactly the source present in the
verified package; an absent or mismatched confirmation does not override that
preservation. Archive, index, relocation, native architecture/import, idle-owner,
minimum-shell and post-switch rollback checks still run. The Electron boot owner
passes that confirmed source into its existing shared installation gate.

Automatic frozen-plan continuation runs at most once for that plan in a renderer
lifetime, including overlay remounts. A deliberate Retry may attempt again. This
prevents boot failures from turning into an unbounded request/install loop.

Behavior tests cover hash suffixes on both sides of the target, default/wrong-pin
preservation, confirmed activation, old-tree/user-state retention and bounded
automatic versus explicit retry. Both regressions were red on the old behavior.
The full native consumer additionally uses genuine F8 source with a synthetic
same-day ordering marker, then verifies preservation, explicit upgrade and real
injected rollback; this does not relabel F8's actual historical release date.

The local recovery used the notarized0.17.51 package's exact engine40d4bee9 through
the corrected transactional consumer. Its per-file verification, native import
probe and idle-owner check passed; config/credential/database hashes were unchanged,
the old tree remained available and the physical App restored gateway Ready plus
its existing conversations. This is one Mac arm64 recovery, not physical Windows
acceptance. A paired0.17.52 production replacement carries the installer fix;
publication and all three public/native readbacks are required before declaring it
published. Supplier cancelled-usage billing policy remains unchanged; native barge-in now avoids sending a cancellation.


## Unified primary voice ownership — 0.17.52 candidate

Every completed native ASR utterance now submits its original text to the current
APEX primary conversation. Greetings, unclear fragments, follow-ups and executable
requests use the same model, history, tools and approval flow. The primary's turn
note asks it to answer dialogue, clarify ambiguity and execute clear requests,
while preserving existing work unless the user asks to stop or replace it. This
is contextual model judgment, not a keyword classifier or a claim of perfect
intent recognition.

Qwen's current Flash and Plus servers ignore an attempted server_vad
create_response=false option and still infer automatically. The shipping protocol
instead sets turn_detection=null and tools=[] on the native server. Local PCM
boundaries retain 500ms onset audio, require 200ms sustained input, commit after
1500ms silence and cap one input at45s. These controls only decide an audio
boundary, never task intent. Commit performs ASR without requesting inference.
Only the accepted primary result adds readback text and explicitly requests audio.
Unsolicited/interrupted response media are suppressed. Barge-in immediately stops
local playback but lets supplier inference finish to its actual usage receipt; it
does not send response.cancel. The acknowledgement-gap flag also suppresses an
old response that is created only after the new speech has already ended. A late older ASR item updates
chronological captions without superseding or re-submitting newer intent. The
client requires a primary-owner readiness marker supplied by the pinned native
server, so a provider ack that omits null fields remains compatible; an old
automatic-response engine is refused before starting PCM capture.

Mid-task speech uses the existing primary redirect seam, which retains completed
work and reaches a running tool at its safe boundary. It does not press Stop.
A finish race falls back to ordinary submit; a real rejection remains a failure.
Explicit whole-utterance voice close still tears down the call before submission.
Uncommitted 100ms silence every30s keeps the provider audio channel alive during
long primary work; it never becomes a user message, completion or model request.
Captions retain the existing default-expanded main panel on Home and historical
chats, and retain deliberate collapse until a new call.

Both actual vendor models accepted the candidate's imported server configuration:
synthetic PCM committed to ASR without any automatic response, then both read the
exact supplied result “目前拿到部分样本，完整榜单尚未核对。” with completed audio and
usage. This is a controlled protocol canary, not physical microphone acceptance
or a real cloud-account/tool permission check. Deterministic transport/hook tests
cover the same original-text dispatch, returned result, 330s pending work, replay,
barge-in, stale ASR, scope change, close, malformed input and cleanup. Six uniquely
landed routing faults and three installer faults fail their behavioral regressions
before restoration. The earlier hash-order mutation correctly stayed green: the
old comparator already ignores suffixes; that redundant ordering change was removed.

The production Relay canary validates candidate native serve, ASR during readback,
normal completed usage and subsequent result speech on the isolated internal
probe Agent. A refused immediate second call was not bypassed: the canary waits
for the normal bounded hangup drain before opening the next model.

Runtime source: d4a31394f437a669ba0ff9ef6902ef22cecacbeb. Minimum shell:0.17.52.
The immutable source archive and synchronized three-platform build/publish proofs
are required before marking the candidate published. Both real Flash/Plus canaries committed a synthetic interjection while readback
was active, obtained the new ASR and a completed old response with full usage,
without sending cancellation. No estimated usage or user-credit waiver is needed
for this continuation fix. Explicit supplier cancellation/disconnection can still
omit usage; existing fail-closed credit policy remains in force. No pricing, quota, Relay or
Scheduler policy is silently changed by this Desktop release. Physical ASR in
noise, echo suppression, soft speech and real-task voice acceptance remain manual.

### Publication transport follow-up

Paired runs37568050308 and37572064546 passed all three native consumers and
both Mac payload/App notarization and Gatekeeper checks, but Mac installer COS
uploads failed with CosClientError. Both runs were cancelled; all five52 installer
objects still returned404 and all three public feeds remained51 after cancellation.
The shared Mac/Windows uploader now limits multipart concurrency to four, enables
the SDK's official-domain retry, prefers the verified Tencent tencentcos.cn route
and performs one bounded transport-only resume through the classic domain.
HTTPS, MD5, original public HEAD size and
binary-before-feed gates remain required. Service/auth errors and wrong public
sizes still fail; signed SDK error details are suppressed.

Twelve uploader tests pass. Removing either the backup route or transport resume
produces uniquely landed failing regressions before restoration. A real1.9.44 SDK
canary injected a primary-domain connection failure, uploaded a50-byte owned
synthetic object through the official backup domain, verified its anonymous full
body hash and deleted it. This proves domain failover, not large multipart
throughput from GitHub runners. A new synchronized production run and all public
readbacks are still required before marking52 published. Runtime source/minimum
shell and the application version remain unchanged because52 had no public files.
