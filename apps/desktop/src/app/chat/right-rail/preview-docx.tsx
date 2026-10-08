import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { PageLoader } from '@/components/page-loader'
import { ErrorState } from '@/components/ui/error-state'
import { useI18n } from '@/i18n'
import { desktopFsCacheKey, readDesktopFileDataUrl } from '@/lib/desktop-fs'
import { docxParagraphs } from '@/lib/docx-preview'
import { $connection } from '@/store/session'

interface DocxPreviewState {
  paragraphs?: string[]
  error?: string
}

export function DocxFilePreview({ filePath, reloadKey }: { filePath: string; reloadKey: number }) {
  const { t } = useI18n()
  const connection = useStore($connection)
  const scope = desktopFsCacheKey(connection)
  const [state, setState] = useState<DocxPreviewState>({})

  useEffect(() => {
    let active = true

    setState({})
    void readDesktopFileDataUrl(filePath).then(data => {
      const paragraphs = docxParagraphs(data)

      if (active) {setState({ paragraphs })}
    }).catch(error => {
      if (active) {setState({ error: String(error instanceof Error ? error.message : error) })}
    })

    return () => { active = false }
  }, [filePath, reloadKey, scope])

  if (state.error) {
    return <div className="grid h-full place-items-center p-8"><ErrorState description={state.error} title={t.preview.unavailable} /></div>
  }

  if (!state.paragraphs) {return <PageLoader />}

  if (!state.paragraphs.some(paragraph => paragraph.trim())) {
    return <div className="grid h-full place-items-center p-8"><ErrorState description={t.preview.wordBodyEmpty} title={t.preview.unavailable} /></div>
  }

  return (
    <div className="h-full overflow-auto p-6" data-selectable-text="true">
      <p className="mb-6 text-xs text-muted-foreground">{t.preview.wordBodyPreview}</p>
      <article className="mx-auto max-w-prose space-y-4 break-words text-sm leading-7">
        {state.paragraphs.map((paragraph, index) => <p className="whitespace-pre-wrap" key={index}>{paragraph || '\u00a0'}</p>)}
      </article>
    </div>
  )
}
