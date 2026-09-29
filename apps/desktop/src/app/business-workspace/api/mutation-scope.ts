import { $authState } from '@/store/auth'

// A pending write belongs to the account that initiated it, including its auth gate.
export function captureWorkflowMutationScope(): () => boolean {
  const { accountId, enabled, status } = $authState.get()

  return () => {
    const current = $authState.get()

    return current.accountId === accountId && current.enabled === enabled && current.status === status
  }
}
