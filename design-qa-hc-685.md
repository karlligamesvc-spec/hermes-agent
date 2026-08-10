# hc-685 Design QA

## Reference

- Selected prototype: `prototypes/apex-desktop-business-agent/qa/comparison-minimal-final.png` in the read-only ApexNodes product checkout.
- Product truth: 70% familiar agent shell (history / conversation / composer) plus 30% business workspace.
- Implementation under review: packaged `APEX.app` built from this worktree with a pristine isolated profile.

## Comparison

| Area | Reference intent | Implemented result | Status |
|---|---|---|---|
| Familiar shell | Left history, central conversation, bottom composer remain dominant | Existing contribution shell, session state, chat tiles, composer, and overlays are unchanged | Pass |
| Navigation | 开始 / 项目 / 工作流 / 定时运行 / 交付物 / 业务账号 / 历史 | Exact seven-item order is asserted in unit and packaged-Electron tests | Pass |
| Start state | Lead with business outcome, not implementation vocabulary | “今天想推进什么业务？” plus outcome-first supporting copy; scenarios and real composer remain | Pass |
| Projects | Show an outcome-oriented project entry without inventing data | Empty project skeleton offers real chat and the existing v0.20 task surface; copy explicitly defers aggregation to data wiring | Pass |
| Workflows | Start from a repeatable business path | Three restrained outcome paths insert their goal into the real composer; no synthetic workflow records | Pass |
| Technical details | Model / MCP / Skills / cron should not define the default IA | Model, MCP, and Skills are absent from the seven-item navigation; cron is presented as “定时运行” | Pass |
| Brand identity | Preserve APEX identity and current visual language | Existing shell, logo, palette, typography, login/onboarding, and update surfaces are untouched | Pass |

## Intentional differences

- Decorative project dashboards from the prototype are not copied. hc-685 keeps layout and hierarchy deliberately sparse until real task/session/artifact aggregation lands in hc-697.
- The existing one-time installer correctly covers interaction in a pristine packaged profile. The packaged identity test therefore asserts the real shell and navigation DOM beneath that product-owned overlay; it does not bypass installation and claim an interactive post-install state.
- Progress, latest output/evidence, run history/recovery, approval flow, and artifacts remain the existing v0.20 surfaces. This change makes Tasks reachable from Projects but does not merge those records into a new project domain model.

## Responsive / platform review

- The new views use the existing shell sizing, page insets, scroll ownership, color tokens, and breakpoint (`md`) conventions; no OS-specific renderer branch was added.
- macOS arm64 packaged Electron smoke is executed locally. Windows and Linux retain the same renderer bundle and are guarded by the platform-neutral identity/component contracts; native three-platform hands-on GUI remains a release-review step, not something this macOS worktree can honestly claim.
