/**
 * hc-1066 「过程说人话」: what a step is for, read from its arguments.
 *
 * A 37-minute editing task (2026-10-26 trace) showed 47 terminal calls as
 * 「正在电脑上处理」 and 17 image looks as 「正在看图片」: the step names came
 * from the tool, so every probe, frame grab and render read the same. Here a
 * call's arguments say what it is doing — the command a terminal runs, the
 * question asked of an image, the file a script is written to, the code run —
 * as an intent id the copy table (`i18n/single-thread-process.ts`) puts into
 * words. Paths, commands and code never leave this file: an id is all the
 * screen gets. No intent means the tool's own name, as before.
 *
 * Pure, so the classifier is tested on the trace's real argument shapes.
 */

export type StepIntent =
  | 'audio'
  | 'blackframes'
  | 'cleanup'
  | 'data'
  | 'download'
  | 'editDoc'
  | 'editEdit'
  | 'editScript'
  | 'editSubs'
  | 'files'
  | 'folder'
  | 'fonts'
  | 'frames'
  | 'image'
  | 'install'
  | 'loudness'
  | 'open'
  | 'probe'
  | 'program'
  | 'readData'
  | 'readDoc'
  | 'readSubs'
  | 'render'
  | 'save'
  | 'silence'
  | 'subtitles'
  | 'tools'
  | 'transcribe'
  | 'transcript'
  | 'writeDoc'
  | 'writeEdit'
  | 'writeScript'
  | 'writeSubs'

/** What a look at an image is checking, in the order the question asks. */
export type LookTopic = 'artifacts' | 'framing' | 'people' | 'product' | 'quality' | 'scene' | 'subtitles' | 'text'

// When one command does several things (`mkdir -p out && ffmpeg …`), the most
// telling one names it: making the video beats making the folder for it.
const PRIORITY: readonly StepIntent[] = [
  'render',
  'subtitles',
  'audio',
  'frames',
  'image',
  'transcribe',
  'blackframes',
  'silence',
  'loudness',
  'probe',
  'download',
  'install',
  'transcript',
  'data',
  'program',
  'save',
  'open',
  'cleanup',
  'fonts',
  'tools',
  'files',
  'folder'
]

const VIDEO_EXT = /\.(avi|flv|gif|m4v|mkv|mov|mp4|mts|ts|webm)$/i
const IMAGE_EXT = /\.(bmp|heic|jpe?g|png|tiff?|webp)$/i
const AUDIO_EXT = /\.(aac|flac|m4a|mp3|ogg|opus|wav)$/i
const SUBTITLE_EXT = /\.(ass|srt|ssa|vtt)$/i
const SCRIPT_EXT = /\.(bat|cjs|command|js|mjs|ps1|py|rb|sh|ts|zsh)$/i
const DOC_EXT = /\.(docx?|md|pdf|rtf|txt)$/i
const DATA_EXT = /\.(csv|json|jsonl|tsv|xlsx?|ya?ml)$/i

const SEPARATORS = new Set(['&&', '||', ';', '|', '&', '\n'])

/** A command line, as words per pipeline segment. Quotes group, operators split. */
export function shellSegments(command: string): string[][] {
  const segments: string[][] = [[]]
  let word = ''
  let quoted = false
  let quote = ''

  const push = () => {
    if (word || quoted) {
      segments[segments.length - 1].push(word)
    }

    word = ''
    quoted = false
  }

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]

    if (quote) {
      if (char === quote) {
        quote = ''
      } else if (char === '\\' && quote === '"' && i + 1 < command.length) {
        word += command[(i += 1)]
      } else {
        word += char
      }

      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      quoted = true

      continue
    }

    if (char === '\\' && i + 1 < command.length) {
      word += command[(i += 1)]

      continue
    }

    // `2>&1`, `&>log`: a redirection, not a separator.
    if (char === '&' && (word.endsWith('>') || command[i + 1] === '>')) {
      word += char

      continue
    }

    const pair = command.slice(i, i + 2)
    const operator = pair === '&&' || pair === '||' ? pair : SEPARATORS.has(char) ? char : ''

    if (operator) {
      push()
      segments.push([])
      i += operator.length - 1

      continue
    }

    if (/\s/.test(char)) {
      push()

      continue
    }

    word += char
  }

  push()

  return segments.filter(segment => segment.length > 0)
}

const REDIRECT = /^(\d*|&)[<>]/

