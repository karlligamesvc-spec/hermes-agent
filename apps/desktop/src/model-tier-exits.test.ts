/**
 * hc-960 exit inventory, made executable.
 *
 * 1. Every surface that picks or names a model carries its tier-mode gate.
 *    Matched on CODE with comments stripped, so a gate that survives only as
 *    a comment (or a word in one) does not pass. Surfaces the render guard
 *    (model-tier-guard.test.tsx) already exercises are not repeated here.
 * 2. Every file that uses a model-picking component is on a reviewed list.
 *    A new consumer (an upstream merge, a new screen) fails here until someone
 *    decides what it does on an APEX account — the class of bug where the fix
 *    covers the exits that were seen and misses the next one (AGENTS #12).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

const SRC = join(__dirname)

function code(file: string): string {
  return readFileSync(join(SRC, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

const GATES: ReadonlyArray<readonly [exit: string, file: string, gate: RegExp]> = [
  // The shared gates the surfaces below lean on.
  [
    'the hide-in-tier-mode wrapper',
    'components/model-tier/hidden-in-tier-mode.tsx',
    /return useModelTierMode\(\) \? null : children/
  ],
  [
    'free-tier status as the chrome sees it',
    'store/model-tiers.ts',
    /\(status, tierMode\) =>\s*tierMode \? null : status/
  ],
  // Pickers.
  [
    'composer model pill (main, tiles, Start input)',
    'app/chat/composer/model-pill.tsx',
    /if \(modelTierMode\) \{\s*return null\s*\}\s*if \(!model\.modelMenuContent\)/
  ],
  [
    'composer reasoning pill',
    'app/chat/composer/reasoning-pill.tsx',
    /if \(modelTierMode \|\| !model\.reasoningMenuContent/
  ],
  [
    '⌘⇧M model-picker chord',
    'app/hooks/use-keybinds.ts',
    /'composer\.modelPicker': \(\) => \{\s*if \(\$modelTierMode\.get\(\)\) \{\s*return\s*\}/
  ],
  [
    'shortcuts panel row',
    'app/shell/keybind-panel.tsx',
    /!\(modelTierMode && MODEL_TIER_HIDDEN_KEYBIND_ACTIONS\.has\(action\.id\)\)/
  ],
  [
    'Settings › 快捷键 row',
    'app/settings/keybind-settings.tsx',
    /!\(modelTierMode && MODEL_TIER_HIDDEN_KEYBIND_ACTIONS\.has\(action\.id\)\)/
  ],
  [
    '/model and /moa',
    'app/session/hooks/use-prompt-actions/slash.ts',
    /if \(\$modelTierMode\.get\(\) && MODEL_TIER_BLOCKED_SLASH_COMMANDS\.has\(/
  ],
  [
    'slash output (/status Model line)',
    'app/session/hooks/use-prompt-actions/slash.ts',
    /\$modelTierMode\.get\(\)\s*\?\s*maskModelNamesInText\(raw,/
  ],
  [
    'free-tier composer strip',
    'app/chat/composer/status-stack/index.tsx',
    /const freeTierStatus = useStore\(\$freeTierStatusForChrome\)/
  ],
  [
    'free-tier status chip',
    'app/shell/hooks/use-statusbar-items.tsx',
    /const freeTier = useStore\(\$freeTierStatusForChrome\)/
  ],
  [
    'free-tier sign-in dialog',
    'components/free-tier/sign-in-dialog.tsx',
    /const owned = claim === id && !modelTierMode/
  ],
  [
    'onboarding Nous Portal recommendation',
    'components/desktop-onboarding-overlay.tsx',
    /filter\(p => !\(modelTierMode && p\.id === FEATURED_ID\)\)/
  ],
  [
    'video Q&A model select',
    'app/business-workspace/components/source-question-model-picker.tsx',
    /if \(modelTierMode\) \{\s*return null\s*\}/
  ],
  ['scheduled-job model override', 'app/cron/index.tsx', /<HiddenInModelTierMode>\s*<Field htmlFor="cron-model"/],
  [
    'image/video backend model catalog',
    'app/settings/toolset-config-panel.tsx',
    /<HiddenInModelTierMode>\s*<ModelCatalogPicker\b/
  ],
  [
    'local-model tip on the model pill',
    'components/tips/local-setup-offer.ts',
    /if \(\$modelTierMode\.get\(\)\) \{\s*return false\s*\}/
  ],
  [
    'Settings › 模型 page goes through the tier switch',
    'app/settings/config-settings.tsx',
    /<ModelSection onMainModelChanged=/
  ],
  [
    '… which is 档位 in tier mode',
    'app/settings/model-tier-settings.tsx',
    /useModelTierMode\(\) \? <ModelTierSettings \{\.\.\.props\} \/> : <ModelSettings/
  ],
  [
    'model-tuning config fields',
    'app/settings/config-settings.tsx',
    /tierMode \? MODEL_TIER_HIDDEN_CONFIG_KEYS : undefined/
  ],
  [
    'provider pages fold into 档位 › 高级',
    'app/settings/index.tsx',
    /\.filter\(group => !\(tierMode && group\.id === 'providers'\)\)/
  ],
  [
    'settings search fields',
    'app/settings/use-settings-search.ts',
    /tierMode \? MODEL_TIER_HIDDEN_CONFIG_KEYS : undefined/
  ],
  [
    '⌘K provider entries',
    'app/command-palette/index.tsx',
    /filter\(entry => !\(tierMode && entry\.tab\.startsWith\('providers'\)\)\)/
  ],
  [
    '⌘K settings fields',
    'app/command-palette/index.tsx',
    /filter\(key => !\(tierMode && MODEL_TIER_HIDDEN_CONFIG_KEYS\.has\(key\)\)\)/
  ],
  [
    'Bot Mode create: tier cards in the main form',
    'plugins/hermes-bots/create-dialog.tsx',
    /<NewBotTierField choice=\{newModel\} \/>/
  ],
  [
    'Bot Mode create: tier cards when the bot runs here',
    'plugins/hermes-bots/bot-tier.tsx',
    /shown: tierMode && !remoteTarget/
  ],
  [
    'Bot Mode create: picker only off tier',
    'plugins/hermes-bots/bot-tier.tsx',
    /if \(choice\.shown\) \{\s*return null\s*\}\s*return \(\s*<ModelPicker\b/
  ],
  [
    'Bot Mode create: writes the alias',
    'plugins/hermes-bots/bot-tier.tsx',
    /if \(shown\) \{\s*return \{ model: MODEL_TIER_ALIAS\[tier\], provider: MODEL_TIER_PROVIDER \}/
  ],
  [
    'Bot Mode create: sends those fields',
    'plugins/hermes-bots/create-dialog.tsx',
    /\.\.\.createModelFields\(newModel\)/
  ],
  [
    'Bot Mode edit: tier cards in the main form',
    'plugins/hermes-bots/edit-profile-dialog.tsx',
    /<EditBotTierField tier=\{tier\} \/>/
  ],
  [
    'Bot Mode edit: saves the staged tier',
    'plugins/hermes-bots/edit-profile-dialog.tsx',
    /const toApply = tier\.applyTo\(adv\)[\s\S]{0,300}applyAdvancedConfig\(bot, toApply\)/
  ],
  [
    'Bot Mode advanced editor',
    'plugins/hermes-bots/profile-config.tsx',
    /modelTierMode && !bot\.remoteSource \? null : \(\s*<ModelPicker/
  ],
  ['Kanban new-task model', 'plugins/kanban/board.tsx', /<HiddenInModelTierMode>\s*<Field label=\{k\.model\}>/],
  ['Kanban task model', 'plugins/kanban/drawer.tsx', /<HiddenInModelTierMode>\s*<MetaRow label=\{k\.model\}>/],
  // Places that only NAME a model.
  ['scheduled-job model row', 'app/cron/index.tsx', /modelTierMode\s*\?\s*jobModel\(job\) && modelTierDisplayName\(/],
  [
    'subagent row title',
    'components/assistant-ui/tool/delegate.tsx',
    /const modelName = useUserFacingModelName\(\)[\s\S]*row\.model \? modelName\(row\.model\)/
  ],
  [
    'session card footer',
    'app/chat/sidebar/session-row.tsx',
    /const modelName = useUserFacingModelName\(\)\s*const model = card && session\.model \? modelName\(session\.model\)/
  ],
  [
    'agents graph subtitle',
    'app/agents/index.tsx',
    /node\.model && modelTierMode \? modelTierDisplayName\(node\.model\)/
  ],
  ['profile card model row', 'app/profiles/index.tsx', /modelTierMode\s*\?\s*\{\s*label: tierCopy\.lineLabel/],
  [
    'profile "最常用模型"',
    'app/profile/index.tsx',
    /return useModelTierMode\(\) \? undefined : usage\.by_model\[0\]\?\.model/
  ],
  ['… read only through that gate', 'app/profile/index.tsx', /const topModel = useTopModelInsight\(usage\)/],
  [
    'command-center "Top models"',
    'app/command-center/index.tsx',
    /modelTierMode \? null : \(\s*<UsageList\s+emptyLabel=\{cc\.noModelUsage\}/
  ],
  [
    'Bot Mode routine model row',
    'plugins/hermes-bots/cron.tsx',
    /modelTierMode\s*\?\s*\[modelTierCopyNow\(\)\.lineLabel/
  ],
  // 换更强的再答一次.
  [
    '换更强的再答一次 under the answer',
    'components/assistant-ui/thread/assistant-message.tsx',
    /<RetryStrongerButton \/>/
  ],
  [
    'retry, primary chat',
    'app/session/hooks/use-prompt-actions/index.ts',
    /retryTierFromReloadConfig\(config\)[\s\S]{0,200}switchSessionToModelTier\(requestGateway, sessionId, retryTier\)/
  ],
  [
    'retry, side tile',
    'app/chat/session-tile-actions.ts',
    /retryTierFromReloadConfig\(config\)[\s\S]{0,300}switchSessionToModelTier\(requestSessionGateway, runtimeIdRef\.current, retryTier\)/
  ]
]

describe('every model exit carries its tier-mode gate', () => {
  it.each(GATES)('%s (%s)', (_exit, file, gate) => {
    expect(code(file)).toMatch(gate)
  })

  it('leaves no raw model picker in the Bot Mode advanced editor', () => {
    // The three layouts render the one gated element; a fourth raw
    // <ModelPicker would bypass it.
    expect(code('plugins/hermes-bots/profile-config.tsx').match(/<ModelPicker\b/g)).toHaveLength(1)
  })
})

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)

    if (statSync(path).isDirectory()) {
      return sourceFiles(path)
    }

    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [relative(SRC, path)] : []
  })
}

/** Components and calls that let a user pick a model, and every file allowed
 *  to use them — each with what keeps it off an APEX account in tier mode. */
