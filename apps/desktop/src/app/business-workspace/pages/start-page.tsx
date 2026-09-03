import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'

import { workflowRunRoute } from '../../routes'
import { startWorkflowGoal } from '../api/adapters'
import { BUSINESS_GOAL_INPUT_ID, BusinessGoalLauncher } from '../components/business-goal-launcher'
import { BusinessStartShelf } from '../components/start-shelf'
import type { BusinessWorkflowStarter } from '../view-model/workflow-starters'
import { businessWorkflowStarters } from '../view-model/workflow-starters'

export interface BusinessStartHomeProps {
  goalDisabled?: boolean
  onSubmitGoal?: (goal: string) => Promise<boolean> | boolean
}

/**
 * Prototype-aligned frame for the business Start route.
 *
 * The top action and starter shelf share one goal field. When the authenticated
 * workflow-domain bridge is available, submission creates the canonical
 * Project → Workflow → Run chain; older/dark shells retain the chat fallback.
 */
export function BusinessStartHome({ goalDisabled = false, onSubmitGoal }: BusinessStartHomeProps) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const workflows = useMemo(() => businessWorkflowStarters(t.businessWorkspace.workflows), [t])
  const [goalDraft, setGoalDraft] = useState('')
  const [selectedWorkflow, setSelectedWorkflow] = useState<BusinessWorkflowStarter | null>(null)
  const [domainError, setDomainError] = useState(false)
  const [domainStarting, setDomainStarting] = useState(false)

  const focusGoal = () => {
    document.getElementById(BUSINESS_GOAL_INPUT_ID)?.focus()
  }

  const selectWorkflow = (workflow: BusinessWorkflowStarter) => {
    setSelectedWorkflow(workflow)
    setGoalDraft(workflow.prompt)
    focusGoal()
  }

  const submitGoal = async (goal: string): Promise<boolean> => {
    setDomainError(false)
    setDomainStarting(true)

    const outcome = await startWorkflowGoal(
      goal,
      selectedWorkflow ?? {
        icon: 'graph',
        prompt: goal,
        slug: 'desktop-goal',
        summary: t.home.description,
        title: t.home.title
      }
    )

    setDomainStarting(false)

    if (outcome.mode === 'started') {
      navigate(workflowRunRoute(outcome.runId))

      return true
    }

    if (outcome.mode === 'failed') {
      setDomainError(true)

      return false
    }

    return (await onSubmitGoal?.(goal)) ?? false
  }

  return (
    <div className="pointer-events-auto flex w-full min-w-0 flex-col gap-5" data-business-start-home="">
      <header className="flex items-start justify-between gap-6">
        <div className="max-w-[48rem]">
          <h1 className="m-0 text-balance text-[2rem] font-semibold leading-tight tracking-[-0.02em] text-foreground">
            {t.home.title}
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{t.home.description}</p>
        </div>
        <Button className="shrink-0" onClick={focusGoal} size="sm" variant="outline">
          <Codicon name="add" size="0.875rem" />
          {t.businessWorkspace.projects.action}
        </Button>
      </header>

      <div className="flex w-full max-w-[48rem] flex-col gap-6">
        <BusinessGoalLauncher
          disabled={goalDisabled || domainStarting}
          draft={goalDraft}
          onDraftChange={draft => {
            setGoalDraft(draft)
            setSelectedWorkflow(null)
          }}
          onSubmit={submitGoal}
        />
        {domainError && (
          <p className="-mt-4 text-xs text-destructive" role="alert">
            {t.businessWorkspace.workflowDomain.startFailed}
          </p>
        )}
        <BusinessStartShelf onSelectWorkflow={selectWorkflow} />
      </div>
    </div>
  )
}
