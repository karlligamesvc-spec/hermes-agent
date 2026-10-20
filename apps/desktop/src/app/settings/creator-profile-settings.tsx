import { useStore } from '@nanostores/react'
import { type KeyboardEvent, useEffect, useState } from 'react'

import {
  CREATOR_CONTENT_TYPES,
  CREATOR_OTHER_MAX_CHARS,
  CREATOR_PAIN_POINTS,
  CREATOR_PLATFORMS
} from '@/app/business-workspace/components/creator-intake-cards'
import { CREATOR_INTAKE_COPY } from '@/app/business-workspace/creator-intake-copy'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { DesktopCreatorPlatform, DesktopCreatorProfilePatch } from '@/global'
import { useI18n } from '@/i18n'
import { Video } from '@/lib/icons'
import { isSubmitEnter } from '@/lib/ime'
import { cn } from '@/lib/utils'
import { $authState } from '@/store/auth'
import { $creatorProfile, creatorProfileFor, loadCreatorProfile, saveCreatorProfile } from '@/store/creator-profile'

import { CONTROL_TEXT, EMPTY_SELECT_VALUE } from './constants'
import { ListRow, SectionHeading } from './primitives'

const OTHER = 'other'

/**
 * 创作档案 — the three first-use answers (hc-991), editable after the Start-page
 * cards. Same account API as the cards; a change reaches new local chats at
 * once and cloud assistants at their next restart (the copy says so).
 */
export function CreatorProfileSettings() {
  const { locale } = useI18n()
  const copy = CREATOR_INTAKE_COPY[locale]
  const s = copy.settings
  const { accountId, status } = useStore($authState)
  const state = useStore($creatorProfile)
  const profile = creatorProfileFor(state, accountId)
  const [saveState, setSaveState] = useState<'failed' | 'idle' | 'saved' | 'saving'>('idle')
  const [otherOpen, setOtherOpen] = useState(false)
  const [otherDraft, setOtherDraft] = useState('')
  const storedOther = profile?.answers.contentTypeOther ?? ''

  useEffect(() => {
    if (status === 'signed-in') {
      void loadCreatorProfile(accountId)
    }
  }, [accountId, status])

  useEffect(() => setOtherDraft(storedOther), [storedOther])

  const save = async (patch: DesktopCreatorProfilePatch) => {
    setSaveState('saving')
    setSaveState((await saveCreatorProfile(accountId, patch)) ? 'saved' : 'failed')
  }

  if (!profile) {
    return (
      <div data-creator-profile-settings="">
        <SectionHeading icon={Video} title={s.title} />
        <p className="p5-section-intro">{state.status === 'loading' ? s.loading : s.unavailable}</p>
      </div>
    )
  }

  const { answers } = profile
  const contentValue = otherOpen ? OTHER : (answers.contentType ?? EMPTY_SELECT_VALUE)

  const pickContent = (value: string) => {
    if (value === OTHER) {
      setOtherOpen(true)

      return
    }

    setOtherOpen(false)
    void save({ contentType: value === EMPTY_SELECT_VALUE ? null : (value as (typeof CREATOR_CONTENT_TYPES)[number]) })
  }

  const commitOther = () => {
    const text = otherDraft.trim()

    if (text && (answers.contentType !== OTHER || text !== storedOther)) {
      setOtherOpen(false)
      void save({ contentType: OTHER, contentTypeOther: text })
    }
  }

  const handleOtherKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isSubmitEnter(event)) {
      event.preventDefault()
      commitOther()
    }
  }

  const togglePlatform = (id: DesktopCreatorPlatform) => {
    const next = answers.platforms.includes(id) ? answers.platforms.filter(p => p !== id) : [...answers.platforms, id]

    void save({ platforms: CREATOR_PLATFORMS.filter(p => next.includes(p)) })
  }

  const showOther = otherOpen || answers.contentType === OTHER

  return (
    <div data-creator-profile-settings="">
      <SectionHeading
        aside={
          saveState !== 'idle' && (
            <span
              className={cn('text-xs', saveState === 'failed' ? 'text-destructive' : 'text-(--ui-text-tertiary)')}
              role={saveState === 'failed' ? 'alert' : 'status'}
            >
              {saveState === 'saving' ? copy.saving : saveState === 'saved' ? s.saved : s.saveFailed}
            </span>
          )
        }
        icon={Video}
        title={s.title}
      />
      <p className="p5-section-intro">{s.intro}</p>

      <div className="p5-card p5-rows mt-3.5">
        <ListRow
          action={
            <Select disabled={saveState === 'saving'} onValueChange={pickContent} value={contentValue}>
              <SelectTrigger aria-label={s.contentType} className={CONTROL_TEXT}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={EMPTY_SELECT_VALUE}>{s.notSet}</SelectItem>
                {CREATOR_CONTENT_TYPES.map(id => (
                  <SelectItem key={id} value={id}>
                    {copy.contentTypes[id]}
                  </SelectItem>
                ))}
                <SelectItem value={OTHER}>{copy.otherPlaceholder}</SelectItem>
              </SelectContent>
            </Select>
          }
          below={
            showOther && (
              <Input
                aria-label={copy.otherPlaceholder}
                className={cn(CONTROL_TEXT, 'mt-2 max-w-sm')}
                maxLength={CREATOR_OTHER_MAX_CHARS}
                onBlur={commitOther}
                onChange={event => setOtherDraft(event.target.value)}
                onKeyDown={handleOtherKey}
                placeholder={copy.otherPlaceholder}
                value={otherDraft}
              />
            )
          }
          title={s.contentType}
        />
        <ListRow
          action={
            <div aria-label={s.platforms} className="flex flex-wrap justify-end gap-1.5" role="group">
              {CREATOR_PLATFORMS.map(id => {
                const on = answers.platforms.includes(id)

                return (
                  <Button
                    aria-pressed={on}
                    disabled={saveState === 'saving'}
                    key={id}
                    onClick={() => togglePlatform(id)}
                    size="xs"
                    type="button"
                    variant={on ? 'default' : 'outline'}
                  >
                    {copy.platforms[id]}
                  </Button>
                )
              })}
            </div>
          }
          title={s.platforms}
        />
        <ListRow
          action={
            <Select
              disabled={saveState === 'saving'}
              onValueChange={value =>
                void save({
                  painPoint: value === EMPTY_SELECT_VALUE ? null : (value as (typeof CREATOR_PAIN_POINTS)[number])
                })
              }
              value={answers.painPoint ?? EMPTY_SELECT_VALUE}
            >
              <SelectTrigger aria-label={s.painPoint} className={CONTROL_TEXT}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={EMPTY_SELECT_VALUE}>{s.notSet}</SelectItem>
                {CREATOR_PAIN_POINTS.map(id => (
                  <SelectItem key={id} value={id}>
                    {copy.painPoints[id]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
          title={s.painPoint}
        />
      </div>
    </div>
  )
}
