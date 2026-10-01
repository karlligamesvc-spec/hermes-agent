import { useState } from 'react'

import { EngineUpdateSection } from '@/app/settings/about-settings'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'

/** Reuses the formal update confirmation; remote recovery never updates this machine. */
export function ManagedRuntimeRecovery({ localRuntime }: { localRuntime?: boolean | null }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)

  if (localRuntime !== true) {return null}

  return (
    <div className="w-full">
      <Button onClick={() => setOpen(value => !value)} type="button" variant="textStrong">
        {t.settings.about.updates}
      </Button>
      {open ? <EngineUpdateSection dialogLayer={1502} /> : null}
    </div>
  )
}
