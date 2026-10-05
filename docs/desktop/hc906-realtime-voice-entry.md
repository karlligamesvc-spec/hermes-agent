# hc-906 — realtime voice entry acceptance

The 0.17.46 Start page had its own BusinessGoalLauncher, without a voice entry,
and omitted the ChatBar that owns the actual microphone/voice engine. The chat
composer also replaced the voice primary with Send whenever a draft was present.

Start and the ordinary chat composer now keep a dedicated circular microphone
button and the shared adjacent engine picker. Choose 千问实时语音 there; Flash is
the native Qwen model default and Plus is selectable in Voice settings. Existing
saved voice-engine preferences and the text model remain authoritative.

Main calls use a compact floating panel above the conversation: voice settings,
expandable native user/assistant transcript, mute and a red hangup button. Actual
transport callbacks feed the transcript; same-turn deltas join, distinct turns
remain separate and the in-memory fragment tail is bounded. The panel is a portal,
so hiding Start's controller chrome cannot hide the call controls. HUD windows and
session tiles retain the original compact in-window controls instead of a panel
that could land outside their viewport.

The existing one-shot voice request mounts the sole main composer behind Start.
That component remains mounted when a delegated voice task creates chat history
or opens settings/task pages. Starting does not submit the typed Start draft.
Activation resolves the backend mode before enabling either audio engine; pending
starts expose a connecting panel and hangup/unmount invalidates their epoch. A
scope-lost status returns null and cannot open audio on the replacement account.
The live session captures the engine before its microphone wait; settings changes
apply to the next call. No supplier, billing, permission or auth path is forked.

## Verification

From `apps/desktop`:

```sh
npx vitest run --project ui src/app/chat/composer/voice-entry.test.tsx src/app/chat/composer/hooks/use-composer-voice-start.test.tsx src/app/chat/index.test.tsx src/app/chat/composer/controls.test.tsx
npm run test:ui
npm run typecheck
npm run lint
npm run build
```

The complete UI suite passed 9,002 tests in 943 files. Reverse checks assert a
unique executable anchor before each mutation: remove Start's microphone → the
home click test fails; remove main-controller retention → the real ChatView
handoff test fails; remove pending-start cancellation → the cancelled-start test
fails. Each source file is restored in `finally`.

Browser visual inspection uses the actual launcher/panel with an explicitly
labelled simulated call, checking subtitle expansion, mute and hangup. It does
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
