/**
 * hc-1123 identity guard harness: the fixtures and the DOM reader behind the
 * goldens beside this file. They were recorded on fork main 0055de7721, before
 * any hc-1123 code existed, so this file keeps to APIs main already had.
 */
import type { WorkflowDefinition, WorkflowProject } from '@/app/business-workspace/api/types'
import { setRuntimeI18nLocale } from '@/i18n'
import { $authState } from '@/store/auth'

/** React's and Radix's generated ids count up per render in one run; they are not what the guard is about. */
export function normalized(html: string): string {
  return html.replace(/«r[0-9a-z]+»|:r[0-9a-z]+:|radix-[^"\s]+/g, '«id»')
}

/** Everything on screen, portals included: drawers and dialogs render into document.body. */
export function bodyHtml(): string {
  return normalized(document.body.innerHTML) + '\n'
}

export function seedSignedIn(): void {
  setRuntimeI18nLocale('zh')
  $authState.set({
    account: { email: 'kael@example.com', name: 'Kael', plan: '' },
    accountId: 'owner',
    enabled: true,
    gateReason: null,
    loginTruth: true,
    status: 'signed-in'
  } as ReturnType<typeof $authState.get>)
}

const project = (id: string, name: string, summary: WorkflowProject['summary']): WorkflowProject => ({
  createdAt: '2026-09-01T00:00:00Z',
  id,
  name,
  objective: `${name} 的目标`,
  status: 'active',
  summary,
  updatedAt: '2026-09-02T00:00:00Z'
})

const summary = (
  currentRunId: null | string,
  currentRunStatus: null | string,
  attention: 'failed' | 'none' | 'review'
): NonNullable<WorkflowProject['summary']> => ({
  attention,
  currentRunId,
  currentRunStatus,
  currentStepTitle: null,
  deliverableCount: 0,
  stepCompleted: 0,
  stepTotal: 0
})

/** One of each thing the 连接助手 page lists, and one project that came back without a summary. */
export const PROJECTS: WorkflowProject[] = [
  project('project-running', '春季上新', summary('run-running', 'running', 'none')),
  project('project-queued', '门店活动', summary('run-queued', 'queued', 'none')),
  project('project-review', '品牌周报', summary('run-review', 'waiting_review', 'review')),
  project('project-failed', '竞品监控', summary('run-failed', 'failed', 'failed')),
  project('project-idle', '历史项目', summary(null, null, 'none')),
  { ...project('project-phase-0', '没有摘要的项目', undefined) }
]

export const DELIVERABLES = [
  { id: 'deliverable-old', title: '上周报告', updatedAt: '2026-09-20T00:00:00Z' },
  { id: 'deliverable-new', title: '本周报告', updatedAt: '2026-09-28T00:00:00Z' }
]

export const SAVED_WORKFLOWS: WorkflowDefinition[] = [
  {
    createdAt: '2026-09-01T00:00:00Z',
    description: '每周看一次竞品',
    id: 'workflow-1',
    name: '竞品监控',
    projectId: 'project-failed',
    slug: 'competitor-monitoring',
    status: 'active',
    updatedAt: '2026-09-02T00:00:00Z',
    version: 1
  }
]

const catalogItem = (slug: string, position: number, recommended: boolean) => ({
  businessPath: 'business',
  id: slug,
  position,
  recommended,
  slug,
  version: 1
})

export const CATALOG = {
  items: [catalogItem('market-launch', 1, true), catalogItem('geo-brand-audit', 2, false)],
  mode: 'ready' as const,
  version: '2026-10'
}

export const VIDEO_CATALOG = {
  items: [{ ...catalogItem('viral-video-remake', 3, true), businessPath: 'video_production' }],
  mode: 'ready' as const,
  version: '2026-10'
}
