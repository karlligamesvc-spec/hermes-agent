import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'

import { BUSINESS_GOAL_INPUT_ID, BusinessGoalLauncher } from './goal-launcher'
import { BusinessStartShelf } from './start-shelf'
import type { BusinessWorkflowStarter } from './workflow-starters'

export interface BusinessStartHomeProps {
  goalDisabled?: boolean
  onSubmitGoal?: (goal: string) => Promise<boolean> | boolean
}

/**
 * Prototype-aligned frame for the business Start route.
 *
 * This component only composes the existing goal submit and real workspace
 * read models. The top action focuses the same goal field; it does not create
 * a second conversation, Project, Workflow, Run, or transport.
 */
export function BusinessStartHome({ goalDisabled = false, onSubmitGoal }: BusinessStartHomeProps) {
  const { t } = useI18n()
  const [goalDraft, setGoalDraft] = useState('')

  const focusGoal = () => {
    document.getElementById(BUSINESS_GOAL_INPUT_ID)?.focus()
  }

  const selectWorkflow = (workflow: BusinessWorkflowStarter) => {
    setGoalDraft(workflow.prompt)
    focusGoal()
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
          disabled={goalDisabled}
          draft={goalDraft}
          onDraftChange={setGoalDraft}
          onSubmit={onSubmitGoal}
        />
        <BusinessStartShelf onSelectWorkflow={selectWorkflow} />
      </div>
    </div>
  )
}
