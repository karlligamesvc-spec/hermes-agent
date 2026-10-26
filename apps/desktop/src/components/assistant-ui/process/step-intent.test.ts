import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { setRuntimeI18nLocale } from '@/i18n'

import { plainApprovalSentence, plainStageLine } from './plain-steps'
import {
  approvalPurpose,
  callIntent,
  lookTopics,
  mergedLookTopics,
  shellSegments,
  stageProgress,
  terminalIntent
} from './step-intent'
import { buildTurnSteps, type TurnPart } from './turn-process'

// hc-1066: what a call is for, read from the argument shapes of the
// 2026-10-26 editing trace (paths made up, command shapes as the agent wrote them).

const W = '/Users/me/.apexnodes/cache/scratch/vlog'

beforeEach(() => setRuntimeI18nLocale('zh'))
afterEach(() => setRuntimeI18nLocale('en'))

describe('terminal commands', () => {
  it.each([
    ['ffprobe -v error -show_entries format=duration -of json "/Users/me/Downloads/a 2.MP4"', 'probe'],
    [`mkdir -p ${W}/frames`, 'folder'],
    [
      `ffmpeg -y -v error -i "/Users/me/Downloads/a.MP4" -vf "fps=1/1.4,scale=360:-1" -frames:v 3 ${W}/frames/a_%02d.png`,
      'frames'
    ],
    [
      `ffmpeg -y -v error -pattern_type glob -i "${W}/frames/*.png" -filter_complex "tile=4x3:padding=6" -frames:v 1 ${W}/contact.png`,
      'frames'
    ],
    [`ffmpeg -y -v error -ss 8.2 -i "${W}/build/final.mp4" -frames:v 1 ${W}/f_talk.png`, 'frames'],
    [
      `ffmpeg -y -v error -i "${W}/build/final.mp4" -vf "select='eq(n\\,60)',tile=3x2" -fps_mode passthrough -frames:v 1 ${W}/check.png`,
      'frames'
    ],
    ['ffmpeg -version', 'tools'],
    ['ls /System/Library/Fonts', 'fonts'],
    [`ffmpeg -hide_banner -i "${W}/build/final.mp4" -af volumedetect -f null -`, 'loudness'],
    [`ffmpeg -hide_banner -i "${W}/build/final.mp4" -vf "blackdetect=d=0.2:pix_th=0.08" -an -f null -`, 'blackframes'],
    [`python3 ${W}/build.py`, 'render'],
    [`python3 ${W}/subs.py`, 'subtitles'],
    [`cp "${W}/build/final.mp4" "/Users/me/Downloads/宣传片_43s.mp4"`, 'save'],
    [`ffmpeg -i in.mp4 -vf "subtitles=${W}/subs.srt" out.mp4`, 'subtitles'],
    ['ffmpeg -i in.mp4 -vn -c:a libmp3lame voice.mp3', 'audio'],
    ['ffmpeg -i a.mp4 -i b.mp4 -filter_complex concat=n=2:v=1 out.mp4 2>&1 | tail -5', 'render'],
    [`mkdir -p ${W}/out && cd ${W} && ffmpeg -i in.mp4 out/clip.mp4`, 'render'],
    [`bash -lc "ffprobe -v error ${W}/in.mp4"`, 'probe'],
    ['python3 -c "import json; print(json.load(open(\'a.segments.json\')))"', 'transcript'],
    ["python3 - <<'EOF'\nimport subprocess\nsubprocess.run(['ffmpeg', '-i', 'a.mp4', 'b.mp4'])\nEOF", 'render'],
    [`rm -rf ${W}/frames`, 'cleanup'],
    ['curl -L -o clip.mp4 https://example.cn/clip.mp4', 'download'],
    ['pip3 install pysrt', 'install'],
    ['sips -Z 1080 cover.png', 'image'],
    ['echo done', null],
    ['say 你好', null]
  ])('%s → %s', (command, intent) => {
    expect(terminalIntent(command)).toBe(intent)
  })

  it('splits on operators but not inside quotes, and keeps redirections out of the words', () => {
    expect(shellSegments(`mkdir -p "a b" && ffmpeg -i "x;y.mp4" out.mp4 2>&1 | tail -3`)).toEqual([
      ['mkdir', '-p', 'a b'],
      ['ffmpeg', '-i', 'x;y.mp4', 'out.mp4', '2>&1'],
      ['tail', '-3']
    ])
  })
})

