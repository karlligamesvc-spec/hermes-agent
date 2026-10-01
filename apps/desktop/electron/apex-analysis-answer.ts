import { type SourceAnswerInput, sourceQuestionEvidence, validateSourceAnswer } from '../shared/analysis-answer'
import type { OverviewSource } from '../shared/analysis-video-overview'

import { saveLocalSourceAnswer } from './apex-analysis-local'

interface Dependencies {
  context: (id: string, scope: string) => Promise<{
    context: { root: string; url: string; transport: { postJson: (url: string, body: unknown) => Promise<unknown> } }
    item: OverviewSource & { analysis_revision?: string; source_answers_supported?: boolean }
    local: boolean
  }>
  currentAccount: () => string | null
  error: (error: unknown) => string
}

export function createSourceAnswerHandlers(deps: Dependencies) {
  return {
    questionContext: async (_event: unknown, id: string, scope: string) => {
      try {
        const { item, local } = await deps.context(id, scope)

        if (deps.currentAccount() !== scope) {throw new Error('analysis_account_changed')}

        if (!local && item.source_answers_supported !== true) {throw new Error('answer_backend_upgrade_required')}
        sourceQuestionEvidence(item)

        return { ok: true, item }
      } catch (error) {return { ok: false, code: deps.error(error) }}
    },
    saveAnswer: async (_event: unknown, id: string, scope: string, input: SourceAnswerInput) => {
      try {
        const { context, item: source, local } = await deps.context(id, scope)

        if (deps.currentAccount() !== scope) {throw new Error('analysis_account_changed')}

        if (!local && source.source_answers_supported !== true) {throw new Error('answer_backend_upgrade_required')}
        const checked = validateSourceAnswer(input, source, source.analysis_revision ?? '')

        const item = local ? saveLocalSourceAnswer(context.root, scope, id, checked)
          : (await context.transport.postJson(`${context.url}/${encodeURIComponent(id)}/questions/answers`, checked) as { item: unknown }).item

        if (deps.currentAccount() !== scope) {throw new Error('analysis_account_changed')}

        return { ok: true, item }
      } catch (error) {return { ok: false, code: deps.error(error) }}
    }
  }
}
