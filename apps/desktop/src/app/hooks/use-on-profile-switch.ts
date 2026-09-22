import { useStore } from '@nanostores/react'
import { useEffect, useRef } from 'react'

import { $activeGatewayProfile } from '@/store/profile'

/** Run `onSwitch` when the active gateway profile changes — never on first
 *  mount. For dropping per-profile view state (probes, cached usage, drafts)
 *  when the backend the app talks to swaps underneath a still-mounted view. */
export function useOnProfileSwitch(onSwitch: () => void): void {
  const profile = useStore($activeGatewayProfile)
  // Store the value itself instead of a "first effect" flag. React StrictMode
  // deliberately replays mount effects (setup -> cleanup -> setup) while
  // preserving refs. A boolean flag therefore treats the second setup as a
  // real profile switch and clears freshly loaded settings data, leaving
  // schema-backed pages on their loading skeleton forever in development.
  const previousProfile = useRef(profile)

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    if (previousProfile.current === profile) {
      return
    }

    previousProfile.current = profile
    onSwitch()
    // Fire on profile change only; onSwitch identity is intentionally ignored.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile])
}
