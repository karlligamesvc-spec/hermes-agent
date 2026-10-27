/**
 * hc-1078 (multi-bot M2): the sheet behind the sidebar's 「+」 and the 「改名或换样子」 menu item,
 * as prototype v2 artboard ⑦ draws it: a live preview of the sidebar row, 「叫它什么」 (required,
 * any language, 12 characters), six shapes and six colors (hc-1077's tables; APEX's purple is not
 * one of them), and the count of assistants left before the limit.
 *
 * APEX's sheet has the name field only: its look is fixed (K6). Saving a new one creates the
 * profile (store/single-thread-bot-ops.ts) and hands its name to `onCreated`, which opens its
 * conversation; an edit is saved over the `ui_meta.apex` read when the sheet opened, against that
 * read's revision, and a conflict reloads the latest instead of overwriting it.
 */

import { useEffect, useRef, useState } from 'react'

import { ApexAvatar } from '@/components/apex-avatar'
import {
  APEX_AVATAR_COLOR,
  APEX_AVATAR_SHAPES,
  APEX_BOT_COLORS,
  APEX_BOT_DEFAULT_LOOK,
  type ApexAvatarShape,
  type ApexBotColor,
  apexBotColorHex,
  isApexAvatarShape,
  isApexBotColor
} from '@/components/apex-avatar-look'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useSingleThreadBotsCopy } from '@/i18n/single-thread-bots'
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
  readBotMeta,
  saveBotLook,
  type StoredBotMeta
} from '@/store/single-thread-bot-ops'
import type { ApexBot } from '@/store/single-thread-bots'

export type BotSheetTarget = { bot: ApexBot; kind: 'edit' } | { kind: 'new' }

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

/** The palette id of a hex the roster drew (hc-1077 keeps the hex on `ApexBot`). */
function colorIdOf(hex: string): ApexBotColor {
  return APEX_BOT_COLORS.find(color => color.hex.toLowerCase() === hex.toLowerCase())?.id ?? APEX_BOT_DEFAULT_LOOK.color
}

export function BotSheet({ target, ...props }: BotSheetProps) {
  const [saving, setSaving] = useState(false)

  return (
    <Dialog onOpenChange={open => !open && !saving && props.onClose()} open={target !== null}>
      {target ? (
        <BotSheetBody
          key={target.kind === 'new' ? 'new' : target.bot.profile}
          onSavingChange={setSaving}
          target={target}
          {...props}
        />
      ) : null}
    </Dialog>
  )
}

/** A new assistant starts as prototype ⑦'s does (hc-1077's default look); an edit, as the sidebar shows it. */
function lookFields(target: BotSheetTarget): { color: ApexBotColor; name: string; shape: ApexAvatarShape } {
  if (target.kind === 'new') {
    return { ...APEX_BOT_DEFAULT_LOOK, name: '' }
  }

  return { color: colorIdOf(target.bot.color), name: target.bot.name, shape: target.bot.shape }
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
  const [shape, setShape] = useState<ApexAvatarShape>(initial.shape)
  const [color, setColor] = useState<ApexBotColor>(initial.color)
  const [touched, setTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<null | string>(null)
  // What `ui_meta.apex` held when read, and the revision an edit must name; null until read.
  const [revision, setRevision] = useState<null | number>(target.kind === 'new' ? 0 : null)
  const [stored, setStored] = useState<StoredBotMeta>({})
  const [storedName, setStoredName] = useState(initial.name)
  const editedRef = useRef(false)

  const isNew = target.kind === 'new'
  const isApex = target.kind === 'edit' && target.bot.isApex
  const editProfile = target.kind === 'edit' ? target.bot.profile : null

  function applyStored(meta: StoredBotMeta, fresh: number, force: boolean) {
    const storedText = typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : null

    setRevision(fresh)
    setStored(meta)

    if (storedText) {
      setStoredName(storedText)
    }

    if (!force && editedRef.current) {
      return
    }

    setName(storedText ?? initial.name)
    setShape(isApexAvatarShape(meta.shape) ? meta.shape : initial.shape)
    setColor(isApexBotColor(meta.color) ? meta.color : initial.color)
  }

  // An edit reads the stored look first: the sidebar's copy can be a poll behind.
  useEffect(() => {
    if (!editProfile) {
      return
    }

    let live = true

    readBotMeta(editProfile)
      .then(({ meta, revision: fresh }) => live && applyStored(meta, fresh, false))
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
    await readBotMeta(profile)
      .then(({ meta, revision: fresh }) => applyStored(meta, fresh, true))
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
      const done = await persistLook(target, { name: cleaned, shape, color }, { count, max, revision, stored })

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
          color={isApex ? APEX_AVATAR_COLOR : apexBotColorHex(color)}
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
  { count, max, revision, stored }: { count: number; max: number; revision: number; stored: StoredBotMeta }
): Promise<string> {
  if (target.kind === 'new') {
    return createBot(look, { count, max })
  }

  await saveBotLook(target.bot.profile, look, { revision, stored })

  return target.bot.profile
}

function BotPreview({ color, name, shape }: { color: string; name: string; shape: ApexAvatarShape }) {
  const copy = useSingleThreadBotsCopy()

  return (
    <div className="flex items-center gap-3.5 rounded-[0.875rem] bg-(--ui-sidebar-surface-background) px-3.5 py-3">
      <ApexAvatar className="size-16" color={color} shape={shape} />
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
  color: ApexBotColor
  onColor: (color: ApexBotColor) => void
  onShape: (shape: ApexAvatarShape) => void
  shape: ApexAvatarShape
}) {
  const copy = useSingleThreadBotsCopy()

  return (
    <>
      <div className="grid gap-1.5">
        <span className="text-[0.8125rem] font-semibold text-(--ui-text-secondary)">{copy.shapeLabel}</span>
        <div aria-label={copy.shapeLabel} className="flex flex-wrap gap-2" role="group">
          {APEX_AVATAR_SHAPES.map(id => (
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
              {/* Still, as in the prototype: only the preview above blinks. */}
              <ApexAvatar
                className="size-[1.625rem] [&_rect]:animate-none!"
                color={apexBotColorHex(color)}
                shape={id}
              />
              <span>{copy.shapes[id]}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-1.5">
        <span className="text-[0.8125rem] font-semibold text-(--ui-text-secondary)">{copy.colorLabel}</span>
        <div aria-label={copy.colorLabel} className="flex gap-2.5" role="group">
          {APEX_BOT_COLORS.map(({ hex, id }) => (
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
              style={{ background: hex }}
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
