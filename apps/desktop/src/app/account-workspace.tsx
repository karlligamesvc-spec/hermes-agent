import { useStore } from '@nanostores/react'
import { Fragment, type ReactNode, useEffect } from 'react'

import { $authState, refreshAuthStatus, refreshChangedAccount } from '@/store/auth'
import { $desktopOnboarding } from '@/store/onboarding'

interface AccountWorkspaceProps {
  children: ReactNode
}

/** Account-owned page memory must not survive logout or an identity replacement. */
export function AccountWorkspace({ children }: AccountWorkspaceProps) {
  const auth = useStore($authState)

  if (auth.enabled !== false && auth.status !== 'signed-in' && auth.status !== 'expired') {
    return null
  }

  // UUID is authoritative for continuity. Email is only a compatibility fallback
  // for older bridges; neither is a substitute for server authentication.
  const owner = auth.enabled === false ? 'device' : auth.accountId || auth.account.email || 'managed'

  return <Fragment key={owner}>{children}</Fragment>
}

/** Both shells, including secondary windows, follow the native credential owner. */
export function useManagedAccountChanges() {
  useEffect(() => {
    const unsubscribe = window.hermesDesktop?.onManagedAccountChanged?.(() => {
      refreshChangedAccount($desktopOnboarding.get().managedSubmitting)
    })

    void refreshAuthStatus()

    return unsubscribe
  }, [])
}