const PICKER_CONSUMERS: ReadonlyArray<readonly [symbol: RegExp, files: Record<string, string>]> = [
  [
    /<ModelPill\b/,
    {
      'app/chat/composer/controls.tsx': 'the pill returns null in tier mode (model-pill.tsx gate)',
      'app/business-workspace/components/business-goal-launcher.tsx': 'the same self-gating pill on the Start input'
    }
  ],
  [/<ReasoningPill\b/, { 'app/chat/composer/controls.tsx': 'the pill returns null in tier mode' }],
  [
    /<ModelMenuPanel\b/,
    {
      'app/contrib/surfaces.tsx': 'menu content of the composer pill — unreachable with the pill hidden',
      'app/chat/session-tile.tsx': 'menu content of a tile composer pill — same gate',
      'app/desktop-controller.tsx': 'legacy shell, not mounted (the app root is the contrib shell)'
    }
  ],
  [
    /<ModelCatalogMenu\b/,
    {
      'app/shell/model-menu-panel.tsx': 'inside ModelMenuPanel (above)',
      'plugins/kanban/model-override.tsx': 'inside ModelOverrideField (below)'
    }
  ],
  [
    /<ModelOverrideField\b/,
    {
      'plugins/kanban/board.tsx': 'wrapped in HiddenInModelTierMode',
      'plugins/kanban/drawer.tsx': 'wrapped in HiddenInModelTierMode'
    }
  ],
  [
    /<ModelPickerDialog\b/,
    {
      'app/model-picker-overlay.tsx': 'overlay returns null in tier mode (render guard)',
      'components/desktop-onboarding-overlay.tsx':
        'BYOK provider onboarding — reached via 档位 › 高级 for the user’s own service',
      'components/onboarding/flow.tsx': 'same BYOK onboarding flow'
    }
  ],
  [
    /setModelPickerOpen\(true\)/,
    {
      'app/chat/composer/model-pill.tsx': 'the pill is hidden',
      'app/hooks/use-keybinds.ts': 'chord returns early in tier mode',
      'app/session/hooks/use-prompt-actions/slash.ts': '/model is answered with the tier hint first',
      'components/free-tier/notice-strip.tsx': 'strip is not mounted: free-tier status is null for the chrome',
      'components/free-tier/sign-in-dialog.tsx': 'dialog never owns the flow in tier mode'
    }
  ],
  [
    /<ModelPicker\b/,
    {
      'plugins/hermes-bots/bot-tier.tsx': 'NewBotModelPicker returns null while the tier cards show',
      'plugins/hermes-bots/profile-config.tsx': 'the one gated modelPicker element'
    }
  ],
  [
    /<ModelSettings\b/,
    {
      'app/settings/model-tier-settings.tsx': 'ModelSection’s non-tier branch, and the 高级 fold with ownProvidersOnly'
    }
  ],
  [
    /<SourceQuestionModelPicker\b/,
    { 'app/business-workspace/components/video-source-conversation.tsx': 'returns null in tier mode' }
  ],
  [/<ModelCatalogPicker\b/, { 'app/settings/toolset-config-panel.tsx': 'wrapped in HiddenInModelTierMode' }]
]

describe('every model picker consumer has been reviewed for tier mode', () => {
  const files = sourceFiles(SRC)

  it.each(PICKER_CONSUMERS.map(([symbol, allowed]) => [String(symbol), symbol, allowed] as const))(
    '%s',
    (_label, symbol, allowed) => {
      const users = files.filter(file => symbol.test(code(file))).sort()

      expect(users).toEqual(Object.keys(allowed).sort())
    }
  )
})
