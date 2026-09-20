import type { Translations } from '@/i18n'

export type BusinessWorkflowIcon = 'globe' | 'graph' | 'megaphone'

export interface BusinessStarterCard {
  icon: BusinessWorkflowIcon
  id: string
  summary: string
  title: string
}

export interface BusinessHomeStarter extends BusinessStarterCard {
  prompt: string
}

export interface BusinessWorkflowStarter extends BusinessHomeStarter {
  businessPath: string
  recommended: boolean
  slug:
    | 'business-review'
    | 'competitor-monitoring'
    | 'content-review'
    | 'desktop-goal'
    | 'geo-brand-audit'
    | 'market-launch'
    | 'review-insights'
  version: number
}

type WorkflowCopy = Translations['businessWorkspace']['workflows']

/** Start-page shortcuts are Agent goals, not production Workflow templates. */
export function businessHomeStarters(copy: WorkflowCopy): BusinessHomeStarter[] {
  return [
    {
      icon: 'globe',
      id: 'video-transcript',
      prompt: copy.homePaths.videoTranscript.prompt,
      summary: copy.homePaths.videoTranscript.summary,
      title: copy.homePaths.videoTranscript.title
    },
    {
      icon: 'graph',
      id: 'viral-video-remake',
      prompt: copy.homePaths.viralRemake.prompt,
      summary: copy.homePaths.viralRemake.summary,
      title: copy.homePaths.viralRemake.title
    },
    {
      icon: 'megaphone',
      id: 'social-intelligence',
      prompt: copy.homePaths.socialIntelligence.prompt,
      summary: copy.homePaths.socialIntelligence.summary,
      title: copy.homePaths.socialIntelligence.title
    }
  ]
}

/** The six approved Phase 1 templates in the production Workflows catalog. */
export function businessWorkflowStarters(copy: WorkflowCopy): BusinessWorkflowStarter[] {
  return [
    {
      businessPath: 'cross_border_launch',
      icon: 'globe',
      id: 'market-launch',
      prompt: copy.commerce.prompt,
      recommended: true,
      slug: 'market-launch',
      summary: copy.commerce.summary,
      title: copy.commerce.title,
      version: 1
    },
    {
      businessPath: 'geo_brand_audit',
      icon: 'graph',
      id: 'geo-brand-audit',
      prompt: copy.insight.prompt,
      recommended: true,
      slug: 'geo-brand-audit',
      summary: copy.insight.summary,
      title: copy.insight.title,
      version: 1
    },
    {
      businessPath: 'content_review',
      icon: 'megaphone',
      id: 'content-review',
      prompt: copy.content.prompt,
      recommended: true,
      slug: 'content-review',
      summary: copy.content.summary,
      title: copy.content.title,
      version: 1
    },
    {
      businessPath: 'competitor_monitoring',
      icon: 'graph',
      id: 'competitor-monitoring',
      prompt: copy.competitor.prompt,
      recommended: false,
      slug: 'competitor-monitoring',
      summary: copy.competitor.summary,
      title: copy.competitor.title,
      version: 1
    },
    {
      businessPath: 'review_insights',
      icon: 'megaphone',
      id: 'review-insights',
      prompt: copy.reviews.prompt,
      recommended: false,
      slug: 'review-insights',
      summary: copy.reviews.summary,
      title: copy.reviews.title,
      version: 1
    },
    {
      businessPath: 'business_review',
      icon: 'globe',
      id: 'business-review',
      prompt: copy.businessReview.prompt,
      recommended: false,
      slug: 'business-review',
      summary: copy.businessReview.summary,
      title: copy.businessReview.title,
      version: 1
    }
  ]
}
