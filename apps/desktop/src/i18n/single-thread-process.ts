/**
 * hc-1066 「过程说人话」: the words single-thread mode uses for a step it can
 * read the purpose of (`process/step-intent.ts`), the one-line stage progress
 * under the activity line, and the sentence above a command or code waiting
 * on the user's approval.
 *
 * Kept beside the main catalogs instead of inside them: those files are past
 * the code-health size cap. Each locale is a whole typed object, so a missing
 * zh string is a type error; zh, zh-hant and en are complete, ja and ar read en.
 */

import type {
  ApprovalPurpose,
  LookTopic,
  Stage,
  StageProgress,
  StepIntent
} from '@/components/assistant-ui/process/step-intent'

import { getRuntimeI18nLocale } from './runtime'
import type { Locale } from './types'
import type { StepCopy, StepFacts } from './types-process'

export interface SingleThreadProcessCopy {
  intents: Record<StepIntent, StepCopy>
  /** An image look, named by what it checks: 「看画面：字幕、构图」. */
  look: (topics: string) => StepCopy
  topics: Record<LookTopic, string>
  topicSeparator: string
  /** 「已看完素材、生成好素材，正在剪辑」: the stages passed, then the one in progress. */
  stageLine: (progress: StageProgress) => string
  /** What a command or code waiting on approval is for, and what saying yes does. */
  approval: (purpose: ApprovalPurpose, title: null | string) => string
}

const step = (running: string, title: string, done: (facts: StepFacts) => string): StepCopy => ({
  done,
  running,
  title
})

const said = (text: string) => () => text

const each = (verb: string, unit: string, single: string) => (facts: StepFacts) =>
  facts.calls > 1 ? `${verb} ${facts.calls} ${unit}` : single

const zhIntents: Record<StepIntent, StepCopy> = {
  audio: step('正在处理声音', '处理声音', said('处理好了')),
  blackframes: step('正在检查有没有黑屏', '检查黑屏', said('查过了')),
  cleanup: step('正在清理临时文件', '清理临时文件', said('清理好了')),
  data: step('正在整理数据', '整理数据', said('整理好了')),
  download: step('正在下载文件', '下载文件', each('下载了', '个文件', '下载好了')),
  editDoc: step('正在改文稿', '改文稿', each('改了', '处', '改好了')),
  editEdit: step('正在调整剪辑步骤', '调整剪辑步骤', each('调整了', '处', '调整好了')),
  editScript: step('正在调整处理步骤', '调整处理步骤', each('调整了', '处', '调整好了')),
  editSubs: step('正在调整字幕', '调整字幕', each('调整了', '处', '调整好了')),
  files: step('正在查看文件', '查看文件', said('看过了')),
  folder: step('正在准备工作文件夹', '准备工作文件夹', said('准备好了')),
  fonts: step('正在看可用的字体', '看可用字体', said('看过了')),
  frames: step('正在抽帧', '抽帧', each('抽了', '次帧', '抽好了')),
  image: step('正在处理图片', '处理图片', each('处理了', '次', '处理好了')),
  install: step('正在安装需要的组件', '安装组件', said('装好了')),
  loudness: step('正在检查音量', '检查音量', said('查过了')),
  open: step('正在打开文件', '打开文件', said('打开了')),
  probe: step('正在查看视频的时长和尺寸', '查看视频信息', each('查看了', '个文件', '看过了')),
  program: step('正在处理素材', '处理素材', each('处理了', '次', '处理好了')),
  readData: step('正在读数据', '读数据', said('读完了')),
  readDoc: step('正在读文稿', '读文稿', said('读完了')),
  readSubs: step('正在读字幕', '读字幕', said('读完了')),
  render: step('正在合成视频', '合成视频', each('合成了', '次', '合成好了')),
  save: step('正在保存文件', '保存文件', each('存了', '个文件', '存好了')),
  silence: step('正在检查静音段', '检查静音段', said('查过了')),
  subtitles: step('正在做字幕', '做字幕', each('做了', '次', '字幕做好了')),
  tools: step('正在检查剪辑工具', '检查剪辑工具', said('查过了')),
  transcribe: step('正在识别语音', '识别语音', said('识别好了')),
  transcript: step('正在看逐字稿', '看逐字稿', said('看过了')),
  writeDoc: step('正在写文稿', '写文稿', said('写好了')),
  writeEdit: step('正在写剪辑步骤', '写剪辑步骤', said('写好了')),
  writeScript: step('正在写处理步骤', '写处理步骤', said('写好了')),
  writeSubs: step('正在写字幕', '写字幕', said('写好了'))
}