const WRAPPERS = new Set(['caffeinate', 'command', 'env', 'exec', 'nice', 'nohup', 'sudo', 'time', 'timeout'])

/** The program a segment runs and its arguments, past `FOO=1`, `sudo`, `time` and the like. */
function programOf(words: string[]): { args: string[]; program: string } {
  let index = 0

  while (index < words.length) {
    const word = words[index]

    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || WRAPPERS.has(word)) {
      index += 1
      // `timeout 60 ffmpeg …`: skip the wrapper's own number.
      index += word === 'timeout' && /^\d/.test(words[index] ?? '') ? 1 : 0

      continue
    }

    break
  }

  const head = words[index] ?? ''
  const program = (head.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '')

  // `2>&1`, `> log.txt`, `2>/dev/null`: where output goes is not what the command does.
  const args = words
    .slice(index + 1)
    .filter((word, at, all) => !REDIRECT.test(word) && !/^\d*[<>]{1,2}&?$/.test(all[at - 1] ?? ''))

  return { args, program }
}

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? ''

/** What a script is for, by its file name: `subs.py` makes subtitles, `build.py` the cut. */
export function scriptPurpose(fileName: string): StepIntent {
  const stem = baseName(fileName).toLowerCase()

  if (/sub|srt|caption|字幕/.test(stem)) {
    return 'subtitles'
  }

  if (/frame|thumb|sheet|contact|抽帧/.test(stem)) {
    return 'frames'
  }

  if (/audio|voice|tts|bgm|sound|music|配音|音/.test(stem)) {
    return 'audio'
  }

  if (/build|render|compose|final|edit|cut|montage|concat|merge|video|剪|合成|成片/.test(stem)) {
    return 'render'
  }

  return 'program'
}

/** What inline code does, by what it touches. */
export function codeIntent(code: string): null | StepIntent {
  if (/\.(srt|ass|vtt)\b|subtitle|字幕/i.test(code)) {
    return 'subtitles'
  }

  if (/segments|transcri|逐字稿|转写/i.test(code)) {
    return 'transcript'
  }

  if (/ffprobe/.test(code)) {
    return 'probe'
  }

  if (/ffmpeg|moviepy|VideoFileClip|VideoWriter/.test(code)) {
    return 'render'
  }

  if (/\bPIL\b|Image\.open|imread|imageio/.test(code)) {
    return 'image'
  }

  if (/\bjson\b|\bcsv\b|pandas|openpyxl|xlsx/i.test(code)) {
    return 'data'
  }

  return null
}

const FFMPEG_FILTER_FLAGS = new Set(['-af', '-filter:a', '-filter:v', '-filter_complex', '-lavfi', '-vf'])

const FFMPEG_INFO_FLAGS = new Set([
  '-codecs',
  '-encoders',
  '-filters',
  '-formats',
  '-h',
  '-help',
  '-hwaccels',
  '-version'
])

function ffmpegIntent(args: string[]): null | StepIntent {
  if (!args.includes('-i') && args.some(arg => FFMPEG_INFO_FLAGS.has(arg))) {
    return 'tools'
  }

  const filters = args.filter((_, index) => FFMPEG_FILTER_FLAGS.has(args[index - 1] ?? '')).join(' ')

  if (/volumedetect|loudnorm|ebur128|astats/.test(filters)) {
    return 'loudness'
  }

  if (/blackdetect|blackframe/.test(filters)) {
    return 'blackframes'
  }

  if (/silencedetect/.test(filters)) {
    return 'silence'
  }

  const output = args.at(-1) ?? ''
  const inputs = args.filter((_, index) => args[index - 1] === '-i')

  if (output === '-' || output === '/dev/null' || output === 'NUL') {
    return 'probe'
  }

  if (SUBTITLE_EXT.test(output) || (VIDEO_EXT.test(output) && /(^|[,;\s])(subtitles|ass)=/.test(filters))) {
    return 'subtitles'
  }

  if (VIDEO_EXT.test(output)) {
    return 'render'
  }

  if (AUDIO_EXT.test(output)) {
    return 'audio'
  }

  if (IMAGE_EXT.test(output)) {
    const fromImages = inputs.length > 0 && inputs.every(input => IMAGE_EXT.test(input) || /\*/.test(input))

    return fromImages && !/tile=/.test(filters) ? 'image' : 'frames'
  }

  return null
}