describe('files and code', () => {
  it.each([
    ['write_file', { path: `${W}/build.py`, content: 'import subprocess' }, 'writeEdit'],
    ['write_file', { path: `${W}/subs.py`, content: 'x = 1' }, 'writeSubs'],
    ['patch', { path: `${W}/build.py`, old_string: 'a', new_string: 'b' }, 'editEdit'],
    ['patch', { path: `${W}/subs.py`, old_string: 'a', new_string: 'b' }, 'editSubs'],
    ['patch', { mode: 'patch', patch: `*** Begin Patch\n*** Update File: ${W}/tools.py\n@@\n-a\n+b` }, 'editScript'],
    ['write_file', { path: `${W}/build/subs.srt`, content: '1' }, 'writeSubs'],
    ['write_file', { path: '/Users/me/文稿/口播稿.md', content: '# 稿' }, 'writeDoc'],
    ['write_file', { path: `${W}/notes.bin`, content: '' }, null],
    ['read_file', { path: '/Users/me/.apexnodes/cache/documents/视频转写_962b8184.segments.json' }, 'transcript'],
    ['read_file', { path: `${W}/build/subs.srt` }, 'readSubs'],
    ['execute_code', { code: 'ass = open("build/subs.ass").read()\n# 从 subs.ass 导出一份 SRT' }, 'subtitles'],
    ['execute_code', { code: 'import json\nsegs = json.load(open("a.segments.json"))' }, 'transcript'],
    ['execute_code', { code: 'import json\nprint(json.dumps({"a": 1}))' }, 'data'],
    ['execute_code', { code: 'print(1 + 1)' }, null],
    ['web_search', { query: '收纳' }, null]
  ])('%s %j → %s', (toolName, args, intent) => {
    expect(callIntent(toolName, args)).toBe(intent)
  })
})

describe('what a look at an image checks', () => {
  it.each([
    [
      '这是一张 4x3 的联系表。请逐行描述每个视频里的人物（性别、年龄感、穿着、发型）、场景环境、镜头景别和构图，以及画面里能看到的文字/字幕。',
      ['people', 'scene']
    ],
    [
      '这是成片每4.8秒抽一帧的九宫格。请逐格说明：画面主体是什么、有没有中文字幕、字幕文字是否正常显示（不是方块/乱码）。',
      ['subtitles', 'text']
    ],
    ['三格都是AI口播镜头（重构图后）。判断：1）画面里还能看到手吗？2）人物头部有没有被裁到？', ['framing', 'people']],
    ['这一帧：能看到手吗？头顶有没有留空间？', ['framing']],
    ['近看：画面质感是否更像实拍，还有没有明显的AI破绽？', ['quality', 'artifacts']],
    ['这是什么？', []]
  ])('%s', (question, topics) => {
    expect(lookTopics(question)).toEqual(topics)
  })

  it('names a run of looks by what most of them checked', () => {
    expect(
      mergedLookTopics([
        '判断人物是否可信、是否有明显AI畸形（手、脸）、构图是否适合竖屏。',
        '逐格说明每格画面内容、是否有明显AI崩坏或文字乱码。'
      ])
    ).toEqual(['artifacts', 'people'])
  })
})

const call = (id: string, toolName: string, args: Record<string, unknown>) =>
  ({
    args,
    completedAt: 2,
    result: { ok: true },
    timestamp: 1,
    toolCallId: id,
    toolName,
    type: 'tool-call'
  }) as TurnPart

const EDITING: TurnPart[] = [
  call('p1', 'terminal', { command: 'ffprobe -v error a.MP4' }),
  call('p2', 'terminal', { command: 'ffprobe -v error b.MP4' }),
  call('f1', 'terminal', { command: 'ffmpeg -i a.MP4 -frames:v 1 a.png' }),
  call('l1', 'vision_analyze', { image_url: 'a.png', question: '描述人物和场景' }),
  call('v1', 'text_to_speech', { text: '你好' }),
  call('v2', 'generate_video', { prompt: '口播' }),
  call('w1', 'write_file', { path: 'build.py', content: 'x' }),
  call('r1', 'terminal', { command: 'python3 build.py' }),
  call('f2', 'terminal', { command: 'ffmpeg -i final.mp4 -frames:v 1 c.png' }),
  call('l2', 'vision_analyze', { image_url: 'c.png', question: '只看字幕' }),
  call('e1', 'patch', { path: 'build.py', old_string: 'a', new_string: 'b' }),
  call('r2', 'terminal', { command: 'python3 build.py' })
]

