/**
 * hc-602 — the managed relay key must be THE SAME, ACTIVE key in every place
 * config.yaml keeps one.
 *
 * This suite deliberately does not test "did the write function get called".
 * That style of test is what let hc-595 ship: it asserted a writer's behaviour
 * against a fixture hand-typed to match the writer, and the one place that
 * actually mattered — the `custom_providers` entry the model picker
 * authenticates its live `GET /v1/models` with — sat on a `rotated` key for a
 * week while every log line and every test said the sync had succeeded.
 *
 * What is asserted instead is a CLASS-LEVEL INVARIANT:
 *
 *     after a reconcile, every managed relay-key holder in the document holds
 *     the active key — including holders this test never heard of.
 *
 * Two mechanisms keep that honest as the code grows:
 *
 *   1. The fixtures are driven off `MANAGED_KEY_ANCHORS`. Registering a new
 *      anchor kind without adding a fixture for it fails `every registered
 *      anchor kind has a fixture` immediately, and once the fixture exists the
 *      new anchor is folded into every assertion below automatically. There is
 *      no list to remember to update.
 *   2. `auditManagedRelayKeyAnchors` never reads the registry, so a holder
 *      nobody registered is still found — see `an UNREGISTERED holder is
 *      caught`. That is the case the previous two rounds of this bug were made
 *      of: the exit nobody had looked at yet.
 *
 * Reverse verification (the tests are only worth what breaking them proves) is
 * explicit: `poisoning ANY single anchor turns the invariant red` walks the
 * registry and rots one anchor at a time, asserting the audit and the persist
 * both fail and both NAME the anchor.
 *
 * No test in this file may contain a real key: values are `sk-…` fakes and the
 * audit only ever reports masked digests.
 */
import assert from 'node:assert/strict'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  auditManagedRelayKeyAnchors,
  locateManagedKeyAnchors,
  MANAGED_KEY_ANCHORS,
  MANAGED_PROVIDER_NAME,
  managedCustomProviderEntryYaml,
  managedModelConfigYaml,
  maskRelayKey,
  parseYamlMaps,
  persistRelayKeyToConfigYaml,
  reconcileManagedRelayKey,
  syncManagedCatalogDiscoveryYaml,
  syncManagedRelayConfigYaml,
  syncManagedRelayKeyYaml
} from './apex-managed'

const RELAY_BASE = 'https://apex-nodes.com/relay/v1'
const MODEL_ID = 'deepseek-v4-pro-APEX'

/** The key the platform's `api_keys` table currently marks `active`. */
const ACTIVE = 'sk-Active000000000000000000000000'
/** A key the platform has marked `rotated` — relay-dead. Kael's real symptom. */
const ROTATED = 'sk-Rotated00000000000000000000000'

// ── One fixture per REGISTERED anchor kind ──────────────────────────────────
// Keyed by `MANAGED_KEY_ANCHORS[].id`. A new registry entry with no fixture
// here fails the very first test in this file.

const ANCHOR_FIXTURES: Record<string, (key: string) => string> = {
  // The credential a chat turn authenticates with.
  model: key =>
    `model:\n  default: ${MODEL_ID}\n  provider: custom\n  base_url: "${RELAY_BASE}"\n  api_key: "${key}"\n`,

  // The registered endpoint the picker's live catalog listing runs on. Rendered
  // by the SHARED producer, so this fixture cannot drift away from what the app
  // actually writes — the exact drift that hid hc-595.
  custom_providers: key =>
    'custom_providers:\n' +
    managedCustomProviderEntryYaml({
      name: MANAGED_PROVIDER_NAME,
      base_url: RELAY_BASE,
      api_key: key,
      model: MODEL_ID
    }),

  // The v12 dict shape hermes_cli/config.py migrates `custom_providers` INTO
  // (and then deletes the list). Not yet observed in the wild; registered
  // because "not yet observed" is precisely the state the last two misses were
  // in when they shipped.
  providers: key =>
    'providers:\n' +
    '  apex-nodes-com:\n' +
    `    api: "${RELAY_BASE}"\n` +
    `    name: "${MANAGED_PROVIDER_NAME}"\n` +
    `    api_key: "${key}"\n` +
    `    default_model: ${MODEL_ID}\n`
}

