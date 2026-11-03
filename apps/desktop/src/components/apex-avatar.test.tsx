/**
 * hc-1077: the avatar's two new parameters — shape and colour — and the
 * tables the sidebar and the new-assistant sheet read. Without them it is
 * APEX's purple disc, unchanged (src/apex-avatar-identity.test.tsx pins the
 * exact drawing).
 */
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import {
  APEX_AVATAR_COLOR,
  APEX_AVATAR_SHAPES,
  APEX_BOT_COLORS,
  APEX_BOT_DEFAULT_LOOK,
  ApexAvatar,
  apexBotColorHex
} from './apex-avatar'

const children = (node: Element) => [...node.children].map(child => child.outerHTML)

/** WCAG relative luminance of a #RRGGBB colour. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(at => {
    const channel = Number.parseInt(hex.slice(at, at + 2), 16) / 255

    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })

  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)

  return (hi! + 0.05) / (lo! + 0.05)
}

describe('hc-1077 the avatar in another shape and colour', () => {
  it('without them is APEX: the same purple disc, drawn the same way', () => {
    const plain = render(<ApexAvatar />).container.querySelector('svg')!
    const spelled = render(<ApexAvatar color={APEX_AVATAR_COLOR} shape="circle" />).container.querySelector('svg')!

    expect(children(spelled)).toEqual(children(plain))
    expect(plain.querySelector('circle')?.getAttribute('fill')).toBe('#6A4CEB')
  })

  it.each(APEX_AVATAR_SHAPES.filter(shape => shape !== 'circle'))(
    'draws %s as one filled path under the same eyes',
    shape => {
      const svg = render(<ApexAvatar color="#2563D9" shape={shape} />).container.querySelector('svg')!

      expect(svg.getAttribute('viewBox')).toBe('0 0 28 28')
      expect(svg.querySelector('circle')).toBeNull()
      expect(svg.querySelectorAll('path')).toHaveLength(1)
      expect(svg.querySelector('path')?.getAttribute('fill')).toBe('#2563D9')
      expect(
        [...svg.querySelectorAll('rect')].map(rect => [rect.getAttribute('x'), rect.getAttribute('fill')])
      ).toEqual([
        ['8.3', '#FFFFFF'],
        ['16.1', '#FFFFFF']
      ])
    }
  )

  it.each([
    ['circle', '8', '12'],
    ['squircle', '8', '12'],
    ['pill', '9', '13'],
    ['hexagon', '8', '12'],
    ['cloud', '10', '14'],
    ['drop', '13', '17']
  ] as const)('%s: the eyes sit at %s, and look down to %s while working', (shape, idle, working) => {
    const eyes = (mood: 'idle' | 'working') =>
      [...render(<ApexAvatar mood={mood} shape={shape} />).container.querySelectorAll('rect')].map(rect => [
        rect.getAttribute('y'),
        rect.getAttribute('height')
      ])

    expect(eyes('idle')).toEqual([
      [idle, '7.4'],
      [idle, '7.4']
    ])
    expect(eyes('working')).toEqual([
      [working, '5'],
      [working, '5']
    ])
  })
})

describe('hc-1077 the looks another assistant can take', () => {
  it('offers six shapes and six colours, and the purple is not one of them (K6)', () => {
    expect(APEX_AVATAR_SHAPES).toEqual(['circle', 'squircle', 'pill', 'hexagon', 'cloud', 'drop'])
    expect(APEX_BOT_COLORS.map(color => color.id)).toEqual(['blue', 'teal', 'green', 'orange', 'rose', 'gold'])
    expect(new Set(APEX_BOT_COLORS.map(color => color.hex)).size).toBe(6)
    expect(APEX_BOT_COLORS.map(color => color.hex.toUpperCase())).not.toContain(APEX_AVATAR_COLOR.toUpperCase())
    expect(APEX_BOT_DEFAULT_LOOK).toEqual({ color: 'blue', shape: 'squircle' })
    expect(apexBotColorHex('rose')).toBe('#C93A6E')
  })

  it.each(APEX_BOT_COLORS.map(color => [color.id, color.hex]))(
    '%s holds 3:1 or more against the white eyes, in both themes (the colour does not change in dark mode)',
    (_id, hex) => {
      expect(contrast(hex, '#FFFFFF')).toBeGreaterThanOrEqual(3)
    }
  )

  it('the measure is right: APEX’s own purple passes, a pale colour fails', () => {
    expect(contrast(APEX_AVATAR_COLOR, '#FFFFFF')).toBeGreaterThan(3)
    expect(contrast('#B9A8FF', '#FFFFFF')).toBeLessThan(3)
  })
})
