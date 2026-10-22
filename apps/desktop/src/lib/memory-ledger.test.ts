import { describe, expect, it } from 'vitest'

import { memoryNotesFromParts } from './memory-ledger'

const ENTRY = { content: '不露脸', id: '3f2a9c1d-0000-4000-8000-000000000001', kind: 'about_you', ref: '3f2a9c1d' }
const ADDED = JSON.stringify({ action: 'add', created: true, entry: ENTRY, ok: true })

function part(toolName: string, args: unknown, result: unknown = ADDED) {
  return { args, result, toolCallId: 'c1', toolName, type: 'tool-call' }
}

const add = { action: 'add', content: '不露脸', kind: 'about_you' }

describe('memoryNotesFromParts (hc-1016 记下了)', () => {
  it.each([
    ['a direct call (live feed)', part('apex_memory', add)],
    [
      'a bridged call, one entry (reloaded transcript)',
      part('tool_call', { calls: [{ arguments: add, name: 'apex_memory' }] })
    ],
    ['a bridged call without the calls array', part('tool_call', { arguments: add, name: 'apex_memory' })],
    ['args and result as JSON text', part('apex_memory', JSON.stringify(add), ADDED)],
    ['a result already parsed', part('apex_memory', add, JSON.parse(ADDED))]
  ])('reads %s', (_label, raw) => {
    expect(memoryNotesFromParts([raw])).toEqual([{ content: '不露脸', id: ENTRY.id, kind: 'about_you' }])
  })

  it.each([
    ['an entry already remembered', part('apex_memory', add, JSON.stringify({ ...JSON.parse(ADDED), created: false }))],
    ['a refused write', part('apex_memory', add, JSON.stringify({ code: 'sensitive_content', error: '不能记' }))],
    ['a call still running', { ...part('apex_memory', add), result: undefined }],
    ['a forget', part('apex_memory', { action: 'forget', ref: '3f2a9c1d' }, JSON.stringify({ ok: true }))],
    ['the built-in memory tool', part('memory', { action: 'add', content: 'x', target: 'user' })],
    [
      'a bridged batch of two',
      part('tool_call', {
        calls: [
          { arguments: add, name: 'apex_memory' },
          { arguments: {}, name: 'x' }
        ]
      })
    ],
    ['a bridged call to another tool', part('tool_call', { calls: [{ arguments: add, name: 'generate_image' }] })],
    [
      'an unknown kind',
      part('apex_memory', add, JSON.stringify({ ...JSON.parse(ADDED), entry: { ...ENTRY, kind: 'works' } }))
    ],
    ['text', { text: 'apex_memory', type: 'text' }]
  ])('ignores %s', (_label, raw) => {
    expect(memoryNotesFromParts([raw])).toEqual([])
  })

  it('keeps every new entry of the turn in order', () => {
    const second = { ...ENTRY, content: '最近交付了成片', id: 'ab12cd34-0000-4000-8000-000000000002', kind: 'recent' }

    expect(
      memoryNotesFromParts([
        part('apex_memory', add),
        { text: 'done', type: 'text' },
        part('apex_memory', { ...add, kind: 'recent' }, JSON.stringify({ created: true, entry: second, ok: true }))
      ]).map(note => note.content)
    ).toEqual(['不露脸', '最近交付了成片'])
    expect(memoryNotesFromParts(undefined)).toEqual([])
  })
})