/** A config.yaml holding EVERY registered anchor, all on `key`. */
function configWithEveryAnchor(key: string): string {
  const blocks = MANAGED_KEY_ANCHORS.map(anchor => ANCHOR_FIXTURES[anchor.id](key))

  // Unrelated content on both sides, so the walk has to actually navigate.
  return (
    'toolsets:\n  - hermes-cli\n' +
    blocks.join('') +
    'skills:\n  disabled: []\n' +
    'plugins:\n  enabled:\n    - apex-overlay\n'
  )
}

/** Read one anchor's on-disk value back, structurally. */
function valueAt(raw: string, path: string): string {
  return parseYamlMaps(raw).maps.find(map => map.path === path)?.fields.api_key?.value ?? ''
}

/** Rot exactly one anchor back to the rotated key. */
function poison(raw: string, path: string, key = ROTATED): string {
  const { lines, maps } = parseYamlMaps(raw)
  const field = maps.find(map => map.path === path)?.fields.api_key
  assert.ok(field, `fixture bug: no api_key at ${path}`)
  const next = [...lines]
  next[field.line] = next[field.line].replace(/(api_key:\s*).*$/, `$1"${key}"`)

  return next.join('\n')
}

// ── The forcing function ────────────────────────────────────────────────────

test('every registered anchor kind has a fixture (a new anchor cannot slip in untested)', () => {
  const missing = MANAGED_KEY_ANCHORS.filter(anchor => !ANCHOR_FIXTURES[anchor.id]).map(a => a.id)
  assert.deepEqual(
    missing,
    [],
    'A new entry was added to MANAGED_KEY_ANCHORS without a fixture in ANCHOR_FIXTURES. ' +
      'Add one: every test below is generated from the registry, so the fixture is how the ' +
      'new anchor joins the invariant.'
  )
  // And the registry is not empty-by-accident.
  assert.ok(MANAGED_KEY_ANCHORS.length >= 3)
})

test('hc-705: the sole managed endpoint renderer always enables live catalog discovery', () => {
  const rendered = managedCustomProviderEntryYaml({
    name: MANAGED_PROVIDER_NAME,
    base_url: RELAY_BASE,
    api_key: ACTIVE,
    model: MODEL_ID
  })

  assert.match(rendered, /^ {4}discover_models: true$/m)
})

// ── The invariant ───────────────────────────────────────────────────────────

test('a rotated key is written to EVERY registered anchor, and the audit proves it', () => {
  let file = configWithEveryAnchor(ROTATED)

  const before = auditManagedRelayKeyAnchors(file, RELAY_BASE, ACTIVE)
  assert.equal(before.clean, false)
  assert.equal(before.holders.length, MANAGED_KEY_ANCHORS.length)
  assert.equal(before.stale.length, MANAGED_KEY_ANCHORS.length)

  const result = persistRelayKeyToConfigYaml({
    read: () => file,
    write: next => {
      file = next
    },
    baseUrl: RELAY_BASE,
    key: ACTIVE
  })

  assert.equal(result.ok, true)
  assert.equal(result.changed, true)

  const after = auditManagedRelayKeyAnchors(file, RELAY_BASE, ACTIVE)
  assert.equal(after.clean, true, `still stale: ${after.stale.join(', ')}`)
  assert.equal(after.holders.length, MANAGED_KEY_ANCHORS.length)

  for (const holder of after.holders) {
    assert.equal(holder.ok, true, `${holder.path} holds ${holder.holds}`)
  }

  // Every registry kind is actually represented — not three fixtures that all
  // happened to resolve to the same anchor.
  assert.deepEqual(
    [...new Set(result.anchors.map(anchor => anchor.kind))].sort(),
    MANAGED_KEY_ANCHORS.map(anchor => anchor.id).sort()
  )
  // Untargeted content survives byte for byte.
  assert.match(file, /toolsets:\n {2}- hermes-cli/)
  assert.match(file, /plugins:\n {2}enabled:\n {4}- apex-overlay/)
})

