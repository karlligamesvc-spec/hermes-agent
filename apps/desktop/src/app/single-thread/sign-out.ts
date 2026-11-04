/**
 * hc-1142: 「退出登录」 from product mode's account menu. The menu has closed by
 * the time the server answers, so the answer is handled here rather than in it.
 *
 * Fail-closed as before: the window looks signed out only once main says the
 * server revoked this computer's key (store/auth.ts). A failure leaves the
 * account as it was and says why, with the step that helps: 重新登录 when the
 * login has expired (another try cannot work), 重试 otherwise.
 */

import { signOutCopyNow, signOutFailureKind } from '@/i18n/sign-out'
import { captureManagedAuthRecoveryScope, signOutAccountWithReason } from '@/store/auth'
import { notify } from '@/store/notifications'
import { requestManagedReSignIn } from '@/store/onboarding'

export async function signOutFromAccountMenu(): Promise<void> {
  // Only a failure of the account it started on is reported.
  const isCurrent = captureManagedAuthRecoveryScope()
  const outcome = await signOutAccountWithReason()

  if (outcome.ok || !isCurrent()) {
    return
  }

  const copy = signOutCopyNow()
  const kind = signOutFailureKind(outcome)

  notify({
    kind: 'error',
    message: copy.failed[kind],
    action: {
      label: kind === 'expired' ? copy.signInAgain : copy.retry,
      onClick: () => {
        if (!isCurrent()) {
          return
        }

        if (kind === 'expired') {
          requestManagedReSignIn('')
        } else {
          void signOutFromAccountMenu()
        }
      }
    }
  })
}
