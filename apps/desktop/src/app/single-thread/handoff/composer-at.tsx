/**
 * hc-1087 多助手二期 R2: our own `@` list (L10, prototype v2 ⑩). In the
 * single-thread composer while relay is on, `@` lists only the user's other
 * assistants and what each one handles (its 「分工」, roles.ts); picking one
 * puts `@名字` in the sentence, and sending it is a relay (mention.ts). File
 * and folder references, and upstream Bot Mode's handles (hc-1085 keeps those
 * out of product mode), are not offered there.
 *
 * The composer imports its `@` hook and its list from here (one import line):
 * anywhere else — relay off, developer mode, the HUD bar, a session tile — both
 * hand back the composer's own, unchanged.
 */

import type { Unstable_TriggerItem } from '@assistant-ui/core'
import { useStore } from '@nanostores/react'
import { computed } from 'nanostores'
import { type ComponentProps, useCallback, useEffect } from 'react'

import { COMPLETION_DRAWER_BELOW_CLASS, COMPLETION_DRAWER_CLASS } from '@/app/chat/composer/completion-drawer'
import { useAtCompletions as useComposerAtCompletions } from '@/app/chat/composer/hooks/use-at-completions'
import { type CompletionEntry, useLiveCompletionAdapter } from '@/app/chat/composer/hooks/use-live-completion-adapter'
import { useSingleThreadComposer } from '@/app/chat/composer/single-thread-gate'
import { ComposerTriggerPopover as ComposerOwnPopover } from '@/app/chat/composer/trigger-popover'
import { ApexAvatar } from '@/components/apex-avatar'
import { singleThreadHandoffCopyNow, useSingleThreadHandoffCopy } from '@/i18n/single-thread-handoff'
import { cn } from '@/lib/utils'
import { $botRoster, $currentBotProfile, type ApexBot } from '@/store/single-thread-bots'
import { $handoffMode, $handoffs, handoffsTo, isHandoffActive, isHandoffInTurn } from '@/store/single-thread-handoff'

import { $botRoles, refreshBotRoles } from './roles'

/** Marks a row of our list (the profile it hands to). */
export const HANDOFF_ITEM_PROFILE = 'handoffProfile'

interface HandoffItemMeta extends Record<string, string> {
  display: string
  meta: string
  rawText: string
  insertId: string
  icon: string
  [HANDOFF_ITEM_PROFILE]: string
}

type AtCompletionsOptions = Parameters<typeof useComposerAtCompletions>[0]

/** The line under a name: what it handles (APEX: everything), and that a relay to it would queue. */
export function handoffRoleLine(bot: ApexBot, role: null | string | undefined, busy: boolean): string {
  const copy = singleThreadHandoffCopyNow()
  const line = bot.isApex ? copy.apexRole : role || copy.noRole

  return busy ? `${line} · ${copy.busyHint}` : line
}

/** The assistants a `@` query lists: every other one on the roster whose name holds the query. */
export function handoffCandidates(roster: readonly ApexBot[], self: string, query: string): ApexBot[] {
  const wanted = query.trim().toLocaleLowerCase()

  return roster.filter(bot => bot.profile !== self && (!wanted || bot.name.toLocaleLowerCase().includes(wanted)))
}

/** The `@` source: ours while relay is on in the single-thread composer, the composer's own otherwise. */
export function useAtCompletions(options: AtCompletionsOptions): ReturnType<typeof useComposerAtCompletions> {
  const own = useComposerAtCompletions(options)
  const ours = useHandoffAtCompletions(options.gateway)

  return ours ?? own
}

let listChanges = 0

/** Bumps when the roster, a role, the assistant on screen or the queue changes: an open list reads again. */
const $listEpoch = computed([$botRoster, $botRoles, $currentBotProfile, $handoffs], () => ++listChanges)