describe('reverse verification', () => {
  // The registry drives this: a fourth anchor is automatically rot-tested too.
  for (const anchor of MANAGED_KEY_ANCHORS) {
    test(`poisoning the "${anchor.id}" anchor alone turns the invariant red`, () => {
      const healthy = configWithEveryAnchor(ACTIVE)
      assert.equal(auditManagedRelayKeyAnchors(healthy, RELAY_BASE, ACTIVE).clean, true)

      const target = locateManagedKeyAnchors(healthy, RELAY_BASE).find(a => a.kind === anchor.id)
      assert.ok(target, `no locatable anchor for kind ${anchor.id}`)

      const rotted = poison(healthy, target.path)

      const audit = auditManagedRelayKeyAnchors(rotted, RELAY_BASE, ACTIVE)
      assert.equal(audit.clean, false, 'a stale anchor MUST fail the audit')
      assert.deepEqual(audit.stale, [target.path])
      // Never the raw value, in a test or anywhere else.
      const holder = audit.holders.find(h => h.path === target.path)
      assert.equal(holder?.holds, maskRelayKey(ROTATED))
      assert.equal(holder?.holds.includes(ROTATED), false)

      // And a write that cannot land it is reported as a failure that NAMES the
      // anchor, rather than a silent success.
      const dropped = persistRelayKeyToConfigYaml({
        read: () => rotted,
        write: () => {},
        baseUrl: RELAY_BASE,
        key: ACTIVE
      })

      assert.equal(dropped.ok, false)
      assert.equal(dropped.reason, `verify-failed: ${target.path}`)

      // A real write heals it and the invariant is restored.
      let file = rotted

      const healed = persistRelayKeyToConfigYaml({
        read: () => file,
        write: next => {
          file = next
        },
        baseUrl: RELAY_BASE,
        key: ACTIVE
      })

      assert.equal(healed.ok, true)
      assert.equal(auditManagedRelayKeyAnchors(file, RELAY_BASE, ACTIVE).clean, true)
    })
  }
})

test('an UNREGISTERED holder is caught — the audit does not consult the registry', () => {
  // Somebody adds a fourth place that keeps the relay key (here: the auxiliary
  // vision slot pointed at the relay) and forgets to register it. The writer
  // cannot know about it — but the file would then be internally inconsistent,
  // which is the entire failure mode hc-602 exists to make impossible.
  const rogue =
    configWithEveryAnchor(ACTIVE) +
    'auxiliary:\n' +
    '  vision:\n' +
    '    provider: auto\n' +
    `    base_url: "${RELAY_BASE}"\n` +
    `    api_key: "${ROTATED}"\n`

  const audit = auditManagedRelayKeyAnchors(rogue, RELAY_BASE, ACTIVE)
  assert.equal(audit.clean, false)
  assert.deepEqual(audit.unregistered, ['auxiliary.vision'])
  assert.deepEqual(audit.stale, ['auxiliary.vision'])

  // The writer refuses rather than leaving the document half-right, and says
  // exactly where the unregistered holder is.
  let wrote = false

  const refused = persistRelayKeyToConfigYaml({
    read: () => rogue,
    write: () => {
      wrote = true
    },
    baseUrl: RELAY_BASE,
    key: ACTIVE
  })

  assert.equal(refused.ok, false)
  assert.equal(refused.reason, 'unregistered-anchor: auxiliary.vision')
  assert.equal(wrote, false, 'all-or-nothing: an unresolvable document is not partially written')

  // Sanity: the same slot pointed at a DIFFERENT endpoint is a BYOK key and is
  // none of our business.
  const byokVision =
    configWithEveryAnchor(ACTIVE) +
    'auxiliary:\n' +
    '  vision:\n' +
    '    provider: auto\n' +
    '    base_url: "https://vision.example/v1"\n' +
    `    api_key: "${ROTATED}"\n`

  assert.equal(auditManagedRelayKeyAnchors(byokVision, RELAY_BASE, ACTIVE).clean, true)
})

// ── The hc-595 miss, as a standing regression ───────────────────────────────