function interpreterIntent(program: string, args: string[]): null | StepIntent {
  const shell = /^(ba|z)?sh$/.test(program)
  // `bash -lc "…"`: a shell takes its flags bundled.
  const inline = args.findIndex(arg => arg === '-c' || (shell && /^-[a-z]*c$/.test(arg)))

  if (inline >= 0) {
    const code = args[inline + 1] ?? ''

    return shell ? terminalIntent(code) : codeIntent(code)
  }

  const module = args.indexOf('-m')

  if (module >= 0) {
    const name = args[module + 1] ?? ''

    return name === 'pip' ? 'install' : name === 'whisper' ? 'transcribe' : null
  }

  const script = args.find(arg => !arg.startsWith('-'))

  return script && SCRIPT_EXT.test(script) ? scriptPurpose(script) : null
}

const LIST_PROGRAMS = new Set(['cat', 'du', 'file', 'find', 'head', 'ls', 'mdls', 'stat', 'tail', 'tree', 'wc'])
const INSTALLERS = new Set(['brew', 'npm', 'pip', 'pip3', 'pnpm', 'uv', 'yarn'])
const INTERPRETERS = /^python(\d(\.\d+)?)?$|^(ba|z)?sh$|^node$/

// Programs whose name alone says what they are for.
const PROGRAM_INTENTS = new Map<string, StepIntent>([
  ['aria2c', 'download'],
  ['convert', 'image'],
  ['cp', 'save'],
  ['curl', 'download'],
  ['cwebp', 'image'],
  ['ditto', 'save'],
  ['exiftool', 'probe'],
  ['fc-list', 'fonts'],
  ['ffprobe', 'probe'],
  ['magick', 'image'],
  ['mediainfo', 'probe'],
  ['mkdir', 'folder'],
  ['mv', 'save'],
  ['open', 'open'],
  ['pngquant', 'image'],
  ['rm', 'cleanup'],
  ['rmdir', 'cleanup'],
  ['rsync', 'save'],
  ['sips', 'image'],
  ['trash', 'cleanup'],
  ['wget', 'download'],
  ['which', 'tools'],
  ['whisper', 'transcribe'],
  ['whisper-cli', 'transcribe'],
  ['youtube-dl', 'download'],
  ['yt-dlp', 'download']
])

function segmentIntent(words: string[]): null | StepIntent {
  const { args, program } = programOf(words)
  const tail = args.join(' ')

  if (program === 'ffmpeg') {
    return ffmpegIntent(args)
  }

  if (INTERPRETERS.test(program)) {
    return interpreterIntent(program, args)
  }

  if (LIST_PROGRAMS.has(program)) {
    return /fonts/i.test(tail) ? 'fonts' : 'files'
  }

  if (INSTALLERS.has(program)) {
    return /\b(add|install)\b/.test(tail) ? 'install' : null
  }

  if (program === 'type') {
    return /ff(mpeg|probe)/.test(tail) ? 'tools' : null
  }

  return PROGRAM_INTENTS.get(program) ?? (SCRIPT_EXT.test(program) ? scriptPurpose(program) : null)
}

/** What a terminal command is for, or null when it says nothing we can name. */
export function terminalIntent(command: string): null | StepIntent {
  // `python3 - <<'EOF' … EOF`: the code is the command's body.
  if (/\bpython[\d.]*\s+-\s*<</.test(command)) {
    return codeIntent(command) ?? 'program'
  }

  const found = shellSegments(command)
    .map(segmentIntent)
    .filter((intent): intent is StepIntent => intent !== null)

  if (found.length === 0) {
    return null
  }

  return [...found].sort((a, b) => PRIORITY.indexOf(a) - PRIORITY.indexOf(b))[0]
}

/** The file a write or patch touches: its `path`, or the first one a patch text names. */
function touchedPath(args: Record<string, unknown>): string {
  if (typeof args.path === 'string' && args.path.trim()) {
    return args.path.trim()
  }

  const patch = typeof args.patch === 'string' ? args.patch : ''

  return /\*\*\* (?:Add|Update) File: (.+)/.exec(patch)?.[1]?.trim() ?? ''
}

function fileIntent(toolName: string, path: string): null | StepIntent {
  const writing = toolName === 'write_file'

  if (SUBTITLE_EXT.test(path)) {
    return writing ? 'writeSubs' : 'editSubs'
  }

  if (DOC_EXT.test(path)) {
    return writing ? 'writeDoc' : 'editDoc'
  }

  if (!SCRIPT_EXT.test(path)) {
    return null
  }

  const purpose = scriptPurpose(path)

  if (purpose === 'render') {
    return writing ? 'writeEdit' : 'editEdit'
  }

  if (purpose === 'subtitles') {
    return writing ? 'writeSubs' : 'editSubs'
  }

  return writing ? 'writeScript' : 'editScript'
}