function useHandoffAtCompletions(gateway: AtCompletionsOptions['gateway']) {
  const handoffMode = useStore($handoffMode)
  const singleThread = useSingleThreadComposer()
  const on = handoffMode && singleThread
  const roster = useStore($botRoster)
  const self = useStore($currentBotProfile)
  const roles = useStore($botRoles)
  const handoffs = useStore($handoffs)

  useEffect(() => {
    if (on && gateway) {
      void refreshBotRoles(
        (method, params) => gateway.request(method, params),
        roster.map(bot => bot.profile)
      )
    }
  }, [gateway, on, roster])

  const fetcher = useCallback(
    async (query: string) => {
      const items: CompletionEntry[] = handoffCandidates(roster, self, query).map(bot => ({
        display: bot.name,
        meta: handoffRoleLine(bot, roles[bot.profile]?.role, handoffsTo(bot.profile, handoffs).some(isHandoffActive)),
        text: bot.profile
      }))

      return { items, query }
    },
    [handoffs, roles, roster, self]
  )

  const toItem = useCallback(
    (entry: CompletionEntry): Unstable_TriggerItem => {
      const bot = roster.find(candidate => candidate.profile === entry.text)!

      const metadata: HandoffItemMeta = {
        display: bot.name,
        [HANDOFF_ITEM_PROFILE]: bot.profile,
        icon: 'simple',
        insertId: '',
        meta: String(entry.meta ?? ''),
        rawText: `@${bot.name}`
      }

      return { description: metadata.meta, id: `handoff:${bot.profile}`, label: bot.name, metadata, type: 'simple' }
    },
    [roster]
  )

  const adapter = useLiveCompletionAdapter({
    debounceMs: 0,
    enabled: on,
    epoch: useStore($listEpoch),
    fetcher,
    isCached: () => true,
    toItem
  })

  return on ? adapter : null
}

type PopoverProps = ComponentProps<typeof ComposerOwnPopover>

/** The `@` list: ours while relay is on in the single-thread composer, the composer's own otherwise. */
export function ComposerTriggerPopover(props: PopoverProps) {
  const handoffMode = useStore($handoffMode)
  const singleThread = useSingleThreadComposer()

  return handoffMode && singleThread && props.kind === '@' ? (
    <HandoffPicker {...props} />
  ) : (
    <ComposerOwnPopover {...props} />
  )
}

function HandoffPicker({ activeIndex, items, onHover, onPick, placement = 'top' }: PopoverProps) {
  const copy = useSingleThreadHandoffCopy()
  const roster = useStore($botRoster)
  const self = useStore($currentBotProfile)
  const handoffs = useStore($handoffs)
  // The assistant on screen is working on a relay itself: it cannot hand on (L3, R1's 'nested').
  const working = handoffsTo(self, handoffs).find(isHandoffInTurn)
  const selfName = roster.find(bot => bot.profile === self)?.name ?? ''

  const rows = items.flatMap(item => {
    const profile = (item.metadata as Partial<HandoffItemMeta> | undefined)?.[HANDOFF_ITEM_PROFILE]
    const bot = roster.find(candidate => candidate.profile === profile)

    return bot ? [{ bot, item }] : []
  })

  return (
    <div
      aria-label={copy.pickerTitle}
      className={cn(placement === 'bottom' ? COMPLETION_DRAWER_BELOW_CLASS : COMPLETION_DRAWER_CLASS, 'w-96')}
      data-handoff-picker=""
      data-slot="composer-completion-drawer"
      data-state="open"
      onMouseDown={event => event.preventDefault()}
      role="listbox"
    >
      <div className="select-none px-2 pb-1 pt-1 text-xs text-(--ui-text-tertiary)">{copy.pickerTitle}</div>
      {working ? (
        <p className="m-0 px-2 py-1.5 text-sm text-(--ui-text-secondary)">
          {copy.nestedNote(selfName, working.from.name || working.from.profile)}
        </p>
      ) : rows.length === 0 ? (
        <p className="m-0 px-2 py-1.5 text-sm text-(--ui-text-tertiary)">{copy.noMatch}</p>
      ) : (
        rows.map(({ bot, item }, index) => (
          <button
            aria-selected={index === activeIndex}
            className="flex w-full cursor-default select-none items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-hidden transition-colors hover:bg-(--ui-bg-tertiary) data-[highlighted]:bg-(--ui-bg-tertiary)"
            data-handoff-profile={bot.profile}
            data-highlighted={index === activeIndex ? '' : undefined}
            key={item.id}
            onClick={() => onPick(item)}
            onMouseEnter={() => onHover(index)}
            role="option"
            type="button"
          >
            <ApexAvatar className="size-6" color={bot.color} shape={bot.shape} />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-semibold leading-5 text-foreground">{bot.name}</span>
              <span className="truncate text-xs leading-4 text-(--ui-text-tertiary)">{item.description}</span>
            </span>
          </button>
        ))
      )}
      {!working && rows.length > 0 && (
        <div className="mt-1 border-t border-(--ui-stroke-tertiary) px-2 pb-0.5 pt-1.5 text-xs text-(--ui-text-tertiary)">
          {copy.pickerFoot}
        </div>
      )}
    </div>
  )
}