describe('every real producer of managed config is syncable', () => {
  // Each entry is a shape config.yaml is actually observed in. The hc-595 bug
  // WAS this table having one row (column-0 list lead) while the app emitted
  // another (two-space lead) — so the table is the regression.
  const PRODUCERS: Array<[string, (key: string) => string]> = [
    [
      'the first-run seeder (managedModelConfigYaml)',
      key =>
        managedModelConfigYaml({
          default: MODEL_ID,
          provider: 'custom',
          base_url: RELAY_BASE,
          api_key: key,
          custom_providers: [
            { name: MANAGED_PROVIDER_NAME, base_url: RELAY_BASE, api_key: key, model: MODEL_ID }
          ]
        })
    ],
    [
      "the boot healer's appended entry (main.ts healConfigYamlProductBlocks)",
      key =>
        `model:\n  base_url: ${RELAY_BASE}\n  api_key: ${key}\n  provider: custom\n` +
        'custom_providers:\n' +
        managedCustomProviderEntryYaml({
          name: MANAGED_PROVIDER_NAME,
          base_url: RELAY_BASE,
          api_key: key,
          model: MODEL_ID
        })
    ],
    [
      'a PyYAML re-dump (column-0 list lead, unquoted scalars)',
      key =>
        `model:\n  api_key: ${key}\n  base_url: ${RELAY_BASE}\n  provider: custom\n` +
        `custom_providers:\n- api_key: ${key}\n  base_url: ${RELAY_BASE}\n  name: ${MANAGED_PROVIDER_NAME}\n`
    ],
    [
      'an indented-sequence dump (ruamel / yaml.dump with an indenting dumper)',
      key =>
        `model:\n  api_key: '${key}'\n  base_url: '${RELAY_BASE}'\n  provider: custom\n` +
        `custom_providers:\n  - api_key: '${key}'\n    base_url: '${RELAY_BASE}'\n    name: '${MANAGED_PROVIDER_NAME}'\n`
    ],
    [
      'a re-dump whose base_url drifted (entry identified by the seeded name)',
      key =>
        `model:\n  api_key: ${key}\n  base_url: ${RELAY_BASE}\n  provider: custom\n` +
        'custom_providers:\n' +
        `  - name: ${MANAGED_PROVIDER_NAME}\n    base_url: https://apex-nodes.com/relay\n    api_key: ${key}\n`
    ],
    [
      'the v12 providers dict (custom_providers migrated away)',
      key => `model:\n  api_key: ${key}\n  base_url: ${RELAY_BASE}\n  provider: custom\n` + ANCHOR_FIXTURES.providers(key)
    ]
  ]

  for (const [label, produce] of PRODUCERS) {
    test(label, () => {
      const stale = produce(ROTATED)

      // Both anchors of this shape are visible to the writer…
      const located = locateManagedKeyAnchors(stale, RELAY_BASE)
      assert.ok(located.length >= 2, `only found ${located.length} anchor(s) in:\n${stale}`)

      // …the audit agrees they are ALL stale before the write…
      assert.equal(auditManagedRelayKeyAnchors(stale, RELAY_BASE, ACTIVE).stale.length, located.length)

      let file = stale

      const result = persistRelayKeyToConfigYaml({
        read: () => file,
        write: next => {
          file = next
        },
        baseUrl: RELAY_BASE,
        key: ACTIVE
      })

      // …and after it the invariant holds.
      assert.equal(result.ok, true, result.reason)
      assert.equal(auditManagedRelayKeyAnchors(file, RELAY_BASE, ACTIVE).clean, true)
      // Idempotent: a second pass is a clean no-op, not a second rewrite.
      assert.equal(syncManagedRelayKeyYaml(file, RELAY_BASE, ACTIVE).changed, false)
    })
  }
})

test('hc-595 regression: the seeded shape is NOT a one-anchor document', () => {
  // The single assertion that would have been red before hc-602. The seeder's
  // own output was invisible to hc-595's `custom_providers` matcher, so the
  // sync silently covered `model:` only and called it a success.
  const seeded = ANCHOR_FIXTURES.model(ROTATED) + ANCHOR_FIXTURES.custom_providers(ROTATED)
  const sync = syncManagedRelayKeyYaml(seeded, RELAY_BASE, ACTIVE)

  assert.equal(sync.matched, true)
  assert.equal(sync.entries.matched, 1, 'the seeded custom_providers entry must be addressable')
  assert.equal(sync.entries.updated, 1)
  assert.equal(sync.model, 'updated')
  assert.equal(valueAt(sync.next, 'model'), ACTIVE)
  assert.equal(valueAt(sync.next, 'custom_providers[0]'), ACTIVE)
})

// ── Not-anchors stay not-anchors ────────────────────────────────────────────

