import { useStore } from '@nanostores/react'
import { useQuery } from '@tanstack/react-query'

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { modelOptionsQueryKey, requestModelOptions } from '@/lib/model-options'
import { displayModelName } from '@/lib/model-status-label'
import { filterApexLlmShelf } from '@/lib/provider-allowlist'
import { $activeConnectionId } from '@/store/connections'
import { $gateway } from '@/store/gateway'
import { $activeGatewayProfile } from '@/store/profile'

import type { SourceQuestionModel } from '../source-question-answer'
import type { VideoBreakdownLocale } from '../video-deep-breakdown-draft'

import { VIDEO_SOURCE_CHAT_COPY } from './video-source-chat-copy'

export function SourceQuestionModelPicker({
  locale,
  value,
  onChange,
  disabled
}: {
  locale: VideoBreakdownLocale
  value?: SourceQuestionModel
  onChange: (value?: SourceQuestionModel) => void
  disabled: boolean
}) {
  const gateway = useStore($gateway)
  const profile = useStore($activeGatewayProfile)
  const connectionId = useStore($activeConnectionId)
  const copy = VIDEO_SOURCE_CHAT_COPY[locale]

  const catalog = useQuery({
    queryKey: modelOptionsQueryKey(profile, null, connectionId),
    queryFn: () =>
      requestModelOptions({
        gateway: gateway ?? undefined,
        profile,
        request: gateway ? gateway.request.bind(gateway) : undefined
      }),
    enabled: !!gateway && !disabled
  })

  const providers = filterApexLlmShelf(catalog.data?.providers ?? [])

  return (
    <Select
      disabled={disabled}
      onOpenChange={open => {
        if (open && catalog.isError) {
          void catalog.refetch()
        }
      }}
      onValueChange={key => onChange(key === 'default' ? undefined : (JSON.parse(key) as SourceQuestionModel))}
      value={value ? JSON.stringify(value) : 'default'}
    >
      <SelectTrigger
        aria-label={copy.model}
        className="h-8 text-xs"
        title={value ? `${value.provider} · ${value.model}` : copy.defaultModel}
      >
        <SelectValue placeholder={copy.defaultModel} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="default">{copy.defaultModel}</SelectItem>
        {providers.map(provider => (
          <SelectGroup key={provider.slug}>
            <SelectLabel>{provider.name}</SelectLabel>
            {(provider.models ?? []).map(model => (
              <SelectItem key={model} value={JSON.stringify({ provider: provider.slug, model })}>
                {displayModelName(model)}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
        {catalog.isError && <SelectLabel>{copy.modelsUnavailable}</SelectLabel>}
      </SelectContent>
    </Select>
  )
}
