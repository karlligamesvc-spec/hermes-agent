# hc-818 — Desktop shared shell, Profile and Settings scope matrix

## Baseline and delivery boundary

- Base: frozen Draft PR #261, exact commit `ce8b9e127f84bb59c642218457ba97bedaab2eb1`.
- Branch: `codex/hc-818-desktop-shared-profile-settings` in an isolated worktree.
- Ticket lookup: `hc-818` was absent from the ApexNodes all-refs history and PRs, the `karlligamesvc-spec/hermes-agent` all-refs history and PRs, and Feishu PD Sheet1 column L (`apex!L1:L933`, revision 6902) before the branch was created.
- Product references: `profile-usage-modal-1235x1024.png`, `settings-modal-1235x1024.png`, `profile-usage-existing.png`, `APEX-DESKTOP-UI-REDESIGN-SPEC-2026-09.md`, and `APEX-DESKTOP-UI-REDESIGN-IMPLEMENTATION-2026-09.md`.
- In scope: the persistent account entry, shared account-overlay chrome, Profile, Settings, account-overlay routing/focus, and tests that protect these surfaces.
- Explicitly out of scope: Start, Projects and Workflows behavior or APIs; Run, Deliverable and Review surfaces; Phase 2 APIs; DeepSeek Harness; scheduler/relay; terminal and file-tree removal; publishing, deployment, updater-feed changes, merge, or release.
- The approved mockups define hierarchy, rhythm and responsive intent. Mock values and mock toggles are not product data and will not be copied.

## Entry and route matrix

| Entry | Destination | Surface | Close / back contract | Focus contract | This batch |
|---|---|---|---|---|---|
| Bottom account control → Profile | `/profile` | Account overlay above the current route | Escape, backdrop, or Close returns to the exact previous non-overlay path including search/hash | Menu is keyboard operable; dialog receives initial focus; closing returns focus to the invoking account control | Preserve and add route/focus guards |
| Bottom account control → Settings | `/settings` | Account overlay above the current route | Same exact-route restoration contract | Same trigger → dialog → trigger loop | Preserve and add route/focus guards |
| Profile → Settings | `/settings` | Replace the Profile account overlay without changing the remembered underlying route | Closing Settings returns to the route that was open before Profile | Focus starts inside Settings; closing returns to the original account entry where available | Add an explicit handoff |
| `⌘,`, command palette, recovery/deep link | `/settings` with optional `tab` | Same Settings account overlay | Existing overlay routing contract remains authoritative | Dialog semantics and focus containment apply regardless of entry | Preserve |
| `/settings?tab=connections` | Gateway settings compatibility alias | Settings content, not Sessions | Existing close contract | Existing section navigation semantics | Fix the stale alias dispatch |
| Assistant settings / connection permissions | Existing right drawer routes | Right-side drawer | Existing drawer close behavior | Existing drawer behavior | No change; do not merge into account Settings |
| Technical `/profiles`, `/agents`, `/command-center`, `/skills`, `/messaging`, `/webhooks` | Existing technical surfaces | Existing overlay/route types | Existing behavior | Existing behavior | Preserve, not promoted into primary customer navigation |

## Surface and responsive matrix

| Viewport | Shared shell | Profile | Settings | Acceptance invariant |
|---|---|---|---|---|
| 1440×900 | Persistent APEX identity and account entry remain clear | Centered, bounded account surface with page heading, identity, real usage modules and account details | Centered, bounded account surface with clear heading, category rail and scrollable content | No root horizontal overflow; traffic-light clearance; final content is fully reachable |
| 1220×800 | Same hierarchy at reduced breathing room | Bounded surface may use more of the viewport while retaining readable line lengths | Rail and content remain usable; no clipped search/close controls | No overlap among titlebar, header, rail and content |
| 752×800 | Existing 640–899px collapsed-sidebar behavior remains intact | Full-window account surface, not a small inset modal; heatmap may scroll only inside its own region | Full-window account surface; category selector becomes the existing compact dropdown | No inset-card remnant, no root overflow, keyboard reaches every control, last content item can scroll fully into view |

Account overlays must expose a named `dialog`, be modal to assistive technology, receive and contain keyboard focus, close exactly once on Escape, prevent background scrolling, and restore focus on unmount. Nested dialogs keep Escape priority over the account overlay.

## Data and state matrix