const zhHantIntents: Record<StepIntent, StepCopy> = {
  audio: step('正在處理聲音', '處理聲音', said('處理好了')),
  blackframes: step('正在檢查有沒有黑屏', '檢查黑屏', said('查過了')),
  cleanup: step('正在清理暫存檔案', '清理暫存檔案', said('清理好了')),
  data: step('正在整理資料', '整理資料', said('整理好了')),
  download: step('正在下載檔案', '下載檔案', each('下載了', '個檔案', '下載好了')),
  editDoc: step('正在改文稿', '改文稿', each('改了', '處', '改好了')),
  editEdit: step('正在調整剪輯步驟', '調整剪輯步驟', each('調整了', '處', '調整好了')),
  editScript: step('正在調整處理步驟', '調整處理步驟', each('調整了', '處', '調整好了')),
  editSubs: step('正在調整字幕', '調整字幕', each('調整了', '處', '調整好了')),
  files: step('正在查看檔案', '查看檔案', said('看過了')),
  folder: step('正在準備工作資料夾', '準備工作資料夾', said('準備好了')),
  fonts: step('正在看可用的字型', '看可用字型', said('看過了')),
  frames: step('正在擷取畫面', '擷取畫面', each('擷取了', '次畫面', '擷取好了')),
  image: step('正在處理圖片', '處理圖片', each('處理了', '次', '處理好了')),
  install: step('正在安裝需要的元件', '安裝元件', said('裝好了')),
  loudness: step('正在檢查音量', '檢查音量', said('查過了')),
  open: step('正在開啟檔案', '開啟檔案', said('開啟了')),
  probe: step('正在查看影片的長度和尺寸', '查看影片資訊', each('查看了', '個檔案', '看過了')),
  program: step('正在處理素材', '處理素材', each('處理了', '次', '處理好了')),
  readData: step('正在讀資料', '讀資料', said('讀完了')),
  readDoc: step('正在讀文稿', '讀文稿', said('讀完了')),
  readSubs: step('正在讀字幕', '讀字幕', said('讀完了')),
  render: step('正在合成影片', '合成影片', each('合成了', '次', '合成好了')),
  save: step('正在儲存檔案', '儲存檔案', each('存了', '個檔案', '存好了')),
  silence: step('正在檢查靜音段', '檢查靜音段', said('查過了')),
  subtitles: step('正在做字幕', '做字幕', each('做了', '次', '字幕做好了')),
  tools: step('正在檢查剪輯工具', '檢查剪輯工具', said('查過了')),
  transcribe: step('正在辨識語音', '辨識語音', said('辨識好了')),
  transcript: step('正在看逐字稿', '看逐字稿', said('看過了')),
  writeDoc: step('正在寫文稿', '寫文稿', said('寫好了')),
  writeEdit: step('正在寫剪輯步驟', '寫剪輯步驟', said('寫好了')),
  writeScript: step('正在寫處理步驟', '寫處理步驟', said('寫好了')),
  writeSubs: step('正在寫字幕', '寫字幕', said('寫好了'))
}

const enIntents: Record<StepIntent, StepCopy> = {
  audio: step('Working on the sound', 'Work on sound', said('Done')),
  blackframes: step('Checking for black frames', 'Check for black frames', said('Checked')),
  cleanup: step('Clearing temporary files', 'Clear temporary files', said('Cleared')),
  data: step('Sorting the data', 'Sort data', said('Done')),
  download: step('Downloading files', 'Download files', each('Downloaded', 'files', 'Downloaded')),
  editDoc: step('Revising the draft', 'Revise draft', each('Revised', 'places', 'Revised')),
  editEdit: step('Adjusting the edit steps', 'Adjust edit steps', each('Adjusted', 'places', 'Adjusted')),
  editScript: step('Adjusting the processing steps', 'Adjust processing steps', each('Adjusted', 'places', 'Adjusted')),
  editSubs: step('Adjusting the subtitles', 'Adjust subtitles', each('Adjusted', 'places', 'Adjusted')),
  files: step('Looking at the files', 'Look at files', said('Looked')),
  folder: step('Setting up a work folder', 'Set up work folder', said('Ready')),
  fonts: step('Checking the available fonts', 'Check fonts', said('Checked')),
  frames: step('Grabbing frames', 'Grab frames', each('Grabbed frames', 'times', 'Grabbed')),
  image: step('Working on the images', 'Work on images', each('Worked on images', 'times', 'Done')),
  install: step('Installing what is needed', 'Install components', said('Installed')),
  loudness: step('Checking the volume', 'Check volume', said('Checked')),
  open: step('Opening the file', 'Open file', said('Opened')),
  probe: step('Checking the video’s length and size', 'Check video details', each('Checked', 'files', 'Checked')),
  program: step('Processing the footage', 'Process footage', each('Processed', 'times', 'Done')),
  readData: step('Reading the data', 'Read data', said('Read')),
  readDoc: step('Reading the draft', 'Read draft', said('Read')),
  readSubs: step('Reading the subtitles', 'Read subtitles', said('Read')),
  render: step('Putting the video together', 'Put video together', each('Rendered', 'times', 'Rendered')),
  save: step('Saving the file', 'Save file', each('Saved', 'files', 'Saved')),
  silence: step('Checking for silent gaps', 'Check silent gaps', said('Checked')),
  subtitles: step('Making the subtitles', 'Make subtitles', each('Made subtitles', 'times', 'Subtitles ready')),
  tools: step('Checking the editing tools', 'Check editing tools', said('Checked')),
  transcribe: step('Transcribing the speech', 'Transcribe speech', said('Transcribed')),
  transcript: step('Reading the transcript', 'Read transcript', said('Read')),
  writeDoc: step('Writing the draft', 'Write draft', said('Written')),
  writeEdit: step('Writing the edit steps', 'Write edit steps', said('Written')),
  writeScript: step('Writing the processing steps', 'Write processing steps', said('Written')),
  writeSubs: step('Writing the subtitles', 'Write subtitles', said('Written'))
}

