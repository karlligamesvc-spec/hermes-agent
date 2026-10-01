import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, test, vi } from 'vitest'

import { parseProvisionResponse } from './apex-managed'
import { requestRevisionedManagedKeyMutation } from './desktop-managed-provision'
import { ManagedAuthIntent, ModelMutationMetadataStore } from './desktop-model-mutations'

const AUTHORITY = '11111111-1111-4111-8111-111111111111'
const TARGET = '22222222-2222-4222-8222-222222222222'
const directories: string[] = []

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hc903-native-issue-'))
  directories.push(directory)
  const file = path.join(directory, 'metadata.json')
  const metadata = () => new ModelMutationMetadataStore(file, () => AUTHORITY)

  return { file, metadata }
}

afterEach(() => {for (const directory of directories.splice(0)) {fs.rmSync(directory, { recursive: true, force: true })}})

test('Cloud issue shares the durable counter without creating a Runtime worker or losing its pending receipt', async () => {
  const { metadata } = fixture()
  const first = metadata().reserve({ connectionId: 'local', profile: 'default' }, TARGET)
  const calls: string[] = []

  const response = await requestRevisionedManagedKeyMutation({ capabilities: async () => {calls.push('capability');

 return { version: 1 }},
    nextRevision: () => metadata().nextProvisionRevision(),
    issue: async revision => {calls.push(`issue:${revision}`);

 return { provision_revision: revision, api_key: 'hc903-fixture-b' }},
    isCurrent: () => true, beginMutation: () => () => {}, recordUnknownMutation: () => {throw new Error('unexpected unknown issue')} })

  assert.equal(response.provision_revision, first.revision + 1)
  assert.deepEqual(calls, ['capability', 'issue:2'])
  assert.equal(metadata().pending().length, 1)
  assert.equal(metadata().nextProvisionRevision(), 3)
})

test('unsupported, offline or malformed capabilities never dispatch a rotating provision request', async () => {
  for (const capability of [404, 503, null, {}, { version: 2 }, { version: '1' }]) {
    const { metadata } = fixture()
    let issued = 0
    let unknown = 0

    await assert.rejects(requestRevisionedManagedKeyMutation({ capabilities: async () => {
      if (typeof capability === 'number') {throw Object.assign(new Error('fixture unavailable'), { statusCode: capability })}

      return capability
    }, nextRevision: () => metadata().nextProvisionRevision(), issue: async () => {issued++;

 return {}},
    isCurrent: () => true, beginMutation: () => () => {}, recordUnknownMutation: () => {unknown++} }), /MANAGED_PROVISION_UNAVAILABLE/)

    assert.equal(issued, 0)
    assert.equal(unknown, 0)
    assert.equal(metadata().nextProvisionRevision(), 1)
    assert.equal(metadata().credentialRecovery(), false)
  }
})

test('late capability or grant replies cannot dispatch or mutate a newer login recovery state', async () => {
  for (const boundary of ['capability', 'issue']) {
    const { metadata } = fixture()
    const intent = new ManagedAuthIntent()
    const current = intent.begin()
    let release!: (value: unknown) => void
    let entered!: () => void
    const barrier = new Promise(resolve => {release = resolve})
    const started = new Promise<void>(resolve => {entered = resolve})
    let issued = 0

    const attempt = requestRevisionedManagedKeyMutation({ capabilities: async () => {
      if (boundary === 'capability') {entered();

 return barrier}

      return { version: 1 }
    }, nextRevision: () => metadata().nextProvisionRevision(), issue: async () => {issued++; entered();

 return barrier},
    isCurrent: current, beginMutation: () => () => {}, recordUnknownMutation: () => metadata().markCredentialRecovery(true) })

    const rejected = assert.rejects(attempt, /MODEL_MUTATION_SUPERSEDED/)
    await started
    intent.begin()
    metadata().markCredentialRecovery(false)
    release(boundary === 'capability' ? { version: 1 } : {})
    await rejected
    assert.equal(issued, boundary === 'capability' ? 0 : 1)
    assert.equal(metadata().credentialRecovery(), false)
  }
})

test('unknown rotating outcomes persist recovery across restart and a later exact grant uses a higher revision', async () => {
  for (const outcome of [500, 'timeout', {}, { provision_revision: '1' }, { provision_revision: 2 }]) {
    const { metadata, file } = fixture()

    await assert.rejects(requestRevisionedManagedKeyMutation({ capabilities: async () => ({ version: 1 }),
      nextRevision: () => metadata().nextProvisionRevision(), issue: async () => {
        if (typeof outcome === 'number' || outcome === 'timeout') {
          throw Object.assign(new Error('fixture lost response'), typeof outcome === 'number' ? { statusCode: outcome } : {})
        }

        return outcome
      }, isCurrent: () => true, beginMutation: () => () => {}, recordUnknownMutation: () => metadata().markCredentialRecovery(true) }), /MANAGED_PROVISION_UNAVAILABLE/)

    assert.equal(metadata().credentialRecovery(), true)
    assert.equal(fs.readFileSync(file, 'utf8').includes('api_key'), false)
    assert.equal(metadata().pending().length, 0)

    const response = await requestRevisionedManagedKeyMutation({ capabilities: async () => ({ version: 1 }),
      nextRevision: () => metadata().nextProvisionRevision(), issue: async revision => ({ provision_revision: revision }),
      isCurrent: () => true, beginMutation: () => () => {}, recordUnknownMutation: () => {} })

    assert.equal(response.provision_revision, 2)
    // A grant alone does not clear recovery; credential persistence does that.
    assert.equal(metadata().credentialRecovery(), true)
  }
})