test('a BYOK model block and foreign endpoints are never handed a relay key', () => {
  const mixed =
    'model:\n  api_key: sk-users-own-deepseek-key\n  base_url: https://api.deepseek.com/v1\n  provider: deepseek\n' +
    'custom_providers:\n' +
    '  - name: mine\n    base_url: https://my-endpoint.example/v1\n    api_key: sk-mine\n' +
    managedCustomProviderEntryYaml({
      name: MANAGED_PROVIDER_NAME,
      base_url: RELAY_BASE,
      api_key: ROTATED,
      model: MODEL_ID
    })

  const sync = syncManagedRelayKeyYaml(mixed, RELAY_BASE, ACTIVE)
  assert.equal(sync.model, 'absent', 'a BYOK model block is not ours to rewrite')
  assert.deepEqual(sync.entries, { matched: 1, updated: 1 })
  assert.equal(valueAt(sync.next, 'model'), 'sk-users-own-deepseek-key')
  assert.equal(valueAt(sync.next, 'custom_providers[0]'), 'sk-mine')
  assert.equal(valueAt(sync.next, 'custom_providers[1]'), ACTIVE)
  assert.equal(auditManagedRelayKeyAnchors(sync.next, RELAY_BASE, ACTIVE).clean, true)
})

describe('hc-705 managed relay catalog discovery', () => {
  test('a Windows CRLF upgrade heals both managed YAML anchors and preserves the 12-model cache', () => {
    const models = Array.from({ length: 12 }, (_, index) => `relay-model-${index + 1}`)

    const stale = (
      `model:\n  default: ${models[0]}\n  provider: custom\n  base_url: "${RELAY_BASE}"\n` +
      `  api_key: "${ACTIVE}"\n  discover_models: false\n` +
      'custom_providers:\n' +
      `  - name: "${MANAGED_PROVIDER_NAME}"\n    base_url: "${RELAY_BASE}"\n` +
      `    api_key: "${ACTIVE}"\n    model: ${models[0]}\n    discover_models: false\n` +
      '    models:\n' + models.map(model => `      ${model}: {}\n`).join('')
    ).replace(/\n/g, '\r\n')

    const sync = syncManagedCatalogDiscoveryYaml(stale, RELAY_BASE, ACTIVE)

    assert.equal(sync.changed, true)
    assert.deepEqual(sync.anchors.map(anchor => anchor.path), ['model', 'custom_providers[0]'])
    assert.equal((sync.next.match(/discover_models: true/g) || []).length, 2)
    assert.equal((sync.next.match(/relay-model-\d+: \{\}/g) || []).length, 12)
    assert.equal(sync.next.replace(/\r\n/g, '').includes('\n'), false, 'Windows CRLF must be preserved')
    assert.equal(syncManagedCatalogDiscoveryYaml(sync.next, RELAY_BASE, ACTIVE).changed, false)
  })

  test('the v12 providers dict upgrade is healed when it is the managed ApexNodes entry', () => {
    const stale =
      `providers:\n  apex-nodes-com:\n    name: ${MANAGED_PROVIDER_NAME}\n    api: ${RELAY_BASE}\n` +
      `    api_key: ${ACTIVE}\n    discover_models: false\n    default_model: ${MODEL_ID}\n`

    const sync = syncManagedCatalogDiscoveryYaml(stale, RELAY_BASE, ACTIVE)

    assert.equal(sync.changed, true)
    assert.deepEqual(sync.anchors, [{ path: 'providers.apex-nodes-com', status: 'updated' }])
    assert.match(sync.next, /discover_models: true/)
  })

  test('the real OneClickSetup CRLF shape heals its stale key before enabling discovery', () => {
    const stale = (
      `model:\n  default: deepseek-v4-flash\n  provider: custom\n  base_url: "${RELAY_BASE}"\n` +
      `  api_key: "${ROTATED}"\n` +
      'custom_providers:\n' +
      '  # oneclicksetup:begin apex-provider\n' +
      `  - name: "APEX"\n    base_url: "${RELAY_BASE}"\n` +
      `    api_key: "${ROTATED}"\n    key_env: "APEX_RELAY_KEY"\n` +
      '    model: "deepseek-v4-flash"\n    discover_models: false\n' +
      '    models:\n      "deepseek-v4-flash": {}\n' +
      '  # oneclicksetup:end apex-provider\n'
    ).replace(/\n/g, '\r\n')

    const sync = syncManagedRelayConfigYaml(stale, RELAY_BASE, ACTIVE)

    assert.equal(sync.changed, true)
    assert.deepEqual(
      sync.key.anchors.map(anchor => [anchor.path, anchor.status]),
      [['model', 'updated'], ['custom_providers[0]', 'updated']]
    )
    assert.deepEqual(sync.catalog.anchors, [
      { path: 'model', status: 'in-sync' },
      { path: 'custom_providers[0]', status: 'updated' }
    ])
    assert.equal(valueAt(sync.next, 'model'), ACTIVE)
    assert.equal(valueAt(sync.next, 'custom_providers[0]'), ACTIVE)
    assert.match(sync.next, /name: "APEX"\r\n/)
    assert.match(sync.next, /discover_models: true\r\n/)
    assert.equal((sync.next.match(/deepseek-v4-flash/g) || []).length, 3, 'the one-model cache is preserved')
    assert.equal(/[^\r]\n/.test(sync.next), false, 'Windows CRLF must be preserved')
    assert.equal(syncManagedRelayConfigYaml(sync.next, RELAY_BASE, ACTIVE).changed, false)
  })

  test('a user-owned endpoint explicitly disabling discovery is not rewritten', () => {
    const userOwned =
      'providers:\n  private-gateway:\n    name: My private gateway\n    base_url: https://my-endpoint.example/v1\n' +
      `    api_key: ${ACTIVE}\n    discover_models: false\n    model: private-only\n`

    const sync = syncManagedCatalogDiscoveryYaml(userOwned, RELAY_BASE, ACTIVE)

    assert.equal(sync.changed, false)
    assert.equal(sync.next, userOwned)
    assert.match(sync.next, /discover_models: false/)
  })
})

