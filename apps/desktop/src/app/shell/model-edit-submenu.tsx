import { useStore } from '@nanostores/react'

import { useSessionView } from '@/app/chat/session-view'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  dropdownMenuRow,
  dropdownMenuSectionLabel,
  DropdownMenuSeparator,
  DropdownMenuSubContent
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'
import { nearestSupportedEffort, type ReasoningEffort, supportedReasoningEfforts } from '@/lib/reasoning-efforts'
import { normalize } from '@/lib/text'
import { setModelPreset } from '@/store/model-presets'
import { notifyError } from '@/store/notifications'
import { markComposerSelectionManual, setCurrentFastMode, setCurrentReasoningEffort } from '@/store/session'
import { sessionTileDelegate } from '@/store/session-states'


/** How "fast" is achieved for a given model — two different mechanisms:
 *  - `param`: the Anthropic/OpenAI `speed=fast` request parameter.
 *  - `variant`: a separate `…-fast` sibling model selected via the model field.
 */
export type FastControl =
  | { kind: 'none' }
  | { kind: 'param'; on: boolean }
  | { kind: 'variant'; baseId: string; fastId: string; on: boolean }

/** Resolve the fast mechanism for a model: prefer the speed=fast parameter
 *  when the backend supports it, else fall back to a `…-fast` sibling model. */
export function resolveFastControl(
  model: string,
  providerModels: readonly string[],
  paramSupported: boolean,
  currentFastMode: boolean
): FastControl {
  if (paramSupported) {
    return { kind: 'param', on: currentFastMode }
  }

  if (/-fast$/i.test(model)) {
    const baseId = model.replace(/-fast$/i, '')

    // Only a toggle if there's a base to switch back to; otherwise it's a
    // standalone fast model with no "off" state.
    return providerModels.includes(baseId) ? { kind: 'variant', baseId, fastId: model, on: true } : { kind: 'none' }
  }

  const fastId = `${model}-fast`

  if (providerModels.includes(fastId)) {
    return { kind: 'variant', baseId: model, fastId, on: false }
  }

  // Fast isn't natively offered here, but if the session still has the speed
  // param on (carried over from a previous model), expose the toggle so it can
  // be turned off rather than stranded.
  if (currentFastMode) {
    return { kind: 'param', on: true }
  }

  return { kind: 'none' }
}

interface ModelEditSubmenuProps {
  /** False for routes whose provider requires reasoning to remain enabled. */
  canDisableReasoning?: boolean
  defaultEffort?: string
  /** This row's effective reasoning effort (live for the active model, else its
   *  preset) — the submenu shows and edits from this, never the raw session. */
  effort: string
  /** How fast mode is offered for this model (param toggle vs. variant swap). */
  fastControl: FastControl
  /** Whether this row's model is the active one. */
  isActive: boolean
  /** This row's model id — edits persist as its global preset. */
  model: string
  /** Switch to a specific model id (used to swap base ⇄ -fast variant). */
  onSelectModel: (model: string) => Promise<boolean | void> | void
  onSetOptions?: (patch: { effort?: string; fast?: boolean }) => void
  /** This row's provider slug — edits persist as its global preset. */
  provider: string
  /** Display name of this row's provider — the fallback vendor hint when the
   *  model id itself is anonymous (see supportedReasoningEfforts). */
  providerName?: string
  /** Whether this model supports reasoning effort. */
  reasoning: boolean
  requestGateway?: <T>(method: string, params?: Record<string, unknown>) => Promise<T>
}

