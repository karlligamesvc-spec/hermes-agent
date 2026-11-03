import { useStore } from '@nanostores/react'
import { useEffect } from 'react'

import { useI18n } from '@/i18n'
import { useCloudLoginCopy } from '@/i18n/cloud-login'
import { $authState } from '@/store/auth'
import { $cloudLoginRejected, watchCloudLogin } from '@/store/cloud-login'
import { requestManagedReSignIn } from '@/store/onboarding'

import { SessionExpiredCard } from './session-expired-card'

/**
 * hc-1073: the 「登录已失效」 card above the account row while the cloud rejects
 * the stored login JWT but chat (relay key) still works. Platform skills and
 * plugins stop updating in that state; a click opens the sign-in, and a
 * successful sign-in re-pulls both (main's provision path) and clears the card.
 * Its two mounts, AccountPanel and the single-thread account row, render it only
 * beside a signed-in row: an 'expired' account already shows the same card in
 * place of the row.
 */
export function CloudLoginNotice() {
  const { t } = useI18n()
  const copy = useCloudLoginCopy()
  const rejected = useStore($cloudLoginRejected)
  const { accountId, status } = useStore($authState)

  // Re-read whenever the account or its sign-in changes; main's pushes cover the rest.
  useEffect(() => {
    watchCloudLogin()
  }, [accountId, status])

  if (!rejected) {
    return null
  }

  return (
    <SessionExpiredCard
      action={copy.action}
      cloudLogin
      onClick={() => requestManagedReSignIn(copy.reason)}
      title={t.auth.account.sessionExpiredTitle}
    />
  )
}