describe('the step fold in single-thread product mode', () => {
  it('names each step by what it does and folds repeats of the same purpose', () => {
    const { steps } = buildTurnSteps(EDITING, false, true)

    expect(steps.map(step => [step.copy.title, step.copy.done(step.facts)])).toEqual([
      ['查看视频信息', '查看了 2 个文件'],
      ['抽帧', '抽好了'],
      ['看画面：人物、场景', '看过了'],
      ['生成配音', '配音做好了'],
      ['生成视频', '视频做好了'],
      ['写剪辑步骤', '写好了'],
      ['合成视频', '合成好了'],
      ['抽帧', '抽好了'],
      ['看画面：字幕', '看过了'],
      ['调整剪辑步骤', '调整好了'],
      ['合成视频', '合成好了']
    ])
  })

  it('keeps the tool fold and the tool’s own words when the mode is off', () => {
    const { steps } = buildTurnSteps(EDITING, false)

    expect(steps.map(step => step.copy.title)).toEqual([
      '在电脑上处理',
      '看图片',
      '生成配音',
      '生成视频',
      '写文件',
      '在电脑上处理',
      '看图片',
      '改文件',
      '在电脑上处理'
    ])
    expect(steps.some(step => 'intent' in step)).toBe(false)
  })

  it('says where the task stands once it is past its first stage', () => {
    const { steps } = buildTurnSteps(EDITING, false, true)
    const upTo = (count: number) => plainStageLine(steps.slice(0, count))

    expect(upTo(3)).toBeNull()
    expect(upTo(5)).toBe('已看完素材，正在生成素材')
    expect(upTo(7)).toBe('已看完素材、生成好素材，正在剪辑')
    expect(upTo(9)).toBe('已看完素材、生成好素材、剪好初版，正在核对成片')
    expect(upTo(11)).toBe('已看完素材、生成好素材、核对过成片，正在修改成片（第 2 轮）')
    expect(stageProgress(steps)).toEqual({ current: 'edit', done: ['look', 'make', 'check'], round: 2 })
  })
})

describe('the sentence above an approval', () => {
  it.each([
    [
      'ass = open("build/subs.ass").read()',
      'execute_code script execution. The script can spawn subprocesses or mutate files.',
      'APEX 想在你的电脑上运行一段程序，用来做字幕。你同意了才会执行，点「命令」可以看具体内容。'
    ],
    [
      'print(1)',
      'execute_code script execution.',
      'APEX 想在你的电脑上运行一段程序。你同意了才会执行，点「命令」可以看具体内容。'
    ],
    [
      `python3 -c "import os" && python3 ${W}/build.py`,
      'script execution via -e/-c flag',
      'APEX 想在你的电脑上运行一条命令，用来合成视频。你同意了才会执行，点「命令」可以看具体内容。'
    ],
    [
      `rm -rf ${W}/frames`,
      'recursive delete',
      'APEX 想在你的电脑上运行一条命令，用来清理临时文件。其中会删除文件。你同意了才会执行，点「命令」可以看具体内容。'
    ],
    [
      '<write to AGENTS.md>',
      'Write to protected agent-instruction file(s): AGENTS.md. These files steer future agent behavior.',
      'APEX 想改一份会影响它以后怎么做事的说明文件。你同意了才会改，点「命令」可以看是哪份文件。'
    ]
  ])('%s', (command, description, sentence) => {
    expect(plainApprovalSentence(command, description)).toBe(sentence)
  })

  it('reads the risk only from the engine’s description of a command, never from code', () => {
    expect(approvalPurpose('rm -rf x', 'recursive delete').risk).toBe('delete')
    expect(approvalPurpose('os.remove(x)', 'execute_code script execution').risk).toBeNull()
  })
})
