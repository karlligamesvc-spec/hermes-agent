/**
 * hc-1015 「只有问题和回复」: no model choice on a chat surface.
 *
 * On in hc-960 tier mode, and in single-thread mode (hc-1014's switch, product
 * mode) on an APEX account: the shell sends the default tier alias and the
 * platform decides the rest (Kael 2026-10-21, decision 5: the tiers are not
 * shown). A user on their own key ("使用自己的密钥") keeps the full model UI, as
 * in tier mode. Read by the composer's model and reasoning pills, the model
 * picker and its chord, `/model` and `/moa`, the generation rows' model
 * pickers, and 「切换提供方」 on an error card.
 */

import { useStore } from '@nanostores/react'
import { computed } from 'nanostores'

import { $authState } from '@/store/auth'
import { $modelTierMode, isApexAccount } from '@/store/model-tiers'
import { $singleThreadMode } from '@/store/single-thread'

export const $modelChoiceHidden = computed(
  [$modelTierMode, $singleThreadMode, $authState],
  (tierMode, singleThread, auth) => tierMode || (singleThread && isApexAccount(auth))
)

export function useModelChoiceHidden(): boolean {
  return useStore($modelChoiceHidden)
}