test('MoA presets reference the relay but hold no key — derived, not an anchor', () => {
  // Documented in the registry as a deliberate non-anchor; asserted here so the
  // claim is checked rather than believed.
  const withMoa =
    configWithEveryAnchor(ACTIVE) +
    'moa:\n' +
    '  reference_models:\n' +
    '    - provider: custom:apex-nodes.com\n      model: kimi-k3\n' +
    '  aggregator:\n    provider: custom:apex-nodes.com\n    model: kimi-k2.6\n'

  const audit = auditManagedRelayKeyAnchors(withMoa, RELAY_BASE, ACTIVE)
  assert.equal(audit.clean, true)
  assert.equal(
    audit.holders.some(holder => holder.path.startsWith('moa')),
    false
  )
})

test('a CRLF config.yaml heals identically, and stays CRLF', () => {
  // Windows really does get CRLF: the runtime saves config.yaml with
  // `os.fdopen(fd, "w", encoding="utf-8")` (utils.py::atomic_yaml_write) —
  // text mode, no `newline=`, so Python translates every \n. A trailing \r is a
  // line terminator to JS regex, so `(.*)$` cannot match past it and a naive
  // split finds NO fields: the whole sync degrades to `no-managed-anchor` on one
  // of the three platforms we ship. Same fact, different shape — the class this
  // ticket is about, so it gets an assertion rather than a shrug.
  const crlf = configWithEveryAnchor(ROTATED).replace(/\n/g, '\r\n')

  const sync = syncManagedRelayKeyYaml(crlf, RELAY_BASE, ACTIVE)

  assert.equal(sync.anchors.length, MANAGED_KEY_ANCHORS.length)
  assert.equal(auditManagedRelayKeyAnchors(sync.next, RELAY_BASE, ACTIVE).clean, true)
  // The file's own ending survives: rewriting a Windows config to LF would be a
  // whole-file diff and would fight every other writer that touches it.
  assert.equal(sync.next.includes('\r\n'), true)
  assert.equal(/[^\r]\n/.test(sync.next), false, 'no bare LF may be introduced into a CRLF file')
  // Byte-for-byte the same outcome as the LF path, modulo the endings.
  const lf = syncManagedRelayKeyYaml(configWithEveryAnchor(ROTATED), RELAY_BASE, ACTIVE)
  assert.equal(sync.next.replace(/\r\n/g, '\n'), lf.next)
})