function readIntent(path: string): null | StepIntent {
  if (/segments\.json$|transcri|逐字稿|转写/i.test(path)) {
    return 'transcript'
  }

  if (SUBTITLE_EXT.test(path)) {
    return 'readSubs'
  }

  if (DOC_EXT.test(path)) {
    return 'readDoc'
  }

  return DATA_EXT.test(path) ? 'readData' : null
}

const text = (value: unknown) => (typeof value === 'string' ? value : '')

/** A call's intent from its tool and arguments; null keeps the tool's own step name. */
export function callIntent(toolName: string, args: Record<string, unknown>): null | StepIntent {
  switch (toolName) {
    case 'terminal':
      return terminalIntent(text(args.command))

    case 'execute_code':
      return codeIntent(text(args.code))

    case 'write_file':

    case 'patch':
      return fileIntent(toolName, touchedPath(args))

    case 'read_file':
      return readIntent(text(args.path))

    default:
      return null
  }
}

// Each topic's words, Chinese and English. 「字幕」 is taken out before the
// others are matched, so 「中文字幕」 does not also read as on-screen text.
const TOPICS: readonly [LookTopic, RegExp][] = [
  ['subtitles', /字幕|caption|subtitle/i],
  [
    'framing',
    /构图|構圖|景别|景別|裁|头顶|頭頂|露手|手[，,、？?）)]|看到手|画面位置|畫面位置|居中|framing|crop|composition/i
  ],
  ['artifacts', /崩坏|崩壞|畸形|破绽|破綻|乱码|亂碼|AI ?痕迹|artifact|glitch|deform/i],
  ['text', /文字|大字|读出|讀出|标题|標題|on-screen text|\btext\b/i],
  ['quality', /清晰|画质|畫質|质感|質感|颗粒|顆粒|失真|模糊|黑帧|黑幀|quality|blurr?y|sharp/i],
  ['people', /人物|人脸|人臉|表情|穿着|穿著|发型|髮型|性别|性別|年龄|年齡|\bperson\b|\bface\b|people/i],
  ['scene', /场景|場景|环境|環境|背景|光线|光線|\bscene\b|background|lighting/i],
  ['product', /商品|产品|產品|包装|包裝|product/i]
]

/** What a question asks of an image, most prominent first, at most `limit`. */
export function lookTopics(question: string, limit = 2): LookTopic[] {
  const subtitlesGone = question.replace(/字幕/g, '__')

  return TOPICS.map(([topic, words]) => {
    const match = (topic === 'subtitles' ? question : subtitlesGone).search(words)

    return { at: match, topic }
  })
    .filter(found => found.at >= 0)
    .sort((a, b) => a.at - b.at)
    .slice(0, limit)
    .map(found => found.topic)
}

const LOOK_TOOLS = new Set(['browser_vision', 'vision_analyze'])

export function isLookTool(toolName: string): boolean {
  return LOOK_TOOLS.has(toolName)
}

/** Topics across several looks: the most asked first, then the earliest. */
export function mergedLookTopics(questions: readonly string[], limit = 2): LookTopic[] {
  const tally = new Map<LookTopic, { count: number; first: number }>()

  questions.forEach((question, index) => {
    lookTopics(question, limit).forEach((topic, rank) => {
      const seen = tally.get(topic)
      const order = index * 10 + rank

      tally.set(topic, { count: (seen?.count ?? 0) + 1, first: Math.min(seen?.first ?? order, order) })
    })
  })

  return [...tally.entries()]
    .sort(([, a], [, b]) => b.count - a.count || a.first - b.first)
    .slice(0, limit)
    .map(([topic]) => topic)
}

// ── Stages: the few phases a long task moves through ──────────────────────────

export type Stage = 'check' | 'edit' | 'look' | 'make' | 'research' | 'save'

const MAKE_TOOLS = new Set([
  'generate_image',
  'generate_video',
  'image_generate',
  'text_to_speech',
  'video_generate',
  'xai_video_edit',
  'xai_video_extend'
])

const LOOK_STEP_TOOLS = new Set([
  'image_ocr',
  'media_transcribe',
  'social_download',
  'social_captions',
  'social_content'
])

const RESEARCH_TOOLS = /^(browser_|creator_top_posts$|social_|web_extract$|web_search$|x_search$)/

