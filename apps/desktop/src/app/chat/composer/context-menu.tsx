import { useEffect, useState } from 'react'
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Kbd } from '@/components/ui/kbd'
import { ProviderIcon } from '@/components/ui/provider-icon'
import { useI18n } from '@/i18n'
import {
  CircleLetterA,
  type IconComponent,
  ImageIcon,
  MessageCircle,
  Package,
  Sparkles,
  Video
} from '@/lib/icons'
import type { VendorKey } from '@/lib/model-vendor'
import { cn } from '@/lib/utils'
import { notifyError } from '@/store/notifications'

import { useComposerAttachmentProviders } from './contrib'
import { GHOST_ICON_BTN } from './controls'
import { requestComposerFocus, requestComposerInsert } from './focus'
import {
  type GenerationKind,
  type GenerationModel,
  type GenerationModelIconKey,
  generationModels,
  generationStarter,
  previouslySelectedImageModel,
  saveImageGenerationModel,
  selectedGenerationModel,
  selectGenerationModel
} from './generation-models'
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
  const [imageModel, setImageModel] = useState(() => selectedGenerationModel('image'))
  const [videoModel, setVideoModel] = useState(() => selectedGenerationModel('video'))
  const attachmentProviders = useComposerAttachmentProviders()

  // Earlier releases only stored this choice in localStorage. Migrate that
  // visible selection into the runtime preference as soon as chat is ready.
  useEffect(() => {
    const previous = previouslySelectedImageModel()
    if (!state.tools.enabled || !previous) {
      return
    }
    void saveImageGenerationModel(previous.id).catch(error => notifyError(error, t.settings.config.autosaveFailed))
  }, [state.tools.enabled, t.settings.config.autosaveFailed])

  // Seed the composer with a generation opener and focus it, then close the
  // menu. Prefill (not auto-send) so the user finishes describing the idea —
  // the ladder's stage 0. The agent picks it up and returns the first card.
  const startGeneration = (starter: string) => {
    requestComposerInsert(starter, { mode: 'block', target: 'main' })
    requestComposerFocus('main')
    setMenuOpen(false)
  }

  const chooseGenerationModel = async (kind: GenerationKind, id: string) => {
    if (kind === 'image') {
      try {
        const selected = await saveImageGenerationModel(id)
        setImageModel(selected)
        startGeneration(generationStarter(cap.generateImageStarter, selected))
      } catch (error) {
        notifyError(error, t.settings.config.autosaveFailed)
      }
    } else {
      const selected = selectGenerationModel(kind, id)
      setVideoModel(selected)
      startGeneration(generationStarter(cap.generateVideoStarter, selected))
    }
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
          <GenerationModelSubmenu
            icon={ImageIcon}
            kind="image"
            label={cap.generateImage}
            onSelect={id => chooseGenerationModel('image', id)}
            selectedId={imageModel.id}
            selectedLabel={imageModel.label}
          />
          <GenerationModelSubmenu
            icon={Video}
            kind="video"
            label={cap.generateVideo}
            onSelect={id => chooseGenerationModel('video', id)}
            selectedId={videoModel.id}
            selectedLabel={videoModel.label}
          />

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
              onSelect={() =>
                void provider.run({ insertText: text => requestComposerInsert(text, { target: 'main' }) })
              }
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

function GenerationModelSubmenu({
  icon: Icon,
  kind,
  label,
  onSelect,
  selectedId,
  selectedLabel
}: GenerationModelSubmenuProps) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className={CAPABILITY_ROW}>
        <Icon />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="max-w-28 truncate text-[0.7rem] text-(--ui-text-tertiary)">{selectedLabel}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-56">
        <DropdownMenuRadioGroup onValueChange={onSelect} value={selectedId}>
          {generationModels(kind).map(model => (
            <DropdownMenuRadioItem className={CAPABILITY_ROW} key={model.id} value={model.id}>
              <GenerationModelIcon model={model} />
              <span className="truncate">{model.label}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

const GENERATION_ICON_SPECS: Record<Exclude<GenerationModelIconKey, 'agnes'>, { vendor: VendorKey }> = {
  gemini: { vendor: 'gemini' },
  'gpt-flare': { vendor: 'openai' },
  'gpt-sunburst': { vendor: 'openai' },
  minimax: { vendor: 'minimax' },
  qwen: { vendor: 'qwen' },
  'seedance-2': { vendor: 'doubao' },
  'seedance-2-fast': { vendor: 'doubao' },
  'seedance-2-mini': { vendor: 'doubao' },
  'seedance-2.5': { vendor: 'doubao' }
}

/**
 * Generation models use their provider mark instead of a repeated media
 * glyph. The text label already carries the model variant, so keep the icon
 * itself clean: tiny numeric/letter badges become unreadable at menu size and
 * visually collide with the provider artwork.
 */
export function GenerationModelIcon({ model }: { model: GenerationModel }) {
  if (model.icon === 'agnes') {
    return (
      <span
        aria-hidden="true"
        className="inline-flex h-5 w-7 shrink-0 items-center justify-start"
        data-generation-model-icon={model.icon}
      >
        <span className="inline-flex size-4.5 items-center justify-center rounded-[5px] bg-[#7456D8] text-white ring-1 ring-inset ring-black/10">
          <CircleLetterA size={12} stroke={1.8} />
        </span>
      </span>
    )
  }

  const spec = GENERATION_ICON_SPECS[model.icon]

  return (
    <span
      aria-hidden="true"
      className="inline-flex h-5 w-7 shrink-0 items-center justify-start"
      data-generation-model-icon={model.icon}
    >
      <ProviderIcon size={18} vendor={spec.vendor} />
    </span>
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

interface GenerationModelSubmenuProps {
  icon: IconComponent
  kind: GenerationKind
  label: string
  onSelect: (id: string) => void
  selectedId: string
  selectedLabel: string
}
