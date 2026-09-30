import { $authState } from '@/store/auth'

interface StartIntent {
  fingerprint: string
  idempotencyKey: string
}

/** Account + fingerprint keys prevent another window from overwriting pending intents. */
export class PendingStartIntents {
  private pending = new Map<string, StartIntent>()

  constructor(private storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null,
    private windowId: string = crypto.randomUUID()) {}

  private key(scope: null | string | undefined, fingerprint: string) {
    return `apex.workflow.pending-start.${scope || 'window'}.${fingerprint}`
  }

  private async coordinate<T>(scope: null | string | undefined, key: string, action: () => T): Promise<T> {
    // Chromium's origin-wide lock also arbitrates the same intent across windows.
    if (scope && typeof navigator !== 'undefined' && navigator.locks) {
      return navigator.locks.request(key, action)
    }

    return action()
  }

  async begin(scope: null | string | undefined, request: unknown): Promise<StartIntent> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(request)))
    const fingerprint = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
    const key = this.key(scope, fingerprint)
    const pendingKey = `${key}.window.${this.windowId}`

    return this.coordinate(scope, key, () => {
      const existing = this.pending.get(key)

      // A peer's successful acknowledgement cannot resolve this window's lost reply.
      if (existing) {return existing}

      if (scope && this.storage) {
        try {
          const saved = this.storage.getItem(pendingKey) || this.storage.getItem(key)

          if (saved && /^desktop:[a-f0-9-]{36}$/.test(saved)) {
            const intent = { fingerprint, idempotencyKey: saved }

            this.pending.set(key, intent)
            this.storage.setItem(pendingKey, saved)

            return intent
          }
        } catch { this.storage = null /* Retain retry identity in memory when storage fails. */ }
      }

      const retained = this.pending.get(key)

      if (retained) {return retained}
      const intent = { fingerprint, idempotencyKey: `desktop:${crypto.randomUUID()}` }

      this.pending.set(key, intent)

      if (scope && this.storage) {
        try {
          this.storage.setItem(pendingKey, intent.idempotencyKey)
          this.storage.setItem(key, intent.idempotencyKey)
        }
        catch { this.storage = null /* Memory retains the pending retry key. */ }
      }

      return intent
    })
  }

  async confirm(scope: null | string | undefined, intent: StartIntent) {
    const key = this.key(scope, intent.fingerprint)
    const pendingKey = `${key}.window.${this.windowId}`

    await this.coordinate(scope, key, () => {
      if (this.pending.get(key)?.idempotencyKey === intent.idempotencyKey) {this.pending.delete(key)}

      if (scope && this.storage) {
        try {
          if (this.storage.getItem(pendingKey) === intent.idempotencyKey) {this.storage.removeItem(pendingKey)}

          if (this.storage.getItem(key) === intent.idempotencyKey) {this.storage.removeItem(key)}
        } catch { this.storage = null /* Memory still clears this confirmed attempt. */ }
      }
    })
  }
}

function startWindowIdentity(): string {
  const key = 'apex.workflow.start-window'

  try {
    const saved = sessionStorage.getItem(key)

    if (saved && /^[a-f0-9-]{36}$/.test(saved)) {return saved}
    const created = crypto.randomUUID()

    sessionStorage.setItem(key, created)

    return created
  } catch {return crypto.randomUUID()}
}

// Without a known native account, retry identity stays in this window only.
let startStorage: Storage | null = null

try {startStorage = localStorage} catch { /* A blocked cache retains this window's in-memory retry identity. */ }

export const pendingStartIntents = new PendingStartIntents(startStorage, startWindowIdentity())
export const startIntentAccount = () => $authState.get().accountId
