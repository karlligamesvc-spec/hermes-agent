import type { Translations } from '@/i18n'

export type BusinessWorkflowIcon = 'globe' | 'graph' | 'megaphone'

export interface BusinessWorkflowStarter {
  icon: BusinessWorkflowIcon
  prompt: string
  summary: string
  title: string
}

type WorkflowCopy = Translations['businessWorkspace']['workflows']

/**
 * The three approved outcome paths shared by Start and Workflows.
 *
 * Keeping one catalog prevents the two entrances from drifting while their
 * exits remain intentionally different: Start stages the goal in its compact
 * launcher; Workflows opens a new chat and stages it in the full Composer.
 */
export function businessWorkflowStarters(copy: WorkflowCopy): BusinessWorkflowStarter[] {
  return [
    {
      icon: 'globe',
      prompt: copy.commerce.prompt,
      summary: copy.commerce.summary,
      title: copy.commerce.title
    },
    {
      icon: 'graph',
      prompt: copy.insight.prompt,
      summary: copy.insight.summary,
      title: copy.insight.title
    },
    {
      icon: 'megaphone',
      prompt: copy.content.prompt,
      summary: copy.content.summary,
      title: copy.content.title
    }
  ]
}
