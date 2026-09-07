import { Button, Codicon, Tip } from '@hermes/plugin-sdk'

export interface ActivityToastButtonProps {
  enabled: boolean
  labels: { off: string; on: string }
  onToggle: () => void
}

/** The icon-only activity control exposes both its state and next action in
 * the active locale; the same text drives the tooltip and accessibility tree. */
export function ActivityToastButton({ enabled, labels, onToggle }: ActivityToastButtonProps) {
  const label = enabled ? labels.on : labels.off

  return (
    <Tip label={label}>
      <Button
        aria-label={label}
        aria-pressed={enabled}
        className="rounded-md text-(--ui-text-tertiary) hover:text-foreground"
        onClick={onToggle}
        size="icon-xs"
        variant="ghost"
      >
        <Codicon name={enabled ? 'bell' : 'bell-slash'} />
      </Button>
    </Tip>
  )
}
