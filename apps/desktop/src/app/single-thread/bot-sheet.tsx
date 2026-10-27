/**
 * hc-1078 (multi-bot M2): the sheet behind the sidebar's 「+」 and the 「改名或换样子」 menu item,
 * as prototype v2 artboard ⑦ draws it: a live preview of the sidebar row, 「叫它什么」 (required,
 * any language, 12 characters), six shapes and six colors (APEX's purple is not one of them), and
 * the count of assistants left before the limit.
 *
 * APEX's sheet has the name field only: its look is fixed (K6). Saving a new one creates the
 * profile (store/single-thread-bot-ops.ts) and hands its name to `onCreated`, which opens its
 * conversation; an edit is saved against the revision read when the sheet opened, and a conflict
 * reloads the latest look instead of overwriting it.
 */

import { useEffect, useRef, useState } from 'react'

import { APEX_AVATAR_COLOR } from '@/components/apex-avatar'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { type BotColorId, type BotShapeId, useSingleThreadBotsCopy } from '@/i18n/single-thread-bots'
import { cn } from '@/lib/utils'
import {
  type ApexBotLook,
  BOT_NAME_MAX,
  type BotNameProblem,
  botNameProblem,
  BotOpError,
  botsLeft,
  cleanBotName,
  createBot,
  readBotLook,
  saveBotLook
} from '@/store/single-thread-bot-ops'

import { BOT_COLORS, BOT_SHAPES, BotFace, isBotColor, isBotShape } from './bot-face'

export type BotSheetTarget =
  { kind: 'edit'; color?: string; isApex: boolean; name: string; profile: string; shape?: string } | { kind: 'new' }

interface BotSheetProps {
  /** null keeps the sheet closed. */
  target: BotSheetTarget | null
  /** Every other assistant's name (APEX included), so two never share one. */
  takenNames: readonly string[]
  /** How many assistants the sidebar lists now and the limit, both counting APEX. */
  count: number
  max: number
  onClose: () => void
  onCreated: (profile: string) => void
  onSaved: (profile: string) => void
}

/**
 * The round 「+」 beside search atop the sidebar. At the limit it still opens the sheet, whose footer
 * says to delete one first; its label says the same before the click.
 */
export function BotNewButton({ count, max, onOpen }: { count: number; max: number; onOpen: () => void }) {
  const copy = useSingleThreadBotsCopy()
  const label = botsLeft(count, max) > 0 ? copy.newBot : copy.newBotFull(max)

  return (
    <button
      aria-label={label}
      className="grid size-8 place-items-center rounded-full border border-(--ui-stroke-tertiary) bg-(--ui-chat-surface-background) text-(--ui-text-secondary) transition-colors [-webkit-app-region:no-drag] hover:bg-(--ui-control-hover-background)"
      data-single-thread-new-bot={botsLeft(count, max) > 0 ? '' : 'full'}
      onClick={onOpen}
      title={label}
      type="button"
    >
      <Codicon name="add" size="1rem" />
    </button>
  )
}

/** A new assistant starts as prototype ⑦'s does: rounded square, blue. */
const NEW_LOOK = { color: 'blue', shape: 'squircle' } as const satisfies { color: BotColorId; shape: BotShapeId }

export function BotSheet({ target, ...props }: BotSheetProps) {
  const [saving, setSaving] = useState(false)

  return (
    <Dialog onOpenChange={open => !open && !saving && props.onClose()} open={target !== null}>
      {target ? (
        <BotSheetBody
          key={target.kind === 'new' ? 'new' : target.profile}
          onSavingChange={setSaving}
          target={target}
          {...props}
        />
      ) : null}
    </Dialog>
  )
}

function lookFields(target: BotSheetTarget): { color: BotColorId; name: string; shape: BotShapeId } {
  if (target.kind === 'new') {
    return { ...NEW_LOOK, name: '' }
  }

  return {
    color: isBotColor(target.color) ? target.color : NEW_LOOK.color,
    name: target.name,
    shape: isBotShape(target.shape) ? target.shape : NEW_LOOK.shape
  }
}

