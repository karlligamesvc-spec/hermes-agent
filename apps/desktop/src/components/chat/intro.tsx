import { ScenarioShelf } from '@/app/chat/scenarios/scenario-shelf'
import { useI18n } from '@/i18n'

// Props are kept for call-site compatibility (the Thread passes the resolved
// personality + seed), but the home screen no longer varies its copy.
export type IntroProps = {
  personality?: string
  seed?: number
}

/**
 * Home zero-state: a quiet greeting plus the hc-554 scenario shelf below it.
 * The shelf self-gates (renders nothing when the catalog is disabled/empty), so
 * with scenarios off this stays the bare Codex-minimal heading. The heading is
 * pointer-events-none; the shelf re-enables pointer events for its own subtree.
 */
export function Intro(_props: IntroProps) {
  const { t } = useI18n()

  return (
    <div
      className="pointer-events-none flex w-full min-w-0 flex-col items-center gap-8 px-4 py-6 text-center sm:px-6 lg:px-8"
      data-slot="aui_intro"
    >
      <h1 className="m-0 text-balance text-[1.875rem] font-medium leading-tight tracking-[-0.01em] text-foreground">
        {t.home.title}
      </h1>
      <ScenarioShelf />
    </div>
  )
}
