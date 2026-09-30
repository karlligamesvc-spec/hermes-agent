import { afterEach, expect, it, vi } from 'vitest'

import { $authState } from '@/store/auth'

import type { BusinessWorkflowStarter } from '../view-model/workflow-starters'

import { startWorkflowGoal } from './adapters'
import type { WorkflowDomainBridge } from './types'

const original = $authState.get()
afterEach(() => $authState.set(original))

it('retains failed Start identity across display locales while goal and version edits create new intentions', async () => {
  $authState.set({ ...original, accountId: 'start-intent-owner', enabled: true, status: 'signed-in' })
  const startGoal = vi.fn<WorkflowDomainBridge['startGoal']>(async () => ({ ok: false }))

  const bridge: WorkflowDomainBridge = {
    access: async () => ({ available: true }), startGoal,
    cancelRun: async () => ({ ok: false }), getRun: async () => ({ ok: false }),
    reviewDeliverable: async () => ({ ok: false })
  }

  const starter: BusinessWorkflowStarter = {
    id: 'competitor-monitoring', slug: 'competitor-monitoring', version: 3,
    title: '竞品监控', summary: '中文显示简介', prompt: '默认目标',
    businessPath: 'research', icon: 'graph', recommended: false
  }

  await startWorkflowGoal('Original goal', starter, bridge)
  await startWorkflowGoal('Original goal', { ...starter, title: 'Competitor monitoring', summary: 'English copy' }, bridge)
  expect(startGoal.mock.calls[1]?.[0].idempotencyKey).toBe(startGoal.mock.calls[0]?.[0].idempotencyKey)
  await startWorkflowGoal('Edited goal', starter, bridge)
  expect(startGoal.mock.calls[2]?.[0].idempotencyKey).not.toBe(startGoal.mock.calls[0]?.[0].idempotencyKey)
  await startWorkflowGoal('Original goal', { ...starter, version: 4 }, bridge)
  expect(startGoal.mock.calls[3]?.[0].idempotencyKey).not.toBe(startGoal.mock.calls[0]?.[0].idempotencyKey)
})
