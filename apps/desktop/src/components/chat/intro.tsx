import { BusinessStartHome } from '@/app/business-workspace/start-home'
import { ScenarioShelf } from '@/app/chat/scenarios/scenario-shelf'
import { useI18n } from '@/i18n'
import { isBusinessWorkspaceEnabled } from '@/store/business-workspace'

// Props are kept for call-site compatibility (the Thread passes the resolved
// personality + seed), but the home screen no longer varies its copy.
export type IntroProps = {
  goalDisabled?: boolean
  onSubmitGoal?: (goal: string) => Promise<boolean> | boolean
  personality?: string
  seed?: number
}

/**
 * Home zero-state: a quiet greeting plus the business start shelf. The legacy
 * scenario catalog remains the exact feature-flag rollback path. The heading
 * is pointer-events-none; either shelf re-enables pointer events for its own
 * subtree.
 *
 * hc-589: the v0.19.0 rebase reinstated upstream's zero-state here — a giant
 * `HERMES AGENT` wordmark over a rotating line of coding-agent copy ("Search the
 * repo, edit files, run tests, open PRs"), drawn from intro-copy.jsonl. That is
 * the wrong product: ours is an IM assistant, not a code agent, and the first
 * screen of every session is the last place to say otherwise. The corpus file
 * stays on disk to keep the rebase surface small (same call as the upstream
 * mascot art in public/) — what matters is that nothing rendered reaches for it.
 */
export function Intro({ goalDisabled = false, onSubmitGoal }: IntroProps) {
  const { t } = useI18n()
  const businessWorkspaceEnabled = isBusinessWorkspaceEnabled()

  return (
    <div
      className={`pointer-events-none flex w-full min-w-0 flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8 ${businessWorkspaceEnabled ? 'items-start text-left' : 'items-center text-center'}`}
      data-slot="aui_intro"
    >
      {businessWorkspaceEnabled ? (
        <BusinessStartHome goalDisabled={goalDisabled} onSubmitGoal={onSubmitGoal} />
      ) : (
        <>
          <div>
            <h1 className="m-0 text-balance text-[1.875rem] font-medium leading-tight tracking-[-0.01em] text-foreground">
              {t.home.title}
            </h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{t.home.description}</p>
          </div>
          <ScenarioShelf />
        </>
      )}
    </div>
  )
}