function BotSheetBody({
  count,
  max,
  onClose,
  onCreated,
  onSaved,
  onSavingChange,
  takenNames,
  target
}: Omit<BotSheetProps, 'target'> & { onSavingChange: (saving: boolean) => void; target: BotSheetTarget }) {
  const copy = useSingleThreadBotsCopy()
  const initial = lookFields(target)
  const [name, setName] = useState(initial.name)
  const [shape, setShape] = useState<BotShapeId>(initial.shape)
  const [color, setColor] = useState<BotColorId>(initial.color)
  const [touched, setTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<null | string>(null)
  // The stored look's revision, which an edit must name; null until read.
  const [revision, setRevision] = useState<null | number>(target.kind === 'new' ? 0 : null)
  const [storedName, setStoredName] = useState(initial.name)
  const editedRef = useRef(false)

  const isNew = target.kind === 'new'
  const isApex = target.kind === 'edit' && target.isApex
  const editProfile = target.kind === 'edit' ? target.profile : null

  function applyStored(look: Partial<ApexBotLook>, fresh: number, force: boolean) {
    setRevision(fresh)

    if (look.name) {
      setStoredName(look.name)
    }

    if (!force && editedRef.current) {
      return
    }

    setName(look.name ?? initial.name)
    setShape(isBotShape(look.shape) ? look.shape : initial.shape)
    setColor(isBotColor(look.color) ? look.color : initial.color)
  }

  // An edit reads the stored look first: the sidebar's copy can be a poll behind.
  useEffect(() => {
    if (!editProfile) {
      return
    }

    let live = true

    readBotLook(editProfile)
      .then(({ look, revision: fresh }) => live && applyStored(look, fresh, false))
      .catch(() => live && setError(copy.saveFailed))

    return () => {
      live = false
    }
    // Read once per sheet; the body remounts for another target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editProfile])

  const cleaned = cleanBotName(name)
  const problem = botNameProblem(name, takenNames)
  const full = isNew && botsLeft(count, max) <= 0
  const disabled = saving || problem !== null || full || revision === null

  function setBusy(next: boolean) {
    setSaving(next)
    onSavingChange(next)
  }

  async function reloadAfterConflict(profile: string) {
    setError(copy.conflict)
    editedRef.current = false
    await readBotLook(profile)
      .then(({ look: latest, revision: fresh }) => applyStored(latest, fresh, true))
      .catch(() => undefined)
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setTouched(true)

    if (disabled || revision === null) {
      return
    }

    setBusy(true)
    setError(null)

    try {
      const done = await persistLook(target, { name: cleaned, shape, color }, { count, max, revision, storedName })

      setBusy(false)

      if (target.kind === 'new') {
        onCreated(done)
      } else {
        onSaved(done)
      }

      onClose()
    } catch (caught) {
      setBusy(false)

      if (caught instanceof BotOpError && caught.kind === 'conflict' && editProfile) {
        await reloadAfterConflict(editProfile)

        return
      }

      setError(isNew ? copy.createFailed : copy.saveFailed)
    }
  }

  function edited<T>(set: (value: T) => void): (value: T) => void {
    return value => {
      editedRef.current = true
      set(value)
    }
  }

  return (
    <DialogContent className="max-w-[28.75rem]" data-single-thread-bot-sheet={isNew ? 'new' : 'edit'}>
      <DialogHeader>
        <DialogTitle>{isNew ? copy.newTitle : copy.editTitle(storedName)}</DialogTitle>
      </DialogHeader>
      <form className="grid gap-3.5" noValidate onSubmit={event => void submit(event)}>
        <BotPreview
          color={isApex ? APEX_AVATAR_COLOR : BOT_COLORS[color]}
          name={cleaned}
          shape={isApex ? 'circle' : shape}
        />
        <BotNameField
          onChange={value => {
            setTouched(true)
            edited(setName)(value)
          }}
          problem={touched ? problem : null}
          value={name}
        />
        {isApex ? null : (
          <BotLookPickers color={color} onColor={edited(setColor)} onShape={edited(setShape)} shape={shape} />
        )}
        {isNew ? (
          <p className="m-0 rounded-[0.625rem] bg-[#F3F0FD] px-3 py-2 text-[0.78125rem] leading-relaxed text-(--ui-text-secondary) dark:bg-[#2C2550]">
            {copy.sharedNote}
          </p>
        ) : null}
        {error ? (
          <p className="m-0 text-xs text-destructive" data-bot-sheet-error="" role="alert">
            {error}
          </p>
        ) : null}
        <BotSheetFooter count={isNew ? count : null} disabled={disabled} max={max} onClose={onClose} saving={saving} />
      </form>
    </DialogContent>
  )
}

/** Create the assistant (its profile name comes back) or save an edit (the same profile comes back). */
async function persistLook(
  target: BotSheetTarget,
  look: ApexBotLook,
  { count, max, revision, storedName }: { count: number; max: number; revision: number; storedName: string }
): Promise<string> {
  if (target.kind === 'new') {
    return createBot(look, { count, max })
  }

  await saveBotLook(target.profile, look, { previousName: storedName, revision })

  return target.profile
}

function BotPreview({ color, name, shape }: { color: string; name: string; shape: BotShapeId }) {
  const copy = useSingleThreadBotsCopy()

  return (
    <div className="flex items-center gap-3.5 rounded-[0.875rem] bg-(--ui-sidebar-surface-background) px-3.5 py-3">
      <BotFace className="size-16" color={color} shape={shape} />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span
          className={cn(
            'truncate text-base font-semibold text-(--ui-text-primary)',
            !name && 'font-medium text-(--ui-text-tertiary)'
          )}
          data-bot-sheet-preview-name=""
        >
          {name || copy.previewEmpty}
        </span>
        <span className="text-xs text-(--ui-text-tertiary)">{copy.previewHint}</span>
      </div>
    </div>
  )
}

/** `problem` is null until the field was typed in: an empty name only disables the button. */
function BotNameField({
  onChange,
  problem,
  value
}: {
  onChange: (value: string) => void
  problem: BotNameProblem | null
  value: string
}) {
  const copy = useSingleThreadBotsCopy()
  const error = problem === 'tooLong' ? copy.nameTooLong(BOT_NAME_MAX) : problem === 'taken' ? copy.nameTaken : null

  return (
    <div className="grid gap-1.5">
      <label className="text-[0.8125rem] font-semibold text-(--ui-text-secondary)" htmlFor="single-thread-bot-name">
        {copy.nameLabel}
      </label>
      <Input
        aria-describedby="single-thread-bot-name-help"
        aria-invalid={error !== null}
        autoFocus
        id="single-thread-bot-name"
        onChange={event => onChange(event.target.value)}
        placeholder={copy.namePlaceholder}
        value={value}
      />
      <span
        className={cn('text-xs text-(--ui-text-tertiary)', error && 'text-destructive')}
        id="single-thread-bot-name-help"
      >
        {error ?? copy.nameHelp}
      </span>
    </div>
  )
}

function BotLookPickers({
  color,
  onColor,
  onShape,
  shape
}: {
  color: BotColorId
  onColor: (color: BotColorId) => void
  onShape: (shape: BotShapeId) => void
  shape: BotShapeId
}) {
  const copy = useSingleThreadBotsCopy()

  return (
    <>
      <div className="grid gap-1.5">
        <span className="text-[0.8125rem] font-semibold text-(--ui-text-secondary)">{copy.shapeLabel}</span>
        <div aria-label={copy.shapeLabel} className="flex flex-wrap gap-2" role="group">
          {BOT_SHAPES.map(id => (
            <button
              aria-pressed={shape === id}
              className={cn(
                'flex w-[3.625rem] flex-col items-center gap-1 rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-chat-surface-background) pt-[0.4375rem] pb-1.5 text-[0.71875rem] text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background)',
                shape === id && 'border-[#6A4CEB] text-(--ui-text-primary) shadow-[inset_0_0_0_1px_#6A4CEB]'
              )}
              data-bot-shape={id}
              key={id}
              onClick={() => onShape(id)}
              type="button"
            >
              <BotFace className="size-[1.625rem]" color={BOT_COLORS[color]} shape={id} />
              <span>{copy.shapes[id]}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-1.5">
        <span className="text-[0.8125rem] font-semibold text-(--ui-text-secondary)">{copy.colorLabel}</span>
        <div aria-label={copy.colorLabel} className="flex gap-2.5" role="group">
          {(Object.keys(BOT_COLORS) as BotColorId[]).map(id => (
            <button
              aria-label={copy.colors[id]}
              aria-pressed={color === id}
              className={cn(
                'size-[1.875rem] rounded-full border-2 border-white shadow-[0_0_0_1px_var(--ui-stroke-tertiary)] dark:border-(--ui-chat-surface-background)',
                color === id && 'shadow-[0_0_0_2px_var(--ui-text-primary)]'
              )}
              data-bot-color={id}
              key={id}
              onClick={() => onColor(id)}
              style={{ background: BOT_COLORS[id] }}
              type="button"
            />
          ))}
        </div>
        <span className="text-xs text-(--ui-text-tertiary)">{copy.colorHelp}</span>
      </div>
    </>
  )
}

/** `count` is null for an edit, which has no limit line. */
function BotSheetFooter({
  count,
  disabled,
  max,
  onClose,
  saving
}: {
  count: null | number
  disabled: boolean
  max: number
  onClose: () => void
  saving: boolean
}) {
  const copy = useSingleThreadBotsCopy()
  const isNew = count !== null
  const made = Math.max(0, (count ?? 0) - 1)
  const left = botsLeft(count ?? 0, max)
  const idle = isNew ? copy.create : copy.save
  const busy = isNew ? copy.creating : copy.saving

  return (
    <DialogFooter className="items-center">
      {isNew ? (
        <span className="mr-auto text-xs text-(--ui-text-tertiary)" data-bot-sheet-left="">
          {left > 0 ? copy.left(made, left) : copy.full(made)}
        </span>
      ) : null}
      <Button disabled={saving} onClick={onClose} type="button" variant="ghost">
        {copy.cancel}
      </Button>
      <Button disabled={disabled} type="submit">
        {saving ? busy : idle}
      </Button>
    </DialogFooter>
  )
}