| Surface / module | Source of truth | Loading | Full | Sparse / empty | Failure | Forbidden substitute |
|---|---|---|---|---|---|---|
| Account identity | Managed `$authState` account (`name`, `email`, `plan`) | Existing auth lifecycle | Initial/avatar, real name/email and real plan when present | Explicit signed-out or missing-field text; omit absent plan | Existing expired/sign-in recovery | Invented user, tier, quota or percentage |
| Profile usage | Real local `GET /api/analytics/usage?days=365` via `getUsageAnalytics` | Perceptible loader | Sessions, tokens, API calls, active days and skills only when supplied; daily/weekly/cumulative heatmap from real daily rows | One honest no-activity state when no sessions; omit null metrics and absent modules | Perceptible error plus Retry; preserve the rest of Profile | Mock numbers, forced zero cards, fake percentages, fake skills or synthetic production-looking activity |
| Profile account details | Managed auth fields already present in `$authState` | Follows auth state | Read-only values for fields actually available | Honest signed-out / not-provided labels | No separate failure source | Edit button, security state, timezone, join date or other unavailable account facts |
| Profile → Settings handoff | Existing `/settings` route | N/A | Explicit action opens real Settings | Disabled only when routing is unavailable | Existing route recovery | New account API or fake edit flow |
| Settings sections | Existing settings stores, IPC and component logic | Each existing module owns its lifecycle | Personalization, appearance, browser, providers and archived chats in customer IA; hidden technical sections remain deep-linkable | Existing honest empty/unchecked states | Existing retry/error surfaces | Prototype-only toggles or values |
| About versions | Electron app-version IPC and managed engine version | Existing states | APEX app version and AI engine version remain separate | Honest unavailable/unchecked labels | Existing update-check failure copy | Merged version, fabricated availability, release/upload implication |

Chinese customer-facing Settings labels must not fall back to visible `Browser`, `Hermes`, or `Nous` branding. Technical payload/file-format compatibility remains untouched unless the product-facing outlet is in this scope.

## Outlet inventory

| Outlet family | Counted entry points / consumers | Decision |
|---|---|---|
| Account Profile / Settings | Bottom account menu, `/profile`, `/settings`, `⌘,`, command palette/deep links, Profile-to-Settings handoff | Modify only the customer-facing account path and shared account overlay behavior |
| Overlay consumers | Settings, system, agents, technical profiles, command center, star map and other `OverlayView` users | Shared accessibility behavior must remain compatible; add regression tests instead of changing route meaning |
| Terminal | Registered pane, terminal actions/shortcuts, command palette, layout presets, persistent xterm, provider `runInTerminal` | Preserve; add a source guard so visual cleanup cannot silently remove it |
| File tree | Registered pane, right-sidebar titlebar control, actions/shortcuts, layout presets, real-workspace empty state | Preserve; add a source guard so visual cleanup cannot silently remove it |
| Hidden technical Settings | Consumer visibility gate plus existing deep links | Preserve. Hidden from the customer IA is not deletion |
| Phase 1 business pages | Start, Projects, Workflows and their bridges | No implementation or contract change |

## Planned changes

1. Add an account-surface header and bounded wide-screen treatment for Profile and Settings while retaining the existing <=760px full-window mode.
2. Complete `OverlayView` dialog naming, focus containment/restoration, Escape priority and background-scroll semantics with shared regression coverage.
3. Keep Profile's real analytics gates, add clear hierarchy, read-only real account details, an explicit Settings handoff, and a concise accessible heatmap summary.
4. Keep Settings logic intact, clarify the title/search hierarchy, localize the customer Browser section, and fix the `connections` compatibility route.
5. Clarify the account trigger's accessible name and keep logout explicit.
6. Preserve APEX identity, the separate app/engine versions, all technical outlets, and the frozen #261 business-page behavior.

## Verification and reverse-injection matrix

| Guard | Positive check | Reverse fault that must fail it |
|---|---|---|
| Overlay accessibility | Named modal dialog, initial focus, Tab/Shift+Tab containment, Escape once, scroll lock, trigger focus restoration | Remove one modal/focus/scroll behavior at a uniquely asserted anchor |
| Compact Settings | 752px packaged Electron has a full-window surface, compact category selector, no root overflow, reachable last item | Restore compact inset padding or wide rail at a uniquely asserted anchor |
| Profile honesty | Null metrics/modules stay absent; zero sessions gives one empty state; failures expose Retry | Render null as `0`, force an empty heatmap, or remove Retry |
| Profile route handoff | Profile action opens Settings and closing returns to the original underlying route | Point the action at a wrong route or discard the remembered return path |
| Settings compatibility | `tab=connections` renders Gateway, never Sessions | Remove the compatibility alias |
| Chinese/APEX identity | Customer-visible Settings IA is Chinese and contains no Hermes/Nous fallback branding | Remove the Browser translation or restore the Hermes fallback |
| Version separation | App and AI engine labels use their respective sources | Wire app version to engine version or collapse the labels |
| Developer outlets | Terminal pane/actions and file-tree pane/titlebar toggle remain registered | Remove each guarded registration/action individually |
| Frozen business scope | Start, Projects and Workflows routes/bridges retain #261 behavior | Any diff in the protected business files fails the scope audit |

Every source fault injection must first assert an exact unique target, run the relevant guard and observe failure, then restore the file and rerun the guard green. Final validation includes targeted unit/integration tests, identity layer, route/drawer tests, full Desktop UI and platform suites, typecheck, lint, production build, an unsigned/ad-hoc Mac arm64 package built with `--publish never`, and isolated-userData native Electron inspection at 1440×900, 1220×800 and 752×800.
