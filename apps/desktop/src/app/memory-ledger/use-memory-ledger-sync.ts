import { useStore } from '@nanostores/react'
import { useEffect } from 'react'

import { $authState } from '@/store/auth'
import { syncMemoryLedger, syncMemoryLedgerIfStale } from '@/store/memory-ledger'

/**
 * hc-1016: keep the account's memory ledger (and main's prompt copy for the
 * local engine) in step from app start, on every account change and when the
 * window comes back after a while. With `desktop_features.single_thread` off
 * this only asks main to drop a stale prompt copy; nothing shows.
 */
export function useMemoryLedgerSync() {
  const { accountId, status } = useStore($authState)

  useEffect(() => {
    if (status === 'signed-in') {
      void syncMemoryLedger(accountId)
    }
  }, [accountId, status])

  useEffect(() => {
    const onFocus = () => {
      const auth = $authState.get()

      if (auth.status === 'signed-in') {
        syncMemoryLedgerIfStale(auth.accountId)
      }
    }

    window.addEventListener('focus', onFocus)

    return () => window.removeEventListener('focus', onFocus)
  }, [])
}
