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
