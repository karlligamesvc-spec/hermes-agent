// The `assistant.tool` part of the Desktop i18n contract (`types.ts`): the copy
// of tool rows, run summaries and skill activity, kept beside the contract so
// neither file outgrows its size cap.

import type { ProcessCopy } from './types-process'

export type ToolTitleKey =
  | 'browser_click'
  | 'browser_fill'
  | 'browser_navigate'
  | 'browser_snapshot'
  | 'browser_take_screenshot'
  | 'browser_type'
  | 'clarify'
  | 'cronjob'
  | 'edit_file'
  | 'execute_code'
  | 'image_generate'
  | 'list_files'
  | 'memory'
  | 'patch'
  | 'read_file'
  | 'search_files'
  | 'session_search_recall'
  | 'terminal'
  | 'todo'
  | 'vision_analyze'
  | 'web_extract'
  | 'web_search'
  | 'write_file'

interface ToolTitleCopy {
  done: string
  pending: string
  pendingAction: string
}

/** One category of a tool run's summary line ("Explored 3 files"). */
interface RunCategoryCopy {
  past: string
  present: string
  count: (count: number) => string
}

export interface AssistantToolCopy {
  copyCode: string
  renderingImage: string
  copyOutput: string
  copyCommand: string
  copyContent: string
  copyUrl: string
  copyResults: string
  copyQuery: string
  copyFile: string
  copyPath: string
  failedCalls: (count: number) => string
  skillActivity: {
    loading: string
    loaded: string
    loadFailed: string
    readingResource: string
    readResource: string
    resourceFailed: string
    listing: string
    listed: string
    listFailed: string
    unavailable: string
  }
  outputAlt: string
  rawResponse: string
  copyActivity: string
  recoveredOne: string
  recoveredMany: (count: number) => string
  failedOne: string
  failedMany: (count: number) => string
  statusRunning: string
  statusError: string
  statusRecovered: string
  statusDone: string
  /** Over-budget / rejected memory write title — not "Saved to memory". */
  resultUnavailable: string
  memoryWriteNoted: string
  actions: {
    read: string
    reading: string
    opened: string
    opening: string
    failedToOpen: string
    searched: string
    searching: string
    ran: string
    running: string
    ranCode: string
    runningCode: string
  }
  prefixes: {
    browser: string
    web: string
  }
  titleTemplates: {
    actionCommand: (action: string, command: string) => string
    actionQuoted: (action: string, value: string) => string
    actionTarget: (action: string, target: string) => string
    prefixedDone: (prefix: string, action: string) => string
    runningPrefixedTool: (prefix: string, action: string) => string
    runningTool: (action: string) => string
    /** Finished title for a tool with no entry in `titles` or `toolNames`;
     *  `action` is the humanized code name. */
    unknownToolDone: (action: string) => string
  }
  titles: Record<ToolTitleKey, ToolTitleCopy>
  /** Titles for registered tools outside `titles`, keyed by tool name.
   *  English leaves it empty and shows the humanized code name; a locale
   *  that fills it never shows a code name for a tool it lists. */
  toolNames: Record<string, ToolTitleCopy>
  /** Skill display names keyed by skill name (the slug). */
  skillNames: Record<string, string>
  /** What a skill with no `skillNames` entry is called: English shows the
   *  slug, a locale that must not show slugs returns ''. */
  skillNameFallback: (slug: string) => string
  /** `label` is the skill action ("Loaded skill"), `target` the named skill. */
  skillTitle: (label: string, target: string) => string
  /** `name` is the display name ('' when unnamed), `file` the resource path. */
  skillTarget: (name: string, file: string) => string
  /** `noun` is the singular English counting noun ("result", "file"),
   *  `plural` its English plural for `count`. */
  countLabel: (count: number, noun: string, plural: string) => string
  formatDuration: (value: string, unit: 'h' | 'm' | 'ms' | 's') => string
  /** Joins the parts of a multi-unit duration ("2m 5s"). */
  durationSeparator: string
  /** The one grey line that stands in for a run of tool calls. */
  runSummary: {
    delegate: RunCategoryCopy
    edit: RunCategoryCopy
    explore: RunCategoryCopy
    other: RunCategoryCopy
    run: RunCategoryCopy
    separator: string
  }
  detail: {
    arguments: string
    result: string
    payload: string
    search: string
    details: string
    snapshotSummary: string
    errorDetails: string
    duration: string
    toolError: string
    toolSuccessFalse: string
    toolStatus: (status: string) => string
    exitCode: (code: number) => string
    truncated: (count: string) => string
    snapshotStats: (buttons: number, links: number, inputs: number) => string
    topControls: (labels: string) => string
    noCronJobsScheduled: string
    cronSchedule: string
    cronRepeat: string
    cronDelivery: string
    cronNextRun: string
    delegatedTask: string
    /** Exit-status badge beside a command transcript. */
    exitBadge: (code: number) => string
    /** Fixed words of the generic result summary (`lib/tool-result-summary`). */
    items: (count: number) => string
    fields: (count: number) => string
    moreItems: (count: number) => string
  }
  searchResults: string
  stdoutLabel: string
  stderrLabel: string
  /** The status line, steps and sources a turn's tool work reads as (hc-973). */
  process: ProcessCopy
}
