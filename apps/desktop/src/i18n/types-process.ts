// The process area's copy (`assistant.tool.process`): the one status line a
// turn's tool work collapses to, the plain-language steps behind it and where
// each step's data came from. Kept beside the contract so `types.ts` does not
// grow (hc-973).

/** What a finished step came back with. Any of it can be missing. */
export interface StepFacts {
  /** How many calls the step folded together (parallel searches, a batch). */
  calls: number
  /** Items it came back with: posts, results, comments, rows… */
  count?: number
  /** Formatted length of the media it handled: 「1 分 43 秒」. */
  length?: string
  /** Formatted like count of the one item it handled: 「12.6 万」. */
  likes?: string
  /** Characters of text it produced: a transcript, captions. */
  chars?: number
  /** The first thing it searched for. */
  query?: string
  /** Display name of the platform it read: 「抖音」. */
  platform?: string
  /** It produced nothing to work with: no speech, no results. */
  empty?: boolean
}

/** One tool, as a step a user can read: what it is doing, what it did. */
export interface StepCopy {
  /** While it runs, the way the status line says it: 「正在下载视频」. */
  running: string
  /** Its name in the finished chain and the step list: 「下载视频」. */
  title: string
  /** What it came back with: 「下载了 1 个视频，1 分 43 秒，12.6 万赞」. */
  done: (facts: StepFacts) => string
  /** Where its data came from, in one sentence. Absent: nothing to say. */
  source?: (facts: StepFacts) => string
}

export interface ProcessCopy {
  /** Steps keyed by tool name. A tool without an entry is `unknownStep`. */
  steps: Record<string, StepCopy>
  /** A tool nobody named reads as plain work, never as its code name. */
  unknownStep: StepCopy
  status: {
    /** Only tool lookup and skill loading so far. */
    preparing: string
    /** No call in flight; the model is reasoning. */
    thinking: string
    /** No call in flight; the reply is being written. */
    writing: string
    /** `running` is a step's running text. */
    running: (running: string) => string
    stepOf: (index: number) => string
    stepOfTotal: (index: number, total: number) => string
    chainSeparator: string
    /** Tail of a chain too long to spell out. */
    moreSteps: (total: number) => string
    took: (duration: string) => string
    failed: (title: string) => string
    stopped: (title: string) => string
    /** A turn that only loaded skills: `names` is the joined skill names. */
    methodsOnly: (names: string) => string
  }
  showSteps: string
  hideSteps: string
  stepsLabel: string
  showSource: string
  hideSource: string
  source: {
    platform: (name: string) => string
    links: string
    queries: string
    count: (count: number) => string
  }
  stepFailed: string
  stepPartlyFailed: (count: number) => string
  stepStopped: string
  /** Under a running step that usually takes minutes. */
  slowHint: string
  /** `names` is the joined display names of the skills the turn used. */
  methods: (names: string) => string
  listSeparator: string
  subtasks: {
    title: string
    done: string
    running: string
    failed: string
    dispatched: string
  }
  reasoning: {
    thinking: string
    thought: string
    thoughtFor: (duration: string) => string
    collapse: string
  }
  failure: {
    /** What the step said went wrong is not ours to show when it is not in the
     *  user's language; this stands in for it. */
    fallbackReason: string
    keptNote: string
    retry: string
    anotherWay: string
    partial: string
    /** What each button sends, naming the step that failed. */
    retryMessage: (title: string) => string
    anotherWayMessage: (title: string) => string
    partialMessage: (title: string) => string
  }
  /** Developer mode only. */
  tech: {
    title: string
    /** `names` are the tools' code names, `duration` how long they took. */
    line: (names: string, duration: string) => string
    calls: (count: number) => string
  }
  /** 126000 → 「12.6 万」 / "126K". */
  compactNumber: (value: number) => string
  /** Platform ids as the tools pass them (`douyin`) → the name users know. */
  platforms: Record<string, string>
}
