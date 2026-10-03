import { describe, expect, it } from 'vitest'

import type { AutomationBlueprint } from '@/hermes'
import { TRANSLATIONS } from '@/i18n/catalog'
import { en } from '@/i18n/en'
import { zh } from '@/i18n/zh'

import { localizeBlueprint } from './blueprint-i18n'

describe('built-in blueprint presentation', () => {
  it('localizes recognized copy in every locale without rewriting backend identities or custom text', () => {
    const builtin: AutomationBlueprint = {
      key: 'custom-reminder',
      title: 'Custom reminder',
      description: 'A recurring reminder in your own words, on your schedule.',
      category: 'general',
      tags: ['reminder'],
      command: '/blueprint custom-reminder',
      appUrl: 'hermes://blueprint/custom-reminder',
      fields: [
        {
          name: 'what',
          type: 'text',
          label: 'Remind me to…',
          default: 'take a break and stretch',
          options: [],
          optional: false,
          help: ''
        },
        {
          name: 'recurrence',
          type: 'weekdays',
          label: 'Repeat on',
          default: 'everyday',
          options: ['everyday', 'weekdays', 'weekends'],
          optional: false,
          help: ''
        },
        {
          name: 'owner',
          type: 'text',
          label: 'Custom owner',
          default: 'My own wording',
          options: [],
          optional: false,
          help: 'Custom help'
        }
      ]
    }
    const untouched = structuredClone(builtin)
    const result = localizeBlueprint(builtin, zh.cron.blueprints)

    expect(result.title).toBe('自定义提醒')
    expect(result.fields[0].default).toBe('休息一下，做些伸展')
    expect(result.fields[1].optionLabels?.weekdays).toBe('工作日')
    expect(result.fields[1].default).toBe('everyday')
    expect(result.fields[1].options).toEqual(builtin.fields[1].options)
    expect(result.fields[2]).toMatchObject(builtin.fields[2])
    expect([result.key, result.command, result.appUrl, result.category, result.tags]).toEqual([
      builtin.key,
      builtin.command,
      builtin.appUrl,
      builtin.category,
      builtin.tags
    ])
    expect(builtin).toEqual(untouched)

    const custom = { ...builtin, key: 'my-extension', title: 'My template' }
    expect(localizeBlueprint(custom, zh.cron.blueprints)).toBe(custom)
    const newer = {
      ...builtin,
      title: 'Updated backend title',
      fields: [{ ...builtin.fields[0], default: 'User-authored default' }]
    }
    expect(localizeBlueprint(newer, zh.cron.blueprints)).toMatchObject({
      title: newer.title,
      fields: [{ default: 'User-authored default' }]
    })

    for (const locale of ['zh', 'zh-hant', 'ja', 'ar'] as const) {
      const copy = TRANSLATIONS[locale].cron.blueprints
      expect(copy.startFrom).not.toBe(en.cron.blueprints.startFrom)
      expect(copy.custom).not.toBe(en.cron.blueprints.custom)

      for (const [key, original] of Object.entries(en.cron.blueprints.catalog)) {
        expect(copy.catalog[key].title, `${locale}:${key}`).not.toBe(original.title)
        expect(copy.catalog[key].description, `${locale}:${key}`).not.toBe(original.description)
        for (const [field, value] of Object.entries(original.defaults ?? {})) {
          expect(copy.catalog[key].defaults?.[field], `${locale}:${key}:${field}`).not.toBe(value)
        }
      }
      for (const kind of ['fieldLabels', 'fieldHelp', 'optionLabels'] as const) {
        for (const [key, original] of Object.entries(en.cron.blueprints[kind])) {
          expect(copy[kind][key], `${locale}:${kind}:${key}`).not.toBe(original)
        }
      }
    }
  })
})
