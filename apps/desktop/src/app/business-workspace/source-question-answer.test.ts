import { expect, it, vi } from 'vitest'

import { sourceQuestionEvidence, validateSourceAnswer } from '../../../shared/analysis-answer'

import type { AnalysisDocument, AnalysisDocumentsBridge } from './analysis-types'
import { answerSourceQuestion } from './source-question-answer'

const source: AnalysisDocument = { id: 'local-a', analysis_scope: 'owner', analysis_revision: 'a'.repeat(64),
  filename: 'facts.txt', kind: 'text', status: 'ready', storageMode: 'local',
  anchors: [{ id: 'a1', text: 'Revenue increased by twenty percent.', location: { paragraph: 1 } }] }

const generated = { answer_type: 'semantic_answer', answer: 'Revenue grew by 20%.', anchor_ids: ['a1'] }

function fixture() {
  const bridge = { questionContext: vi.fn().mockResolvedValue({ ok: true, item: structuredClone(source) }),
    saveAnswer: vi.fn().mockImplementation(async (_id, _scope, input) => ({ ok: true, item: { ...input, id: 'q1' } }))
  } as unknown as AnalysisDocumentsBridge

  const runtime = { request: vi.fn().mockResolvedValue({ text: JSON.stringify(generated) }) }

  return { bridge, runtime }
}

it('sends only current evidence via stateless RPC and persists a cited answer', async () => {
  const { bridge, runtime } = fixture()
  await answerSourceQuestion(source, 'How did revenue change?', 'en', bridge, runtime, () => true)
  const [method, params, timeout] = runtime.request.mock.calls[0]
  expect(method).toBe('llm.oneshot')
  expect(params.task).toBe('source_question')
  expect(params.session_id).toBeUndefined()
  expect(JSON.parse(params.input)).toEqual({ kind: 'text', question: 'How did revenue change?', evidence: source.anchors })
  expect(timeout).toBe(90000)
  expect(bridge.saveAnswer).toHaveBeenCalledWith('local-a', 'owner', { ...generated, schema: 1,
    revision: source.analysis_revision, locale: 'en', question: 'How did revenue change?' })
})

it.each(['not JSON', JSON.stringify({ ...generated, anchor_ids: ['fake'] }), JSON.stringify({ ...generated, anchor_ids: [] }),
  JSON.stringify({ ...generated, answer_type: 'semantic_no_evidence' })])('rejects unsupported model output: %s', async text => {
  const { bridge, runtime } = fixture()
  runtime.request.mockResolvedValue({ text })
  await expect(answerSourceQuestion(source, 'Revenue?', 'en', bridge, runtime, () => true)).rejects.toThrow('answer_output_invalid')
  expect(bridge.saveAnswer).not.toHaveBeenCalled()
})

it('persists an explicit absence of evidence without a fabricated answer or citation', async () => {
  const { bridge, runtime } = fixture()
  runtime.request.mockResolvedValue({ text: JSON.stringify({ answer_type: 'semantic_no_evidence', answer: '', anchor_ids: [] }) })
  await expect(answerSourceQuestion(source, 'Unknown launch date?', 'en', bridge, runtime, () => true))
    .resolves.toMatchObject({ answer_type: 'semantic_no_evidence', answer: '', anchor_ids: [] })
})

it.each(['owner', 'revision', 'oversize', 'old_backend'])('refuses %s context before spending a model call', async change => {
  const { bridge, runtime } = fixture()
  const current = structuredClone(source)

  if (change === 'owner') {current.analysis_scope = 'another'}

  if (change === 'revision') {current.analysis_revision = 'b'.repeat(64)}

  if (change === 'oversize') {current.anchors![0].text = 'x'.repeat(60001)}

  if (change === 'old_backend') {current.analysis_revision = undefined}
  vi.mocked(bridge.questionContext).mockResolvedValue({ ok: true, item: current })
  await expect(answerSourceQuestion(source, 'Revenue?', 'en', bridge, runtime, () => true)).rejects.toThrow()
  expect(runtime.request).not.toHaveBeenCalled()
  expect(bridge.saveAnswer).not.toHaveBeenCalled()
})

it('discards late results and never calls storage after a workspace change', async () => {
  const { bridge, runtime } = fixture()
  let current = true
  runtime.request.mockImplementationOnce(async () => { current = false;

 return { text: JSON.stringify(generated) } })
  await expect(answerSourceQuestion(source, 'Revenue?', 'en', bridge, runtime, () => current)).rejects.toThrow('answer_context_changed')
  expect(bridge.saveAnswer).not.toHaveBeenCalled()
  current = true
  vi.mocked(bridge.saveAnswer).mockResolvedValue({ ok: false, code: 'answer_source_changed' })
  await expect(answerSourceQuestion(source, 'Revenue?', 'en', bridge, runtime, () => current)).rejects.toThrow('answer_source_changed')
})

it.each(['pdf', 'word', 'excel', 'text', 'feishu', 'subtitle'] as const)('accepts the full extracted %s text without claiming visual evidence', kind => {
  expect(sourceQuestionEvidence({ ...source, kind })).toEqual(source.anchors)
  const input = { schema: 1, revision: source.analysis_revision, locale: 'zh', question: '营收如何？', ...generated }
  expect(validateSourceAnswer(input, { ...source, kind }, source.analysis_revision!)).toEqual(input)
})