const ZH_STAGES: Record<Stage, [done: string, current: string, again: (round: number) => string]> = {
  check: ['核对过成片', '正在核对成片', round => `正在核对成片（第 ${round} 次）`],
  edit: ['剪好初版', '正在剪辑', round => `正在修改成片（第 ${round} 轮）`],
  look: ['看完素材', '正在看素材', () => '正在再看一遍素材'],
  make: ['生成好素材', '正在生成素材', () => '正在补生成素材'],
  research: ['查完资料', '正在查资料', () => '正在补查资料'],
  save: ['存好文件', '正在保存', () => '正在保存']
}

const ZH_HANT_STAGES: Record<Stage, [done: string, current: string, again: (round: number) => string]> = {
  check: ['核對過成片', '正在核對成片', round => `正在核對成片（第 ${round} 次）`],
  edit: ['剪好初版', '正在剪輯', round => `正在修改成片（第 ${round} 輪）`],
  look: ['看完素材', '正在看素材', () => '正在再看一遍素材'],
  make: ['生成好素材', '正在生成素材', () => '正在補生成素材'],
  research: ['查完資料', '正在查資料', () => '正在補查資料'],
  save: ['存好檔案', '正在儲存', () => '正在儲存']
}

const EN_STAGES: Record<Stage, [done: string, current: string, again: (round: number) => string]> = {
  check: ['checked the cut', 'checking the cut', round => `checking the cut (pass ${round})`],
  edit: ['made a first cut', 'editing', round => `revising the cut (round ${round})`],
  look: ['looked through the footage', 'looking through the footage', () => 'looking at the footage again'],
  make: ['made the new footage', 'making new footage', () => 'making more footage'],
  research: ['did the research', 'researching', () => 'researching a bit more'],
  save: ['saved the files', 'saving', () => 'saving']
}

type StageWords = Record<Stage, [done: string, current: string, again: (round: number) => string]>

const currentStage = (words: StageWords, progress: StageProgress) => {
  const [, first, again] = words[progress.current]

  return progress.round > 1 ? again(progress.round) : first
}

const ZH_RISKS: Record<NonNullable<ApprovalPurpose['risk']>, string> = {
  delete: '其中会删除文件。',
  git: '其中会改动代码仓库。',
  kill: '其中会结束或重启正在运行的程序。',
  network: '其中会把数据发到网上。',
  permissions: '其中会改文件的权限。'
}

const ZH_HANT_RISKS: Record<NonNullable<ApprovalPurpose['risk']>, string> = {
  delete: '其中會刪除檔案。',
  git: '其中會改動程式碼倉庫。',
  kill: '其中會結束或重啟正在執行的程式。',
  network: '其中會把資料傳到網路上。',
  permissions: '其中會改檔案的權限。'
}

const EN_RISKS: Record<NonNullable<ApprovalPurpose['risk']>, string> = {
  delete: 'It deletes files.',
  git: 'It changes a code repository.',
  kill: 'It stops or restarts running programs.',
  network: 'It sends data over the internet.',
  permissions: 'It changes file permissions.'
}

