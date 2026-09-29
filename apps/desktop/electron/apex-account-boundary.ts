/** Managed-account identity continuity, not JWT authentication (the server owns that). */
export function managedAccountId(token: unknown): string | null {
  try {
    if (typeof token !== 'string') {return null}
    const subject = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))?.sub

    return typeof subject === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(subject) ? subject.toLowerCase() : null
  } catch { return null }
}

export function canApplyManagedRenewal(current: string, request: string, next: string): boolean {
  const owner = managedAccountId(request)

  // The exact request token must still be current: an older concurrent renewal,
  // logout or a fresh login (even to the same account) owns a different credential.
  return Boolean(owner && current === request && next !== current && managedAccountId(next) === owner)
}

export function analysisAccountBoundary(scope: string, currentAccount: () => string | null) {
  const assertCurrent = () => {
    if (currentAccount() !== scope) {throw new Error('analysis_account_changed')}
  }

  return {
    assertCurrent,
    run: async <T>(operation: () => Promise<T>): Promise<T> => {
      assertCurrent()

      try { return await operation() } finally { assertCurrent() }
    }
  }
}
