import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { IM_ENTRY_ROUTE, SKILLS_ROUTE } from '@/app/routes'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
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
import {
  Clipboard,
  FileText,
  FolderOpen,
  type IconComponent,
  ImageIcon,
  Link,
  MessageCircle,
  MessageSquareText,
  Package,
  Sparkles,
  Video
} from '@/lib/icons'
import { cn } from '@/lib/utils'

import { GHOST_ICON_BTN } from './controls'
import { requestComposerFocus, requestComposerInsert } from './focus'
import { SkillBrowseDialog } from './skill-browse-dialog'
import { type SkillCatalog, useSkillCatalog } from './skill-catalog'
import type { ChatBarState } from './types'

const SNIPPET_KEYS = ['codeReview', 'implementationPlan', 'explainThis']

// hc-572: the composer "+" is a unified capability entry (aligning with Navos),
// not just an attachment picker. Four zones: (1) upload attachment [existing],
// (2) enabled skills each surfaced at the top level, (3) every UNUSED skill
// collapsed behind one "unused skills" entry that opens a search/browse dialog
// (117 skills never flatten into the menu), (4) connectors. Enablement is global
// (reuses the Skills-page toggle) — flip a skill on in the browse dialog and it
// moves up into the "enabled" zone.
export function ContextMenu({
  state,
  onInsertText,
  onOpenUrlDialog,
  onPasteClipboardImage,
  onPickFiles,
  onPickFolders,
  onPickImages
}: ContextMenuProps) {
  const { t } = useI18n()
  const c = t.composer
  const cap = c.capabilities
  const navigate = useNavigate()
  // Prompt snippets used to be a Radix submenu. That submenu didn't open
  // reliably when the parent menu was positioned at the bottom of the
  // window (composer "+" anchor), so we promoted it to a real Dialog —
  // easier to grow with search / descriptions, and no positioning math.
  const [snippetsOpen, setSnippetsOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [browseOpen, setBrowseOpen] = useState(false)

  // Seed the composer with a generation opener and focus it, then close the
  // menu. Prefill (not auto-send) so the user finishes describing the idea —
  // the ladder's stage 0. The agent picks it up and returns the first card.
  const startGeneration = (starter: string) => {
    requestComposerInsert(starter, { mode: 'block', target: 'main' })
    requestComposerFocus('main')
    setMenuOpen(false)
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
        <DropdownMenuContent
          align="start"
          className="max-h-[min(30rem,var(--radix-dropdown-menu-content-available-height))] w-64 overflow-y-auto"
          side="top"
          sideOffset={10}
        >
          {/* Zone 1 — upload attachment (existing pickers kept intact). */}
          <DropdownMenuLabel className="text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground/85">
            {c.attachLabel}
          </DropdownMenuLabel>
          <ContextMenuItem disabled={!onPickFiles} icon={FileText} onSelect={onPickFiles}>
            {c.files}
          </ContextMenuItem>
          <ContextMenuItem disabled={!onPickFolders} icon={FolderOpen} onSelect={onPickFolders}>
            {c.folder}
          </ContextMenuItem>
          <ContextMenuItem disabled={!onPickImages} icon={ImageIcon} onSelect={onPickImages}>
            {c.images}
          </ContextMenuItem>
          <ContextMenuItem disabled={!onPasteClipboardImage} icon={Clipboard} onSelect={onPasteClipboardImage}>
            {c.pasteImage}
          </ContextMenuItem>
          <ContextMenuItem icon={Link} onSelect={onOpenUrlDialog}>
            {c.url}
          </ContextMenuItem>
          <ContextMenuItem icon={MessageSquareText} onSelect={() => setSnippetsOpen(true)}>
            {c.promptSnippets}
          </ContextMenuItem>

          <DropdownMenuSeparator />

          {/* Zone 1b — generate image / video. The generation entry lives in the
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

          {/* Zone 2 — enabled skills, each surfaced at the top level. */}
          <DropdownMenuLabel className="text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground/85">
            {cap.enabledLabel}
          </DropdownMenuLabel>
          <EnabledCapabilities catalog={catalog} loadingLabel={cap.loading} noneLabel={cap.noneEnabled} onManage={() => navigate(SKILLS_ROUTE)} />

          <DropdownMenuSeparator />

          {/* Zone 3 — every unused skill collapsed behind one entry. */}
          <DropdownMenuItem onSelect={() => setBrowseOpen(true)}>
            <Package />
            <span className="min-w-0 flex-1 truncate">{cap.unused}</span>
            {catalog.skills ? (
              <span className="text-[0.7rem] tabular-nums text-(--ui-text-tertiary)">{catalog.disabled.length}</span>
            ) : null}
            <Codicon className="text-(--ui-text-tertiary)" name="chevron-right" size="0.875rem" />
          </DropdownMenuItem>

          {/* Zone 4 — connectors (IM channels). */}
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

      <PromptSnippetsDialog onInsertText={onInsertText} onOpenChange={setSnippetsOpen} open={snippetsOpen} />
      <SkillBrowseDialog catalog={catalog} onOpenChange={setBrowseOpen} open={browseOpen} />
    </>
  )
}

// The "enabled" zone body: a live view of globally-enabled skills. Clicking one
// opens the Skills page to manage it (disable / configure) — the "+" menu stays
// an add surface, so it never disables in place.
function EnabledCapabilities({
  catalog,
  loadingLabel,
  noneLabel,
  onManage
}: {
  catalog: SkillCatalog
  loadingLabel: string
  noneLabel: string
  onManage: () => void
}) {
  if (!catalog.skills && catalog.loading) {
    return <div className="px-2 py-1.5 text-xs text-(--ui-text-tertiary)">{loadingLabel}</div>
  }

  if (catalog.enabled.length === 0) {
    return <div className="px-2 py-1.5 text-xs text-(--ui-text-tertiary)">{noneLabel}</div>
  }

  return (
    <>
      {catalog.enabled.map(skill => (
        <DropdownMenuItem key={skill.name} onSelect={onManage}>
          <Sparkles className="text-primary!" />
          <span className="min-w-0 flex-1 truncate">{skill.name}</span>
        </DropdownMenuItem>
      ))}
    </>
  )
}

function PromptSnippetsDialog({ onInsertText, onOpenChange, open }: PromptSnippetsDialogProps) {
  const { t } = useI18n()
  const c = t.composer

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md gap-3">
        <DialogHeader>
          <DialogTitle>{c.snippetsTitle}</DialogTitle>
          <DialogDescription>{c.snippetsDesc}</DialogDescription>
        </DialogHeader>
        <ul className="grid gap-1">
          {SNIPPET_KEYS.map(key => {
            const snippet = c.snippets[key]

            return (
              <li key={key}>
                <button
                  className="group/snippet flex w-full cursor-pointer items-start gap-2.5 rounded-md border border-transparent px-2.5 py-2 text-left transition-colors hover:border-(--ui-stroke-tertiary) hover:bg-(--ui-control-hover-background) focus-visible:border-(--ui-stroke-tertiary) focus-visible:bg-(--ui-control-hover-background) focus-visible:outline-none"
                  onClick={() => {
                    onInsertText(snippet.text)
                    onOpenChange(false)
                  }}
                  type="button"
                >
                  <MessageSquareText className="mt-0.5 size-3.5 shrink-0 text-(--ui-text-tertiary) group-hover/snippet:text-foreground" />
                  <span className="grid min-w-0 gap-0.5">
                    <span className="text-sm font-medium text-foreground">{snippet.label}</span>
                    <span className="text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
                      {snippet.description}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </DialogContent>
    </Dialog>
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
  onInsertText: (text: string) => void
  onOpenUrlDialog: () => void
  onPasteClipboardImage?: () => void
  onPickFiles?: () => void
  onPickFolders?: () => void
  onPickImages?: () => void
  state: ChatBarState
}

interface PromptSnippetsDialogProps {
  onInsertText: (text: string) => void
  onOpenChange: (open: boolean) => void
  open: boolean
}
