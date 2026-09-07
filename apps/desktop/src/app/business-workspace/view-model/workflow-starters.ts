import type { Translations } from '@/i18n'

export type BusinessWorkflowIcon = 'globe' | 'graph' | 'megaphone'

export interface BusinessWorkflowStarter {
  icon: BusinessWorkflowIcon
  prompt: string
  slug: 'content-review' | 'data-insight' | 'desktop-goal' | 'market-launch'
  summary: string
  title: string
}

type WorkflowCopy = Translations['businessWorkspace']['workflows']

/** The three approved outcome paths shared by Start and Workflows. */
export function businessWorkflowStarters(copy: WorkflowCopy): BusinessWorkflowStarter[] {
  return [
    {
      icon: 'globe',
      prompt: copy.commerce.prompt,
      slug: 'market-launch',
      summary: copy.commerce.summary,
      title: copy.commerce.title
    },
    {
      icon: 'graph',
      prompt: copy.insight.prompt,
      slug: 'data-insight',
      summary: copy.insight.summary,
      title: copy.insight.title
    },
    {
      icon: 'megaphone',
      prompt: copy.content.prompt,
      slug: 'content-review',
      summary: copy.content.summary,
      title: copy.content.title
    }
  ]
}
