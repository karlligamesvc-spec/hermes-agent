import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { ChevronDown, iconSize } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { GHOST_ICON_BTN, PRIMARY_ICON_BTN } from './control-classes'
import { useVoiceEngineName, VoiceEngineRows } from './voice-engine-rows'

/** Shared one-click microphone entry for Start and chat. The adjacent picker
 * changes the next call's engine; the main press never opens a settings menu. */
export function StartVoiceButton({
  disabled,
  label,
  onStart
}: {
  disabled: boolean
  label: string
  onStart: () => void
}) {
  const { t } = useI18n()
  const engine = useVoiceEngineName()

  return (
    <span className="flex items-center">
      <Tip label={engine ? `${label} — ${engine}` : label}>
        <Button
          aria-label={label}
          className={PRIMARY_ICON_BTN}
          disabled={disabled}
          onClick={() => {
            triggerHaptic('open')
            onStart()
          }}
          size="icon"
          type="button"
        >
          <Codicon name="mic" size="1rem" />
        </Button>
      </Tip>
      {engine ? (
        <DropdownMenu>
          <Tip label={t.composer.voiceEngine}>
            <DropdownMenuTrigger asChild>
              <Button
                aria-label={t.composer.voiceEngine}
                className={cn(GHOST_ICON_BTN, 'w-5 rounded-l-none p-0')}
                disabled={disabled}
                size="icon"
                type="button"
                variant="ghost"
              >
                <ChevronDown className={iconSize.xs} />
              </Button>
            </DropdownMenuTrigger>
          </Tip>
          <DropdownMenuContent align="end" className="min-w-52">
            <VoiceEngineRows disabled={disabled} />
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </span>
  )
}