const SAVE_TOOLS = new Set([
  'doc_file_write',
  'feishu_bitable_write',
  'feishu_doc_write',
  'pptx_file_write',
  'xlsx_file_write'
])

// Looking that, once the cut exists, is checking it.
const CHECKING: ReadonlySet<StepIntent | 'look'> = new Set([
  'blackframes',
  'frames',
  'look',
  'loudness',
  'probe',
  'silence'
])

const LOOKING: ReadonlySet<StepIntent> = new Set(['readData', 'readDoc', 'readSubs', 'transcribe', 'transcript'])

const EDITING: ReadonlySet<StepIntent> = new Set([
  'audio',
  'data',
  'editEdit',
  'editScript',
  'editSubs',
  'image',
  'program',
  'render',
  'subtitles',
  'writeEdit',
  'writeScript',
  'writeSubs'
])

/**
 * The stage a step belongs to, or null for groundwork that belongs to
 * whatever stage it sits in (a folder, a tool check, a cleanup). `edited`:
 * whether the task has already started cutting, after which looking at frames
 * is checking the cut.
 */
export function stepStage(toolName: string, intent: null | string | undefined, edited: boolean): null | Stage {
  const kind = intent ?? (isLookTool(toolName) ? 'look' : null)

  if (kind && CHECKING.has(kind as StepIntent)) {
    return edited ? 'check' : 'look'
  }

  if (kind && LOOKING.has(kind as StepIntent)) {
    return edited ? 'edit' : 'look'
  }

  if (kind === 'save' || SAVE_TOOLS.has(toolName)) {
    return 'save'
  }

  if ((kind && EDITING.has(kind as StepIntent)) || (!kind && /^(execute_code|patch|write_file)$/.test(toolName))) {
    return 'edit'
  }

  if (MAKE_TOOLS.has(toolName)) {
    return 'make'
  }

  if (LOOK_STEP_TOOLS.has(toolName)) {
    return edited ? 'edit' : 'look'
  }

  return RESEARCH_TOOLS.test(toolName) ? 'research' : null
}

export interface StageProgress {
  /** Stages already passed, in the order they first happened, without the current one. */
  done: Stage[]
  current: Stage
  /** How many times the task has come back to the current stage (1 the first time). */
  round: number
}

/** Where a task stands, from its steps in order; null before it has a stage. */
export function stageProgress(steps: readonly { intent?: string; toolName: string }[]): null | StageProgress {
  const runs: Stage[] = []
  let edited = false

  for (const step of steps) {
    const stage = stepStage(step.toolName, step.intent, edited)

    if (!stage) {
      continue
    }

    edited ||= stage === 'edit'

    if (runs.at(-1) !== stage) {
      runs.push(stage)
    }
  }

  const current = runs.at(-1)

  if (!current) {
    return null
  }

  return {
    current,
    done: [...new Set(runs)].filter(stage => stage !== current),
    round: runs.filter(stage => stage === current).length
  }
}

// ── Approvals: what a command waiting on the user is for ──────────────────────

export type ApprovalRisk = 'delete' | 'git' | 'kill' | 'network' | 'permissions'

const RISKS: readonly [ApprovalRisk, RegExp][] = [
  ['delete', /delet|\brm\b|remov|wipe|truncate|\bdrop\b|clean|format/i],
  ['kill', /\bkill|stop|restart/i],
  ['permissions', /permission|writable|chmod|chown|acl/i],
  ['git', /\bgit\b/i],
  ['network', /upload|exfil|remote content|send .* to/i]
]

export interface ApprovalPurpose {
  intent: null | StepIntent
  /** A command line, inline code (execute_code), or a write to a file that steers the agent. */
  kind: 'code' | 'command' | 'instructions'
  risk: ApprovalRisk | null
}

/** What an approval request is for. The engine's own description says which kind it is
 *  (tools/approval.py `_EXECUTE_CODE_DESCRIPTION`, tools/file_tools_write_guards.py). */
export function approvalPurpose(command: string, description: string): ApprovalPurpose {
  const said = description.trim()

  if (said.startsWith('execute_code')) {
    return { intent: codeIntent(command), kind: 'code', risk: null }
  }

  if (said.startsWith('Write to protected agent-instruction')) {
    return { intent: null, kind: 'instructions', risk: null }
  }

  return {
    intent: terminalIntent(command),
    kind: 'command',
    risk: RISKS.find(([, words]) => words.test(said))?.[0] ?? null
  }
}
