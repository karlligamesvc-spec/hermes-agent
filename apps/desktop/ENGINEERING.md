# Desktop Engineering — the reasoning

ApexNodes hc-911: the long form behind the shorter sections of [`AGENTS.md`](./AGENTS.md),
moved here so the AGENTS.md chain stays within its context cap
(`scripts/ci/check_agents_md_size.py`). The rules are unchanged.

## Server truth is cached, not owned

The renderer paints from a cache of backend truth, so it must reconcile, not
assume:

- **Merge, don't clobber.** A refresh is new information layered over what you
  already know, not a replacement that can drop live or pinned rows.
- **Be optimistic, then honest.** Direct manipulation should paint immediately
  from a snapshot; a failed write rolls back visibly and an authoritative
  refresh gets the last word.
- **Guard against the past.** Async results can arrive out of order; a stale
  response must never overwrite newer intent. Generation counters and request
  tokens exist for this.
- **Isolate the foreground.** Only the surface the user is looking at may publish
  into the shared view; background work updates its own cache quietly.
- **Coalesce noise, flush signal.** Batch high-frequency cosmetic updates, but
  let terminal transitions (a turn finishing, needing input, failing) reach the
  user immediately.
- **Preserve reference identity on no-ops.** Handing React a fresh array that
  contains the same data re-renders expensive trees for nothing.

## Switching context is a re-home, not a reboot

Changing profile, connection, or mode is a workspace switch, not a cold start.
The shell and whatever the user was doing stay put; only the gateway-bound view
is cleared and repopulated, and the previous context must not leak into the next
one. Reserve the full-screen boot/connecting experience for a genuinely unusable
backend.

There are three distinct switch shapes, and conflating them is the classic bug:

- A **connection/mode apply** (local ↔ remote ↔ cloud) is the soft re-home:
  shell mounted, gateway-bound stores explicitly wiped, then reconnect. Query
  invalidation alone cannot evict live session stores — wipe them.
- A **runtime home change** (switching the underlying `HERMES_HOME` profile) is
  a hard re-home: the window legitimately reloads and state resets by remount.
- A **live profile swap** in the same window activates another profile's socket
  while background profiles keep streaming; lists merge rather than wipe, and
  only an explicit user selection starts a fresh foreground draft.

Treating a soft switch as hard flickers the app; treating a hard one as soft
strands stale rows. After any swap, the active socket, active profile, and
connection atoms must agree, or REST and filesystem calls route to the wrong
backend.

## Cross everything as an observable ladder

Desktop lives at the seams: versions, profiles, local vs remote vs cloud,
partially installed runtimes, stale caches, older backends. The durable technique
for all of it is the same — an ordered ladder of candidates:

1. Precedence is written down, in one place, as data or a pure function.
2. A candidate is trusted only after it is validated at the right boundary.
   Existence is not proof; probe what you're about to rely on.
3. A failed *read* falls to the next rung; a failed *authoritative write*
   surfaces or rolls back rather than silently retargeting.
4. A missing capability and a transient failure are different: the first may
   enable a compatibility path or a disabled state; the second should retry.
5. Retries are bounded and end in a real recovery affordance — never an infinite
   spinner or a hot loop.
6. One resolver owns each policy so every caller gets the same answer. Scatter is
   how two call sites drift apart.

This is the shape of backend discovery, command/version fallbacks, connection and
auth resolution, workspace-cwd selection, capability detection, and preview
normalization alike. Learn the shape, not a snapshot of the current rungs.

Two auth-flavored corollaries worth naming because they are easy to get wrong:

- **One-time credentials are never reused.** An OAuth gateway connection mints a
  fresh WebSocket ticket on every dial and never falls back to the cached URL.
  Only a confirmed 401/403 (or an explicitly tagged auth rejection) means
  reauthentication; timeout, network, malformed-response, and server failures
  remain connectivity errors. Only long-lived token/local auth may reuse a
  cached URL as a lower rung.
- **A connection test must exercise the leg you'll actually use.** An HTTP
  status probe passing while the WebSocket/auth leg fails is a false positive
  that ships as "it said connected but nothing works."
