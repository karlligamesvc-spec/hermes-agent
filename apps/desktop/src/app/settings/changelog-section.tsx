import { useStore } from '@nanostores/react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { type Locale, useI18n } from '@/i18n'
import { FileText } from '@/lib/icons'
import { $announcements, loadAnnouncements, resetAnnouncements } from '@/store/announcements'

import { EmptyState, ListRow, LoadingState } from './primitives'

// hc-447 更新日志 (changelog) entry point: a row in Settings → 关于/About that
// opens a small dialog listing the hc-446 product-update announcements (same
// "you can now…" content the web /app/whats-new page shows). Read-only —
// content authoring stays entirely in the cloud admin UI; this only reads.
//
// ANNOUNCEMENTS_ENABLED (cloud env flag) gates upstream IM dispatch, not this
// GET — so an empty feed is a normal, expected state today (nothing published
// yet) and renders the same friendly "no announcements yet" copy it would once
// the flag flips on and content starts flowing. No error, no dead end.
const INTL_TAGS: Record<Locale, string> = { en: 'en-US', ja: 'ja-JP', zh: 'zh-CN', 'zh-hant': 'zh-TW' }

export function ChangelogSection() {
  const { locale, t } = useI18n()
  const c = t.settings.about
  const [open, setOpen] = useState(false)

  const handleOpenChange = (next: boolean) => {
    setOpen(next)

    if (next) {
      void loadAnnouncements()
    } else {
      // Next open re-fetches instead of flashing whatever was current when
      // this session started — announcements are admin-published at any time.
      resetAnnouncements()
    }
  }

  return (
    <>
      <div className="p5-card p5-rows mt-3.5">
        <ListRow
          action={
            <Button onClick={() => handleOpenChange(true)} size="sm" variant="textStrong">
              {c.changelogView}
            </Button>
          }
          description={c.changelogIntro}
          title={c.changelogTitle}
        />
      </div>

      <Dialog onOpenChange={handleOpenChange} open={open}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle icon={FileText}>{c.changelogTitle}</DialogTitle>
            <DialogDescription>{c.changelogIntro}</DialogDescription>
          </DialogHeader>

          <ChangelogDialogBody locale={locale} />
        </DialogContent>
      </Dialog>
    </>
  )
}

function ChangelogDialogBody({ locale }: { locale: Locale }) {
  const { t } = useI18n()
  const c = t.settings.about
  const state = useStore($announcements)

  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <div className="min-h-52">
        <LoadingState label={t.common.loading} />
      </div>
    )
  }

  if (state.status === 'error') {
    return <EmptyState description={state.needsSignIn ? c.changelogNeedsSignIn : c.changelogLoadError} title={c.changelogTitle} />
  }

  if (state.items.length === 0) {
    return <EmptyState description={c.changelogEmpty} title={c.changelogTitle} />
  }

  const dateFormat = new Intl.DateTimeFormat(INTL_TAGS[locale] ?? INTL_TAGS.en, { dateStyle: 'medium' })

  return (
    <div className="grid max-h-[60vh] gap-4 overflow-y-auto py-1">
      {state.items.map(announcement => (
        <div className="border-b border-border/50 pb-3 last:border-0 last:pb-0" key={announcement.id}>
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-sm font-medium text-foreground">{announcement.title}</p>
            {announcement.publishedAt && (
              <p className="shrink-0 text-xs text-muted-foreground">{dateFormat.format(new Date(announcement.publishedAt))}</p>
            )}
          </div>
          <p className="mt-1 whitespace-pre-line text-xs text-muted-foreground">{announcement.body}</p>
        </div>
      ))}
    </div>
  )
}
