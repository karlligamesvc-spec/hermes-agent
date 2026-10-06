import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
import { triggerHaptic } from '@/lib/haptics'

import { PRIMARY_ICON_BTN } from './control-classes'

/** Shared one-click voice entry. APEX selects the realtime service internally. */
export function StartVoiceButton({
  disabled,
  label,
  onStart
}: {
  disabled: boolean
  label: string
  onStart: () => void
}) {
  return (
    <Tip label={label}>
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
  )
}