const zh: SingleThreadProcessCopy = {
  intents: zhIntents,
  look: topics => step(`正在看画面：${topics}`, `看画面：${topics}`, each('看了', '次', '看过了')),
  topics: {
    artifacts: 'AI 破绽',
    framing: '构图',
    people: '人物',
    product: '商品',
    quality: '画质',
    scene: '场景',
    subtitles: '字幕',
    text: '画面文字'
  },
  topicSeparator: '、',
  stageLine: progress => {
    const current = currentStage(ZH_STAGES, progress)
    const done = progress.done.map(stage => ZH_STAGES[stage][0])

    return done.length > 0 ? `已${done.join('、')}，${current}` : current
  },
  approval: (purpose, title) => {
    if (purpose.kind === 'instructions') {
      return 'APEX 想改一份会影响它以后怎么做事的说明文件。你同意了才会改，点「命令」可以看是哪份文件。'
    }

    const what = purpose.kind === 'code' ? '一段程序' : '一条命令'
    const ask = title ? `APEX 想在你的电脑上运行${what}，用来${title}。` : `APEX 想在你的电脑上运行${what}。`
    const risk = purpose.risk ? ZH_RISKS[purpose.risk] : ''

    return `${ask}${risk}你同意了才会执行，点「命令」可以看具体内容。`
  }
}

const zhHant: SingleThreadProcessCopy = {
  intents: zhHantIntents,
  look: topics => step(`正在看畫面：${topics}`, `看畫面：${topics}`, each('看了', '次', '看過了')),
  topics: {
    artifacts: 'AI 破綻',
    framing: '構圖',
    people: '人物',
    product: '商品',
    quality: '畫質',
    scene: '場景',
    subtitles: '字幕',
    text: '畫面文字'
  },
  topicSeparator: '、',
  stageLine: progress => {
    const current = currentStage(ZH_HANT_STAGES, progress)
    const done = progress.done.map(stage => ZH_HANT_STAGES[stage][0])

    return done.length > 0 ? `已${done.join('、')}，${current}` : current
  },
  approval: (purpose, title) => {
    if (purpose.kind === 'instructions') {
      return 'APEX 想改一份會影響它以後怎麼做事的說明檔案。你同意了才會改，點「指令」可以看是哪份檔案。'
    }

    const what = purpose.kind === 'code' ? '一段程式' : '一條指令'
    const ask = title ? `APEX 想在你的電腦上執行${what}，用來${title}。` : `APEX 想在你的電腦上執行${what}。`
    const risk = purpose.risk ? ZH_HANT_RISKS[purpose.risk] : ''

    return `${ask}${risk}你同意了才會執行，點「指令」可以看具體內容。`
  }
}

const en: SingleThreadProcessCopy = {
  intents: enIntents,
  look: topics =>
    step(`Checking the picture: ${topics}`, `Check picture: ${topics}`, each('Checked', 'times', 'Checked')),
  topics: {
    artifacts: 'AI glitches',
    framing: 'framing',
    people: 'people',
    product: 'product',
    quality: 'picture quality',
    scene: 'setting',
    subtitles: 'subtitles',
    text: 'on-screen text'
  },
  topicSeparator: ', ',
  stageLine: progress => {
    const current = currentStage(EN_STAGES, progress)
    const done = progress.done.map(stage => EN_STAGES[stage][0])
    const line = done.length > 0 ? `${done.join(', ')} — now ${current}` : current

    return line.charAt(0).toUpperCase() + line.slice(1)
  },
  approval: (purpose, title) => {
    if (purpose.kind === 'instructions') {
      return 'APEX wants to change a file that guides how it works from now on. It changes only if you agree; “Command” shows which file.'
    }

    const what = purpose.kind === 'code' ? 'some code' : 'a command'

    const ask = title
      ? `APEX wants to run ${what} on your computer to ${title.charAt(0).toLowerCase()}${title.slice(1)}.`
      : `APEX wants to run ${what} on your computer.`

    const risk = purpose.risk ? ` ${EN_RISKS[purpose.risk]}` : ''

    return `${ask}${risk} It runs only if you agree; “Command” shows exactly what it is.`
  }
}

export const SINGLE_THREAD_PROCESS_COPY: Readonly<Record<Locale, SingleThreadProcessCopy>> = {
  ar: en,
  en,
  ja: en,
  zh,
  'zh-hant': zhHant
}

/** Outside React: the step fold runs in a selector, not a component. */
export function singleThreadProcessCopyNow(): SingleThreadProcessCopy {
  return SINGLE_THREAD_PROCESS_COPY[getRuntimeI18nLocale()] ?? en
}
