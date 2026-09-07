import { useState } from 'react'
import { useNavigate } from 'react-router'

import { IM_ENTRY_ROUTE } from '@/app/routes'
import { composerPanelCard } from '@/components/chat/composer-dock'
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

import { useComposerAttachmentProviders } from './contrib'
import { GHOST_ICON_BTN } from './controls'
import { requestComposerFocus, requestComposerInsert } from './focus'
import { SkillBrowseDialog } from './skill-browse-dialog'
import { type SkillScope, useSkillCatalog } from './skill-catalog'
import type { ChatBarState } from './types'


// hc-572 made the composer "+" a unified CAPABILITY entry instead of an
// attachment picker. hc-572-followup (real-machine feedback, both rounds): the
// file/folder/image/paste-image/URL/prompt-snippet pickers were dropped from
// this menu entirely — the composer already accepts drag-and-drop and paste for
// all of that (see composer/index.tsx's onDrop/onPaste handlers), so the buttons
// were pure redundant chrome; and the "enabled skills" zone, which originally
// listed every enabled skill at the top level, collapsed to a single row after
// real use showed a long enable list buries everything below it. The menu is
// three short zones: (1) generate image/video, (2) two skill rows — enabled /
// unused — that both open the same browse dialog (see skill-browse-dialog.tsx),
// (3) connectors. Enablement is global (reuses the Skills-page toggle) — flip a
// skill in the browse dialog and its row's count updates immediately.
//
// The `composer.attachments` contribution area (upstream's plugin seam, see
// ./contrib) keeps its zone at the bottom: it carries whatever a PLUGIN
// registers, not the fixed attachment chrome the followup removed, so dropping
// it would break an extension point rather than simplify the menu.
export function ContextMenu({ state }: ContextMenuProps) {
  const { t } = useI18n()
  const c = t.composer
  const cap = c.capabilities
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const [browseOpen, setBrowseOpen] = useState(false)
  const [browseScope, setBrowseScope] = useState<SkillScope>('enabled')
  const attachmentProviders = useComposerAttachmentProviders()

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
            <Codicon name="add" size="0.875rem" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className={cn('w-64', composerPanelCard)} side="top" sideOffset={6}>
          {/* Zone 1 — generate image / video. The generation entry lives in the
              unified "+" menu: picking one injects a stage-0 opener into the
              composer and kicks off the ladder (no param/model chips here — the
              ladder's own cards carry those). */}
          <DropdownMenuLabel className="px-2 pb-0.5 pt-0.5 text-[0.625rem] font-semibold uppercase tracking-wider text-(--ui-text-tertiary)">
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
          <DropdownMenuItem className={CAPABILITY_ROW} onSelect={() => openBrowse('enabled')}>
            <Sparkles className="text-primary!" />
            <span className="min-w-0 flex-1 truncate">{cap.enabledLabel}</span>
            {catalog.skills ? (
              <span className="text-[0.7rem] tabular-nums text-(--ui-text-tertiary)">{catalog.enabled.length}</span>
            ) : null}
            <Codicon className="text-(--ui-text-tertiary)" name="chevron-right" size="0.875rem" />
          </DropdownMenuItem>
          <DropdownMenuItem className={CAPABILITY_ROW} onSelect={() => openBrowse('disabled')}>
            <Package />
            <span className="min-w-0 flex-1 truncate">{cap.unused}</span>
            {catalog.skills ? (
              <span className="text-[0.7rem] tabular-nums text-(--ui-text-tertiary)">{catalog.disabled.length}</span>
            ) : null}
            <Codicon className="text-(--ui-text-tertiary)" name="chevron-right" size="0.875rem" />
          </DropdownMenuItem>

          {/* Zone 3 — connectors (IM channels). */}
          <DropdownMenuItem className={CAPABILITY_ROW} onSelect={() => navigate(IM_ENTRY_ROUTE)}>
            <MessageCircle />
            <span className="min-w-0 flex-1 truncate">{cap.connectors}</span>
            <span className="truncate text-[0.7rem] text-(--ui-text-tertiary)">{cap.connectorsHint}</span>
            <Codicon className="text-(--ui-text-tertiary)" name="chevron-right" size="0.875rem" />
          </DropdownMenuItem>

          {attachmentProviders.length > 0 && <DropdownMenuSeparator />}
          {attachmentProviders.map(provider => (
            <DropdownMenuItem
              className={CAPABILITY_ROW}
              key={provider.key}
              onSelect={() => void provider.run({ insertText: text => requestComposerInsert(text, { target: 'main' }) })}
            >
              <Codicon name={provider.icon ?? 'plug'} size="0.875rem" />
              <span>{provider.label}</span>
            </DropdownMenuItem>
          ))}

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

// Match the / · @ completion rows exactly (font size + highlight).
const CAPABILITY_ROW = 'text-[length:var(--conversation-tool-font-size)] focus:bg-(--ui-bg-tertiary)'

export function ContextMenuItem({ children, disabled, icon: Icon, onSelect }: ContextMenuItemProps) {
  return (
    <DropdownMenuItem className={CAPABILITY_ROW} disabled={disabled} onSelect={onSelect}>
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
