import { notifyError } from '@/store/notifications'

import { openArtifactHref } from '../artifacts/artifact-utils'

/** Shared outcome action for the Start and Projects summary surfaces. */
export async function openWorkspaceArtifact(href: string, failureLabel: string): Promise<void> {
  try {
    await openArtifactHref(href)
  } catch (error) {
    notifyError(error, failureLabel)
  }
}