test('a missing api_key is inserted after the IDENTITY field, never into a nested block', () => {
  // The shipped `model:` block really does carry a nested `disabled_providers:`
  // (hc-392's Copilot cut). Splicing the new key after the map's LAST field puts
  // it between that header and its first item — invalid YAML, i.e. a config the
  // runtime refuses to load at all, which is a strictly worse outcome than the
  // stale key being fixed. Anchoring to the identity scalar is what prevents it.
  const missing =
    'model:\n' +
    `  base_url: ${RELAY_BASE}\n` +
    '  provider: custom\n' +
    '  disabled_providers:\n    - copilot\n' +
    'custom_providers:\n' +
    `  - name: ${MANAGED_PROVIDER_NAME}\n    base_url: ${RELAY_BASE}\n    models:\n      ${MODEL_ID}:\n        context_length: 128000\n`

  const sync = syncManagedRelayKeyYaml(missing, RELAY_BASE, ACTIVE)

  assert.equal(sync.changed, true)
  assert.deepEqual(
    sync.anchors.map(anchor => anchor.status),
    ['inserted', 'inserted']
  )
  // Well-formed: the nested blocks are still intact and still nested.
  assert.match(sync.next, /model:\n {2}base_url: [^\n]+\n {2}api_key: "[^"]+"\n {2}provider: custom\n {2}disabled_providers:\n {4}- copilot/)
  assert.match(sync.next, /- name: [^\n]+\n {4}base_url: [^\n]+\n {4}api_key: "[^"]+"\n {4}models:\n {6}\S+:\n {8}context_length: 128000/)
  // And re-reading the result finds both keys exactly where they were written.
  assert.equal(valueAt(sync.next, 'model'), ACTIVE)
  assert.equal(valueAt(sync.next, 'custom_providers[0]'), ACTIVE)
  assert.equal(auditManagedRelayKeyAnchors(sync.next, RELAY_BASE, ACTIVE).clean, true)
  // Idempotent — the inserted lines are addressable on the next pass.
  assert.equal(syncManagedRelayKeyYaml(sync.next, RELAY_BASE, ACTIVE).changed, false)
})

test('the walker reads the shipped config.yaml layout without tripping over it', () => {
  // A compressed version of a real install: block scalars, deep nesting, empty
  // maps, scalar sequences, a trailing top-level key. The whole point of the
  // walker is that none of this is special-cased.
  const real =
    'model:\n' +
    `  base_url: ${RELAY_BASE}\n` +
    `  api_key: ${ROTATED}\n` +
    '  disabled_providers:\n    - copilot\n' +
    '  provider: custom\n' +
    'fallback_providers: []\n' +
    'agent:\n  environment_hint: |\n    model: not-a-key\n    api_key: not-a-key-either\n  max_turns: 90\n' +
    'auxiliary:\n  vision:\n    base_url: \'\'\n    api_key: \'\'\n' +
    'web:\n  backend: \'\'\n' +
    '_config_version: 30\n' +
    'custom_providers:\n' +
    managedCustomProviderEntryYaml({
      name: MANAGED_PROVIDER_NAME,
      base_url: RELAY_BASE,
      api_key: ROTATED,
      model: MODEL_ID
    }) +
    'plugins:\n  enabled:\n    - apex-overlay\n'

  const anchors = locateManagedKeyAnchors(real, RELAY_BASE)
  assert.deepEqual(
    anchors.map(a => a.path),
    ['model', 'custom_providers[0]']
  )
  // The block scalar's `api_key:` text is prose, not a key.
  const audit = auditManagedRelayKeyAnchors(real, RELAY_BASE, ACTIVE)
  assert.deepEqual(audit.stale, ['model', 'custom_providers[0]'])

  const sync = syncManagedRelayKeyYaml(real, RELAY_BASE, ACTIVE)
  assert.equal(auditManagedRelayKeyAnchors(sync.next, RELAY_BASE, ACTIVE).clean, true)
  assert.match(sync.next, /environment_hint: \|\n {4}model: not-a-key\n {4}api_key: not-a-key-either/)
  assert.match(sync.next, /auxiliary:\n {2}vision:\n {4}base_url: ''\n {4}api_key: ''/)
})

// ── End to end: Kael's machine ──────────────────────────────────────────────

