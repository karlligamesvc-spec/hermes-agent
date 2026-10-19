import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { translateBots } from './i18n-test-helper'
import type { GroupMember } from './types'

// A member's question in a Bot room shows each choice exactly as the backend
// sent it. A question with no better answer (`recommended: false`) arrives
// with no wire marker, so no button may carry a label: the card never marks a
// choice by its position.

const { host } = vi.hoisted(() => ({ host: {} as Record<string, unknown> }))

vi.mock('@hermes/plugin-sdk', async () => {
  const { pluginSdkMock } = await import('./group-test-utils')
  const base = await pluginSdkMock(host)

  return {
    ...base,
    Button: (props: React.ComponentProps<'button'>) => <button type="button" {...props} />,
    cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
    Codicon: ({ name }: { name: string }) => <span aria-hidden data-icon={name} />,
    Input: (props: React.ComponentProps<'input'>) => <input {...props} />,
    usePluginI18n: () => translateBots
  }
})

afterEach(cleanup)

const MEMBERS: GroupMember[] = [{ name: 'research', title: 'Research' }]

async function choiceButtons(choices: string[]) {
  const { GroupClarifyCard } = await import('./group-chat-parts')

  const { container } = render(
    <GroupClarifyCard
      entry={{
        at: 1,
        choices: [],
        group: 'Room',
        kind: 'clarify',
        member: 'research',
        memberKey: 'research',
        multiSelect: false,
        question: '',
        questions: [{ choices, multi_select: false, qid: 'q0', question: 'What do you film?' }],
        requestId: 'request-1'
      }}
      members={MEMBERS}
    />
  )

  return [...container.querySelectorAll('button')].map(button => button.textContent).filter(text => text !== '')
}

it('labels no choice of a question that arrives unmarked', async () => {
  const buttons = await choiceButtons(['Vlogs', 'Skits'])

  expect(buttons.slice(0, 2)).toEqual(['Vlogs', 'Skits'])
  expect(buttons.join(' ')).not.toMatch(/Recommended|推荐/)
})
