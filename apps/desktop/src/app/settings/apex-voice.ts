/**
 * hc-1193: Settings › 语音 can pick APEX's own voice again, and 恢复默认 keeps it.
 *
 * The engine speaks with APEX's voice while the profile has saved no
 * `tts.provider` (missing or empty): apex_overlay/doubao_tts.py's
 * `load_tts_config` reads the saved layer, not the defaults, and names the
 * provider it registers for that voice `doubao` (who speaks behind it is the
 * platform's choice, hc-1163). Settings could not get there:
 * - GET /api/config fills a key the profile never saved with upstream's
 *   DEFAULT_CONFIG, `tts.provider: edge`, so 「文字转语音提供方」 read 「Edge」
 *   for everyone who never chose a voice;
 * - its list had no entry for APEX's voice and no way to clear the choice;
 * - 恢复默认 saved /api/config/defaults, that same DEFAULT_CONFIG, and the
 *   backend keeps every path the profile had saved before, so `edge` landed
 *   on disk wherever a provider had been chosen once.
 *
 * Product mode on an APEX account lists 「APEX 配音（默认）」 first and reads
 * the saved layer to know whether anything was chosen. Choosing it saves
 * `tts.provider: ''`: for the overlay and for upstream's `_get_provider` that
 * is the same as never choosing, and it follows the default should it change.
 * Choosing another provider from there writes it over a cleared value: the
 * backend drops a value equal to upstream's default (`edge`) unless the file
 * already has the key, so Edge picked over APEX's voice would not stick.
 * Developer mode and 「使用自己的密钥」 keep their list as it was; an empty
 * value reads 「APEX 配音（默认）」 there too instead of a blank box. 恢复默认
 * saves '' for it. A `tts.provider: edge` already on disk is left as it is.
 */

import { useStore } from '@nanostores/react'
import { useQuery } from '@tanstack/react-query'
import { computed } from 'nanostores'
import { useMemo } from 'react'

import { getHermesConfigRecord, saveHermesConfig } from '@/hermes'
import { writeCache } from '@/lib/query-client'
import { $authState } from '@/store/auth'
import { isApexAccount } from '@/store/model-tiers'
import { $singleThreadMode } from '@/store/single-thread'
import type { HermesConfigRecord } from '@/types/hermes'

import { hermesConfigCacheWriter, hermesConfigKey, useHermesConfigRecord } from '../hooks/use-config-record'

import { getNested, setNested } from './helpers'

const TTS_PROVIDER_KEY = 'tts.provider'

/** The saved `tts.provider` Settings writes for APEX's own voice: nothing chosen. */
export const APEX_VOICE = ''

/** The provider the overlay registers for APEX's voice (Capabilities lists it as a row of its own). */
const APEX_VOICE_PROVIDER = 'doubao'

/** Product mode on an APEX account: the voice list offers APEX's own voice. */
export const $apexVoiceOffered = computed(
  [$singleThreadMode, $authState],
  (productMode, auth) => productMode && isApexAccount(auth)
)

/** What a saved `tts.provider` chooses, with APEX_VOICE for every value the engine speaks APEX's voice for. */
export function savedVoiceChoice(saved: unknown): string {
  if (saved === undefined || saved === null || saved === '') {
    return APEX_VOICE
  }

  const provider = String(saved)

  return provider.trim().toLowerCase() === APEX_VOICE_PROVIDER ? APEX_VOICE : provider
}

/** GET /api/config's record with `tts.provider` as the profile saved it. */
export function withSavedVoiceChoice(record: HermesConfigRecord, saved: HermesConfigRecord): HermesConfigRecord {
  return setNested(record, TTS_PROVIDER_KEY, savedVoiceChoice(getNested(saved, TTS_PROVIDER_KEY)))
}

/** 恢复默认's payload: upstream's defaults, with APEX's voice instead of Edge. */
export function withApexVoiceDefault(defaults: HermesConfigRecord): HermesConfigRecord {
  return setNested(defaults, TTS_PROVIDER_KEY, APEX_VOICE)
}

/** The 「文字转语音提供方」 list: APEX's voice first while it is offered, or while it is the current value. */
export function voiceProviderOptions(
  key: string,
  value: unknown,
  offered: boolean,
  options: string[] | undefined
): string[] | undefined {
  if (key !== TTS_PROVIDER_KEY || !options || !(offered || value === APEX_VOICE)) {
    return options
  }

  return [APEX_VOICE, ...options.filter(option => option !== APEX_VOICE)]
}

/** The name of the list's empty choice: `label` for 「文字转语音提供方」, nothing for any other field. */
export function voiceProviderLabels(key: string, label: string): Record<string, string> | undefined {
  return key === TTS_PROVIDER_KEY ? { [APEX_VOICE]: label } : undefined
}

/**
 * Save a Settings patch where APEX's voice is offered. A provider chosen in it
 * lands on a cleared `tts.provider` first, so the backend keeps the key even
 * when the value equals upstream's default; the cleared value is APEX's voice,
 * what the profile spoke with until the choice is written.
 */
export async function saveOverApexVoice(patch: HermesConfigRecord, profile?: string): Promise<{ ok: boolean }> {
  const provider = getNested(patch, TTS_PROVIDER_KEY)

  if (typeof provider === 'string' && provider !== APEX_VOICE) {
    const cleared = await saveHermesConfig(setNested({}, TTS_PROVIDER_KEY, APEX_VOICE), profile)

    if (!cleared.ok) {
      return cleared
    }
  }

  return saveHermesConfig(patch, profile)
}

/**
 * The record Settings' config pages edit, how a patch is saved and how a save
 * is mirrored into the cache. Elsewhere it is the shared record
 * (`use-config-record`) and a plain save, as before.
 * Where APEX's voice is offered it is GET /api/config with `tts.provider` as
 * saved; one query reads both, so a profile switch never pairs one profile's
 * record with another's saved layer. If the saved layer cannot be read, the
 * row shows what GET /api/config says, as before.
 */
export function useSettingsConfigRecord(profile?: string) {
  const offered = useStore($apexVoiceOffered)
  const shared = useHermesConfigRecord(profile)
  const key = useMemo(() => ['hermes-config-record-apex-voice', ...hermesConfigKey(profile).slice(1)], [profile])

  const voiced = useQuery({
    enabled: offered,
    queryFn: async () => {
      const [record, saved] = await Promise.all([
        getHermesConfigRecord(profile, { includeDefaults: true }),
        getHermesConfigRecord(profile, { includeDefaults: false }).catch(() => null)
      ])

      return saved ? withSavedVoiceChoice(record, saved) : record
    },
    queryKey: key,
    staleTime: 0
  })

  const write = useMemo(() => {
    const writeShared = hermesConfigCacheWriter(profile)
    const writeVoiced = writeCache<HermesConfigRecord>(key)

    return (next: HermesConfigRecord) => {
      writeShared(next)
      writeVoiced(next)
    }
  }, [key, profile])

  return { record: offered ? voiced : shared, save: offered ? saveOverApexVoice : saveHermesConfig, writeCache: write }
}
