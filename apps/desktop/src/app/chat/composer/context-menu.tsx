import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { IM_ENTRY_ROUTE } from '@/app/routes'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Kbd } from '@/components/ui/kbd'
import { useI18n } from '@/i18n'
import { type IconComponent, ImageIcon, MessageCircle, Package, Sparkles, Video } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { GHOST_ICON_BTN } from './controls'
import { requestComposerFocus, requestComposerInsert } from './focus'
import { SkillBrowseDialog } from './skill-browse-dialog'
import { type SkillScope, useSkillCatalog } from './skill-catalog'
import type { ChatBarState } from './types'

// hc-572 made the composer "+" a unified capability entry (aligning with
// Navos) instead of just an attachment picker. hc-572-followup (real-machine
// feedback, both rounds): the file/folder/image/paste-image/URL/prompt-snippet
// pickers were dropped from this menu entirely — the composer already accepts
// drag-and-drop and paste for all of that (see composer/index.tsx's
// onDrop/onPaste handlers), so the buttons were pure redundant chrome; and the
// "enabled skills" zone, which originally listed every enabled skill at the
// top level, collapsed to a single row after real use showed a long enable
// list buries everything below it. The menu is now three short zones: (1)
// generate image/video, (2) two skill rows — enabled / unused — that both open
// the same browse dialog (see skill-browse-dialog.tsx), (3) connectors.
// Enablement is global (reuses the Skills-page toggle) — flip a skill in the
// browse dialog and its row's count updates immediately.
export function ContextMenu({ state }: ContextMenuProps) {
  const { t } = useI18n()
  const c = t.composer
  const cap = c.capabilities
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const [browseOpen, setBrowseOpen] = useState(false)
  const [browseScope, setBrowseScope] = useState<SkillScope>('enabled')

  // Seed the composer with a generation opener and focus it, then close the
  // menu. Prefill (not auto-send) so the user finishes describing the idea —
  // the ladder's stage 0. The agent picks it up and returns the first card.
  const startGeneration = (starter: string) => {
    requestComposerInsert(starter, { mode: 'block', target: 'main' })
    requestComposerFocus('main')
    setMenuOpen(false)
  }

  const openBrowse = (scope: SkillScope) => {
    setBrowseScope(scope)
    setBrowseOpen(true)
  }

  // Skills load lazily the first time the menu or its browse dialog opens.
  const catalog = useSkillCatalog(menuOpen || browseOpen, {
    enabled: t.skills.skillEnabled,
    disabled: t.skills.skillDisabled,
    appliesToNewSessions: t.skills.appliesToNewSessions,
    failedToUpdate: t.skills.failedToUpdate,
    loadFailed: t.skills.skillsLoadFailed
  })

  return (
    <>
      <DropdownMenu onOpenChange={setMenuOpen} open={menuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={state.tools.label}
            className={cn(
              GHOST_ICON_BTN,
              'data-[state=open]:bg-(--chrome-action-hover) data-[state=open]:text-foreground'
            )}
            disabled={!state.tools.enabled}
            size="icon"
            title={state.tools.label}
            type="button"
            variant="ghost"
          >
            <Codicon name="add" size="1rem" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64" side="top" sideOffset={10}>
          {/* Zone 1 — generate image / video. The generation entry lives in the
              unified "+" menu: picking one injects a stage-0 opener into the
              composer and kicks off the ladder (no param/model chips here — the
              ladder's own cards carry those). */}
          <DropdownMenuLabel className="text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground/85">
            {cap.generateLabel}
          </DropdownMenuLabel>
          <ContextMenuItem icon={ImageIcon} onSelect={() => startGeneration(cap.generateImageStarter)}>
            {cap.generateImage}
          </ContextMenuItem>
          <ContextMenuItem icon={Video} onSelect={() => startGeneration(cap.generateVideoStarter)}>
            {cap.generateVideo}
          </ContextMenuItem>

          <DropdownMenuSeparator />

          {/* Zone 2 — skills, collapsed into two rows (enabled / unused). Both
              open the same search/browse dialog, defaulting to that row's half. */}
          <DropdownMenuItem onSelect={() => openBrowse('enabled')}>
            <Sparkles className="text-primary!" />
            <span className="min-w-0 flex-1 truncate">{cap.enabledLabel}</span>
            {catalog.skills ? (
              <span className="text-[0.7rem] tabular-nums text-(--ui-text-tertiary)">{catalog.enabled.length}</span>
            ) : null}
            <Codicon className="text-(--ui-text-tertiary)" name="chevron-right" size="0.875rem" />
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openBrowse('disabled')}>
            <Package />
            <span className="min-w-0 flex-1 truncate">{cap.unused}</span>
            {catalog.skills ? (
              <span className="text-[0.7rem] tabular-nums text-(--ui-text-tertiary)">{catalog.disabled.length}</span>
            ) : null}
            <Codicon className="text-(--ui-text-tertiary)" name="chevron-right" size="0.875rem" />
          </DropdownMenuItem>

          {/* Zone 3 — connectors (IM channels). */}
          <DropdownMenuItem onSelect={() => navigate(IM_ENTRY_ROUTE)}>
            <MessageCircle />
            <span className="min-w-0 flex-1 truncate">{cap.connectors}</span>
            <span className="truncate text-[0.7rem] text-(--ui-text-tertiary)">{cap.connectorsHint}</span>
            <Codicon className="text-(--ui-text-tertiary)" name="chevron-right" size="0.875rem" />
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <div className="px-2 py-1 text-[0.7rem] text-muted-foreground/80">
            {c.tipPre}
            <Kbd size="sm">@</Kbd>
            {c.tipPost}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      <SkillBrowseDialog catalog={catalog} initialScope={browseScope} onOpenChange={setBrowseOpen} open={browseOpen} />
    </>
  )
}

export function ContextMenuItem({ children, disabled, icon: Icon, onSelect }: ContextMenuItemProps) {
  return (
    <DropdownMenuItem disabled={disabled} onSelect={onSelect}>
      <Icon />
      <span>{children}</span>
    </DropdownMenuItem>
  )
}

interface ContextMenuItemProps {
  children: string
  disabled?: boolean
  icon: IconComponent
  onSelect?: () => void
}

interface ContextMenuProps {
  state: ChatBarState
}