export function ModelEditSubmenu({
  canDisableReasoning,
  effort,
  fastControl,
  isActive,
  model,
  onSelectModel,
  onSetOptions,
  provider,
  providerName,
  reasoning,
  requestGateway
}: ModelEditSubmenuProps) {
  const { t } = useI18n()
  const copy = t.shell.modelOptions
  const view = useSessionView()
  const activeSessionId = useStore(view.$runtimeId)
  const touchesPrimary = view.kind === 'primary'

  // hc-598: only the levels THIS model actually offers. Rendering all seven of
  // Hermes' levels for every model made most of them decoys — the backend either
  // folds them onto a level already on the list or rejects them outright.
  const effortOptions = supportedReasoningEfforts(model, providerName || provider)
  const effortValue = normalizeEffort(effort, effortOptions)
  const thinkingOn = isThinkingEnabled(effort)

  // Editing always records the model's global preset (keyed by provider::model,
  // not per-surface — a tile edit re-applies to that model everywhere); the
  // active model also gets it pushed onto its OWN session (primary → globals,
  // tile → its slice). Non-active edits stay preset-only — no model switch.
  const patchReasoning = async (next: string) => {
    if (onSetOptions) {
      onSetOptions({ effort: next })

      return
    }

    setModelPreset(provider, model, { effort: next })

    if (!isActive) {
      return
    }

    if (touchesPrimary) {
      markComposerSelectionManual()
      setCurrentReasoningEffort(next)
    } else if (activeSessionId) {
      sessionTileDelegate()?.updateSession(activeSessionId, state => ({ ...state, reasoningEffort: next }))
    }

    // Preset-only without a session: `isActive` holds for the global/default
    // row pre-session, and the gateway's `config.set` falls back to global
    // config when none matches — so don't reach it (preset + optimistic store
    // are the whole effect). Same guard in applyModelPreset / toggleFast.
    if (!activeSessionId) {
      return
    }

    try {
      await requestGateway?.('config.set', { key: 'reasoning', session_id: activeSessionId, value: next })
    } catch (err) {
      if (touchesPrimary) {
        setCurrentReasoningEffort(effort)
      } else if (activeSessionId) {
        sessionTileDelegate()?.updateSession(activeSessionId, state => ({ ...state, reasoningEffort: effort }))
      }

      setModelPreset(provider, model, { effort })
      notifyError(err, copy.updateFailed)
    }
  }

  const toggleFast = (enabled: boolean) => {
    if (onSetOptions) {
      onSetOptions({ fast: enabled })

      if (fastControl.kind === 'variant' && isActive) {
        void onSelectModel(enabled ? fastControl.fastId : fastControl.baseId)
      }

      return
    }

    if (fastControl.kind === 'variant') {
      // Fast is a separate model id. Record the choice on the base model's
      // preset (selectFamily picks the `-fast` sibling later when set), and
      // only swap models now if this is the active row — inactive edits must
      // stay preset-only, same as the param path below.
      setModelPreset(provider, fastControl.baseId, { fast: enabled })

      if (isActive) {
        void onSelectModel(enabled ? fastControl.fastId : fastControl.baseId)
      }

      return
    }

    if (fastControl.kind === 'param') {
      setModelPreset(provider, model, { fast: enabled })

      if (!isActive) {
        return
      }

      if (touchesPrimary) {
        markComposerSelectionManual()
        setCurrentFastMode(enabled)
      } else if (activeSessionId) {
        sessionTileDelegate()?.updateSession(activeSessionId, state => ({ ...state, fast: enabled }))
      }

      // Preset-only without a session (see patchReasoning).
      if (!activeSessionId) {
        return
      }
      void (async () => {
        try {
          await requestGateway?.('config.set', {
            key: 'fast',
            session_id: activeSessionId,
            value: enabled ? 'fast' : 'normal'
          })
        } catch (err) {
          if (touchesPrimary) {
            setCurrentFastMode(!enabled)
          } else if (activeSessionId) {
            sessionTileDelegate()?.updateSession(activeSessionId, state => ({ ...state, fast: !enabled }))
          }

          setModelPreset(provider, model, { fast: !enabled })
          notifyError(err, copy.fastFailed)
        }
      })()
    }
  }

  const hasFast = fastControl.kind !== 'none'
  const fastOn = fastControl.kind === 'none' ? false : fastControl.on

  return (
    <DropdownMenuSubContent className="w-52 p-0" sideOffset={4}>
      {!hasFast && !reasoning ? (
        <div className="px-2.5 py-3 text-xs text-(--ui-text-tertiary)">{copy.noOptions}</div>
      ) : (
        <>
          <DropdownMenuLabel className={dropdownMenuSectionLabel}>{copy.options}</DropdownMenuLabel>
          {reasoning && canDisableReasoning !== false ? (
            <DropdownMenuItem className={dropdownMenuRow} onSelect={event => event.preventDefault()}>
              {copy.thinking}
              <Switch
                checked={thinkingOn}
                className="ml-auto"
                onCheckedChange={checked =>
                  void patchReasoning(checked ? effortValue || nearestSupportedEffort('medium', effortOptions) : 'none')
                }
                size="xs"
              />
            </DropdownMenuItem>
          ) : null}
          {hasFast ? (
            <DropdownMenuItem className={dropdownMenuRow} onSelect={event => event.preventDefault()}>
              {copy.fast}
              <Switch checked={fastOn} className="ml-auto" onCheckedChange={toggleFast} size="xs" />
            </DropdownMenuItem>
          ) : null}
          {reasoning ? (
            <>
              <DropdownMenuSeparator className="mx-0" />
              <DropdownMenuLabel className={dropdownMenuSectionLabel}>{copy.effort}</DropdownMenuLabel>
              <DropdownMenuRadioGroup onValueChange={value => void patchReasoning(value)} value={effortValue}>
                {effortOptions.map(option => (
                  <DropdownMenuRadioItem
                    className={dropdownMenuRow}
                    key={option}
                    onSelect={event => event.preventDefault()}
                    value={option}
                  >
                    {copy[option]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </>
          ) : null}
        </>
      )}
    </DropdownMenuSubContent>
  )
}

function isThinkingEnabled(effort: string): boolean {
  // Empty = Hermes default (medium) = on; only an explicit "none" is off.
  return normalize(effort || 'medium') !== 'none'
}

function normalizeEffort(effort: string, supported: readonly ReasoningEffort[]): string {
  const value = normalize(effort || 'medium')

  // Thinking off → no effort selected in the radio group.
  if (value === 'none') {
    return ''
  }

  // A saved level this model doesn't offer (picked while another model was
  // active, or carried over from before the list was narrowed) shows as the
  // closest level it does — never blank, never silently dropped. The stored
  // preset keeps the user's original choice for models that can honor it.
  return nearestSupportedEffort(value, supported)
}
