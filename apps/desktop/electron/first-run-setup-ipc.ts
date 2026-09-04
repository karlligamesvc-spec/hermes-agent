export async function continueLocalBootstrapIpc(
  continueFirstRunLocalBootstrap: () => void
): Promise<{ ok: true }> {
  continueFirstRunLocalBootstrap()

  return { ok: true }
}
