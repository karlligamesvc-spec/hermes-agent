/**
 * True when a model/config write was refused because a newer one from this
 * Desktop got there first: the engine's write fence answers 409
 * `model_mutation_superseded` (hc-903), Desktop's own owner check throws
 * `MODEL_MUTATION_SUPERSEDED`. Desktop's relay-key check runs that fence over
 * every write still in flight when a signed-in APEX account starts (hc-1299).
 */
export function isSupersededModelWrite(error: unknown): boolean {
  return /model_mutation_superseded/i.test(error instanceof Error ? error.message : String(error ?? ''))
}
