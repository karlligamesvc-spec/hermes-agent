/**
 * hc-1087 多助手二期 R2: a send that names another assistant with `@` is a
 * relay (接力, L10) — 「@小红书文案 按这个选题写 3 个标题」 goes to 小红书文案,
 * not to the assistant on screen. It never reaches this thread: the composer
 * middleware cancels the send (the text stays in the composer) and puts up
 * the confirm card (L2, L6); 「交给它」 starts the relay and clears the
 * composer, 「先不」 leaves the text there to edit.
 *
 * What goes along (L4): the sentence without the `@名字`, the thread's last
 * reply (its files and links with it), and the files attached to the send.
 *
 * Registered only while relay is on (use-handoff-screens.ts), ahead of the
 * single-thread middleware: a send outside the thread (an earlier
 * conversation, the thread still opening, an assistant switch landing) is
 * left to that one, which refuses it as before.
 */

import type { ComposerDraft } from '@/app/chat/composer/contrib'
import { chatMessageText } from '@/lib/chat-messages/parts'
import type { ChatMessage } from '@/lib/chat-messages/types'
import { replyAttachments } from '@/lib/handoff-text'
import { visibleReplyText } from '@/lib/reply-markers'
import { clearComposerAttachments, clearComposerDraft, type ComposerAttachment } from '@/store/composer'
import { $mainThread, isMainThreadStoredId } from '@/store/main-thread'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import { $messages, $selectedStoredSessionId, $sessions } from '@/store/session'
import { $botRoster, $currentBotProfile, type ApexBot } from '@/store/single-thread-bots'
import { type HandoffPrevious, isHandoffMode } from '@/store/single-thread-handoff'
import { proposeHandoff } from '@/store/single-thread-handoff-confirm'

export interface HandoffMention {
  bot: ApexBot
  /** The sentence without the `@名字`. */
  ask: string
}

const AT_SIGNS = ['@', '＠']

/** After the name: the end, a space or punctuation (「@小红书文案，写标题」). */
const NAME_END_RE = /^(?:$|[\s\p{P}])/u

/**
 * The other assistant a sentence names with `@名字` — at its start or after a
 * space, the name as the roster shows it (any case), the longest one when
 * names overlap — and the sentence without it. Null: it names none.
 */
export function handoffMention(text: string, roster: readonly ApexBot[], self: string): HandoffMention | null {
  const others = roster
    .filter(bot => bot.profile !== normalizeProfileKey(self) && bot.name.trim())
    .sort((a, b) => b.name.length - a.name.length)

  for (let index = 0; index < text.length; index += 1) {
    if (!AT_SIGNS.includes(text[index]!) || (index > 0 && !/\s/.test(text[index - 1]!))) {
      continue
    }

    const rest = text.slice(index + 1)

    const bot = others.find(
      candidate =>
        rest.slice(0, candidate.name.length).toLocaleLowerCase() === candidate.name.toLocaleLowerCase() &&
        NAME_END_RE.test(rest.slice(candidate.name.length))
    )

    if (bot) {
      const before = text.slice(0, index).trimEnd()
      const after = rest.slice(bot.name.length).replace(/^[\s,，、:：]+/, '')

      return { ask: [before, after].filter(Boolean).join(' ').trim(), bot }
    }
  }

  return null
}

/** The thread's last finished reply (what 「上面那条结果」 is), or null. */
export function lastReply(messages: readonly ChatMessage[]): null | { id: string; text: string } {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!

    if (message.role !== 'assistant' || message.hidden || message.pending) {
      continue
    }

    const text = visibleReplyText(chatMessageText(message)).trim()

    if (text) {
      return { id: message.id, text }
    }
  }

  return null
}

/** The previous result as it goes along: the reply, its files and links, and the files attached to the send. */
export function mentionPrevious(
  reply: null | { text: string },
  attachments: readonly ComposerAttachment[] = []
): HandoffPrevious | null {
  const seen = replyAttachments(reply?.text ?? '')
  const attached = attachments.filter(item => item.kind !== 'url' && item.path).map(item => item.path!)
  const attachedLinks = attachments.filter(item => item.kind === 'url').map(item => item.detail || item.label)
  const files = [...attached, ...seen.files]
  const links = [...attachedLinks.filter(link => /^https?:\/\//i.test(link)), ...seen.links]

  return reply || files.length || links.length ? { files, links, text: reply?.text ?? '' } : null
}

/** The send is in the assistant's own thread (or its empty thread, before the first message). */
function inThread(): boolean {
  const thread = $mainThread.get()
  const storedId = $selectedStoredSessionId.get()

  if (thread.status === 'absent') {
    return !storedId
  }

  return thread.status === 'found' && Boolean(storedId) && isMainThreadStoredId(storedId!, thread, $sessions.get())
}

/** The middleware: a send naming another assistant becomes the confirm card; everything else passes through. */
export function handoffMentionSend(draft: ComposerDraft): ComposerDraft | null {
  const from = $currentBotProfile.get()

  if (!isHandoffMode() || normalizeProfileKey($activeGatewayProfile.get()) !== from || !inThread()) {
    return draft
  }

  const mention = handoffMention(draft.text, $botRoster.get(), from)

  if (!mention) {
    return draft
  }

  const reply = lastReply($messages.get())

  proposeHandoff(
    {
      ask: mention.ask,
      from: { messageId: reply?.id ?? null, profile: from, storedSessionId: $selectedStoredSessionId.get() },
      previous: mentionPrevious(reply, draft.attachments),
      to: mention.bot.profile
    },
    {
      onStarted: () => {
        clearComposerDraft()
        clearComposerAttachments()
      },
      origin: 'mention'
    }
  )

  return null
}