test('confirmed pre-issue rejections keep their auth status without claiming a rotation or accepting an unsafe counter', async () => {
  for (const statusCode of [401, 403, 409, 422]) {
    let unknown = 0

    await assert.rejects(requestRevisionedManagedKeyMutation({ capabilities: async () => ({ version: 1 }), nextRevision: () => 1,
      issue: async () => {throw Object.assign(new Error('fixture rejected'), { statusCode })}, isCurrent: () => true,
      beginMutation: () => () => {}, recordUnknownMutation: () => {unknown++} }), error => (error as any).statusCode === statusCode)

    assert.equal(unknown, 0)
  }

  for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    let issued = 0

    await assert.rejects(requestRevisionedManagedKeyMutation({ capabilities: async () => ({ version: 1 }), nextRevision: () => revision,
      issue: async () => {issued++;

 return {}}, isCurrent: () => true, beginMutation: () => () => {}, recordUnknownMutation: () => {} }), /MANAGED_PROVISION_UNAVAILABLE/)

    assert.equal(issued, 0)
  }
})

test('an exact revision with an invalid grant still records unknown rotation and does not restore an old credential', async () => {
  const { metadata } = fixture()
  let committed = 0

  await assert.rejects(async () => {
    await requestRevisionedManagedKeyMutation({ capabilities: async () => ({ version: 1 }),
      nextRevision: () => metadata().nextProvisionRevision(), issue: async revision => ({ provision_revision: revision }),
      isCurrent: () => true, beginMutation: () => () => {}, recordUnknownMutation: () => metadata().markCredentialRecovery(true),
      validateResponse: response => {
        if (!parseProvisionResponse(response, {})) {throw new Error('fixture malformed grant')}
      } })
    committed++
  }, /MANAGED_PROVISION_UNAVAILABLE/)
  assert.equal(committed, 0)
  assert.equal(metadata().credentialRecovery(), true)
  assert.equal(metadata().nextProvisionRevision(), 2)
})

test('a dispatched old grant remains durably unknown when a newer login fails before mutation and its late success is discarded', async () => {
  const { metadata } = fixture()
  const intent = new ManagedAuthIntent()
  const currentA = intent.begin()
  let release!: (value: any) => void
  let entered!: () => void
  const barrier = new Promise(resolve => {release = resolve})
  const started = new Promise<void>(resolve => {entered = resolve})

  const oldAttempt = requestRevisionedManagedKeyMutation({ capabilities: async () => ({ version: 1 }),
    nextRevision: () => metadata().nextProvisionRevision(), beginMutation: () => metadata().beginCredentialMutation(),
    issue: revision => {entered();

 return barrier.then(value => ({ ...value as any, provision_revision: revision }))},
    isCurrent: currentA, recordUnknownMutation: () => metadata().markCredentialRecovery(true) })

  const rejectedOld = assert.rejects(oldAttempt, /MODEL_MUTATION_SUPERSEDED/)

  await started
  assert.equal(metadata().credentialRecovery(), true)
  const currentB = intent.begin()
  let newerMutations = 0

  await assert.rejects(requestRevisionedManagedKeyMutation({
    capabilities: async () => {throw Object.assign(new Error('fixture unavailable'), { statusCode: 503 })},
    nextRevision: () => metadata().nextProvisionRevision(), beginMutation: () => metadata().beginCredentialMutation(),
    issue: async () => {newerMutations++;

 return {}}, isCurrent: currentB, recordUnknownMutation: () => metadata().markCredentialRecovery(true) }), /MANAGED_PROVISION_UNAVAILABLE/)
  assert.equal(newerMutations, 0)
  release({ api_key: 'hc903-fixture-late-a' })
  await rejectedOld
  assert.equal(metadata().credentialRecovery(), true, 'a fresh Native metadata object still sees an unsettled rotation')
  assert.equal(metadata().nextProvisionRevision(), 2)
})

test('a current known rejection rolls back only its prior recovery state', async () => {
  for (const previous of [false, true]) {
    for (const statusCode of [401, 403, 409, 422]) {
      const { metadata } = fixture()
      metadata().markCredentialRecovery(previous)

      await assert.rejects(requestRevisionedManagedKeyMutation({ capabilities: async () => ({ version: 1 }),
        nextRevision: () => metadata().nextProvisionRevision(), beginMutation: () => metadata().beginCredentialMutation(),
        issue: async () => {throw Object.assign(new Error('fixture rejected before mutation'), { statusCode })},
        isCurrent: () => true, recordUnknownMutation: () => metadata().markCredentialRecovery(true) }), /MANAGED_PROVISION_UNAVAILABLE/)
      assert.equal(metadata().credentialRecovery(), previous)
    }
  }
})

test('pending persistence failure prevents dispatch and leaves the independently read old metadata intact', async () => {
  const { metadata, file } = fixture()
  let issued = 0
  let original = ''

  const response = requestRevisionedManagedKeyMutation({ capabilities: async () => ({ version: 1 }),
    nextRevision: () => metadata().nextProvisionRevision(), beginMutation: () => {
      original = fs.readFileSync(file, 'utf8')
      const failure = vi.spyOn(fs, 'renameSync').mockImplementation(() => {throw Object.assign(new Error('fixture atomic persistence failed'), { code: 'EACCES' })})

      try {return metadata().beginCredentialMutation()} finally {failure.mockRestore()}
    }, issue: async () => {issued++;

 return {}}, isCurrent: () => true, recordUnknownMutation: () => metadata().markCredentialRecovery(true) })

  await assert.rejects(response, /fixture atomic persistence failed/)
  assert.equal(issued, 0)
  assert.equal(fs.readFileSync(file, 'utf8'), original)
  assert.equal(metadata().credentialRecovery(), false)
})
