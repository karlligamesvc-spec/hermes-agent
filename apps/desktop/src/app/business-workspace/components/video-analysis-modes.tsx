import { type ReactNode, useState } from 'react'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import type { VideoBreakdownLocale } from '../video-deep-breakdown-draft'

const COPY = {
  zh: { quick: '快速分析', deep: '深度拆解', empty: '尚无可靠的时间码证据。取得资料后再进行分析。' },
  'zh-hant': { quick: '快速分析', deep: '深度拆解', empty: '尚無可靠的時間碼證據。取得資料後再進行分析。' },
  en: { quick: 'Quick analysis', deep: 'Deep breakdown', empty: 'No reliable timed evidence yet. Obtain the source before analysing it.' },
  ja: { quick: 'クイック分析', deep: '詳細分析', empty: '信頼できるタイムコードの根拠はまだありません。資料を取得してから分析してください。' },
  ar: { quick: 'تحليل سريع', deep: 'تحليل متعمق', empty: 'لا توجد أدلة توقيت موثوقة بعد. احصل على المصدر قبل تحليله.' }
} as const

export function VideoAnalysisModes({ locale, quick, deep, questions }: {
  locale: VideoBreakdownLocale
  quick: ReactNode
  deep: ReactNode
  questions: ReactNode
}) {
  const c = COPY[locale]
  const [mode, setMode] = useState('quick')

  return <>
    <Tabs onValueChange={setMode} value={mode}>
      <TabsList>
        <TabsTrigger value="quick">{c.quick}</TabsTrigger>
        <TabsTrigger value="deep">{c.deep}</TabsTrigger>
      </TabsList>
      <TabsContent forceMount hidden={mode !== 'quick'} value="quick">{quick || <p className="text-sm text-(--ui-text-secondary)">{c.empty}</p>}</TabsContent>
      <TabsContent forceMount hidden={mode !== 'deep'} value="deep">{deep || <p className="text-sm text-(--ui-text-secondary)">{c.empty}</p>}</TabsContent>
    </Tabs>
    {questions}
  </>
}