describe("Kael's install heals without a manual re-login", () => {
  /** The platform's `api_keys` table: exactly one key is relay-valid at a time. */
  class FakeRelay {
    active: string
    mints = 0

    constructor(active: string) {
      this.active = active
    }

    probe(key: string) {
      return key === this.active ? { ok: true, statusCode: 200 } : { ok: false, statusCode: 401 }
    }

    /** `GET /v1/models` — the picker's live catalog. */
    catalog(key: string): string[] {
      return key === this.active ? ['deepseek-v4-pro', 'qwen3.7-max', 'kimi-k2.7-code', 'glm-5.2'] : []
    }

    mint(): string {
      this.mints += 1
      this.active = `sk-Minted${this.mints}000000000000000000`

      return this.active
    }
  }

  /**
   * What the runtime's model picker would show: the relay's live list when the
   * registered entry authenticates, otherwise just the one model config.yaml
   * names. This is the user-visible symptom — "其他模型不见了" — expressed as an
   * assertion instead of a screenshot.
   */
  function pickerModels(config: string, relay: FakeRelay): string[] {
    const entry = parseYamlMaps(config).maps.find(map => /^custom_providers\[\d+\]$/.test(map.path))
    const live = relay.catalog(entry?.fields.api_key?.value ?? '')

    return live.length > 0 ? live : [MODEL_ID]
  }

  test('one fresh + one rotated anchor: both end active and the catalog comes back', async () => {
    const relay = new FakeRelay(ACTIVE)

    // The exact state observed on 2026-07-27: model.api_key had been refreshed
    // via /api/model/set at sign-in, custom_providers still held the key the
    // platform had marked `rotated`.
    let config = ANCHOR_FIXTURES.model(ACTIVE) + ANCHOR_FIXTURES.custom_providers(ROTATED)

    assert.deepEqual(pickerModels(config, relay), [MODEL_ID], 'precondition: the catalog has collapsed')

    let backendReloads = 0

    const outcome = await reconcileManagedRelayKey({
      enabled: true,
      storedKey: ACTIVE,
      baseUrl: RELAY_BASE,
      hasToken: true,
      readConfig: () => config,
      writeConfig: (next: string) => {
        config = next
      },
      probeRelay: async (key: string) => relay.probe(key),
      provisionKey: async () => ({ apiKey: relay.mint() }),
      applyToBackend: () => {
        backendReloads += 1
      },
      log: () => {}
    })

    assert.equal(outcome.ok, true)
    // No mint was needed: the working key was already on disk, it was the OTHER
    // anchor that was stale. Minting here is what stranded eight keys in hc-595.
    assert.equal(relay.mints, 0)
    assert.equal(outcome.probeStatus, 'ok')
    assert.equal(backendReloads, 1, 'the running backend must be told to re-read config.yaml')

    assert.equal(auditManagedRelayKeyAnchors(config, RELAY_BASE, ACTIVE).clean, true)
    assert.equal(valueAt(config, 'model'), ACTIVE)
    assert.equal(valueAt(config, 'custom_providers[0]'), ACTIVE)
    assert.deepEqual(pickerModels(config, relay), [
      'deepseek-v4-pro',
      'qwen3.7-max',
      'kimi-k2.7-code',
      'glm-5.2'
    ])
  })

  test('both anchors dead: one mint heals both, and the catalog returns', async () => {
    const relay = new FakeRelay('sk-SomeoneElseRotatedUsOut0000000')
    let config = configWithEveryAnchor(ROTATED)

    const outcome = await reconcileManagedRelayKey({
      enabled: true,
      storedKey: ROTATED,
      baseUrl: RELAY_BASE,
      hasToken: true,
      readConfig: () => config,
      writeConfig: (next: string) => {
        config = next
      },
      probeRelay: async (key: string) => relay.probe(key),
      provisionKey: async () => ({ apiKey: relay.mint() }),
      applyToBackend: () => {},
      log: () => {}
    })

    assert.equal(outcome.healed, true)
    assert.equal(relay.mints, 1, 'exactly one mint')
    assert.equal(auditManagedRelayKeyAnchors(config, RELAY_BASE, relay.active).clean, true)
    assert.deepEqual(pickerModels(config, relay), [
      'deepseek-v4-pro',
      'qwen3.7-max',
      'kimi-k2.7-code',
      'glm-5.2'
    ])
  })
})

// ── Secret hygiene ──────────────────────────────────────────────────────────

describe('no raw key ever leaves this module', () => {
  const logs: string[] = []

  beforeEach(() => {
    logs.length = 0
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('audit output and failure reasons carry masked digests only', () => {
    const rotted = configWithEveryAnchor(ROTATED)
    const audit = auditManagedRelayKeyAnchors(rotted, RELAY_BASE, ACTIVE)
    const serialized = JSON.stringify(audit)

    assert.equal(serialized.includes(ROTATED), false)
    assert.equal(serialized.includes(ACTIVE), false)

    for (const holder of audit.holders) {
      expect(holder.holds).toMatch(/^sk-…#[0-9a-f]{16}$/)
    }

    const failed = persistRelayKeyToConfigYaml({
      read: () => rotted,
      write: () => {},
      baseUrl: RELAY_BASE,
      key: ACTIVE
    })

    assert.equal(failed.reason.includes(ACTIVE), false)
    assert.equal(failed.reason.includes(ROTATED), false)
    assert.equal(logs.length, 0)
  })
})
