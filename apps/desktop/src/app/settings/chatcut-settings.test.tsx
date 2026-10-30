import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setChatcutFlagForTest } from '@/store/chatcut'
import { $singleThreadMode, setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import { ChatcutSettings } from './chatcut-settings'
import { $productSettingsViews, settingsTabFolded } from './product-settings'

const api = vi.fn()

function servers(names: string[]) {
  return { servers: names.map(name => ({ name })) }
}

async function shown() {
  render(<ChatcutSettings />)
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 10))
  })
}

beforeEach(() => {
  api.mockReset()
  window.hermesDesktop = { api } as never
})

afterEach(() => {
  cleanup()
  setChatcutFlagForTest(false)
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
})

describe('the page', () => {
  it('not connected: says how to connect, offers nothing to click', async () => {
    api.mockResolvedValue(servers(['other']))
    await shown()

    expect(document.querySelector('[data-chatcut-state]')?.getAttribute('data-chatcut-state')).toBe('not-connected')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('connected: 断开 asks once, then removes the server through the ordinary route', async () => {
    api.mockResolvedValueOnce(servers(['chatcut']))
    await shown()

    const button = screen.getByRole('button')

    expect(api).toHaveBeenCalledTimes(1)
    fireEvent.click(button)
    expect(api).toHaveBeenCalledTimes(1)

    api.mockResolvedValueOnce({ ok: true })
    await act(async () => {
      fireEvent.click(screen.getByRole('button'))
      await new Promise(resolve => setTimeout(resolve, 10))
    })

    expect(api.mock.calls[1][0]).toMatchObject({ method: 'DELETE', path: '/api/mcp/servers/chatcut' })
    expect(document.querySelector('[data-chatcut-state]')?.getAttribute('data-chatcut-state')).toBe('not-connected')
  })

  it('a failed 断开 stays connected and says so', async () => {
    api.mockResolvedValueOnce(servers(['chatcut']))
    await shown()
    fireEvent.click(screen.getByRole('button'))

    api.mockRejectedValueOnce(new Error('down'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button'))
      await new Promise(resolve => setTimeout(resolve, 10))
    })

    expect(screen.getByRole('alert')).toBeTruthy()
    expect(document.querySelector('[data-chatcut-state]')?.getAttribute('data-chatcut-state')).toBe('connected')
  })

  it('an unreadable state is not reported as not connected', async () => {
    api.mockRejectedValue(new Error('starting'))
    await shown()

    expect(document.querySelector('[data-chatcut-state]')?.getAttribute('data-chatcut-state')).toBe('unknown')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('never shows the word MCP, a URL or a tool name', async () => {
    api.mockResolvedValue(servers(['chatcut']))
    await shown()

    const text = document.body.textContent ?? ''

    expect(text).not.toMatch(/mcp|https?:|oauth|token/i)
  })
})

describe('the rail', () => {
  it('product mode gets the page only with the switch on, right after the IM page', () => {
    setSingleThreadFlagForTest(true)
    setToolViewMode('product')
    expect($singleThreadMode.get()).toBe(true)

    const off = $productSettingsViews.get()

    expect(off).not.toContain('chatcut')
    expect(settingsTabFolded('chatcut')).toBe(true)

    setChatcutFlagForTest(true)

    const on = $productSettingsViews.get() ?? []

    expect(on.indexOf('chatcut')).toBe(on.indexOf('im') + 1)
    expect(on.filter(view => view !== 'chatcut')).toEqual(off)
    expect(settingsTabFolded('chatcut')).toBe(false)
  })

  it('developer mode and the single-thread switch off do not change', () => {
    setChatcutFlagForTest(true)
    expect($productSettingsViews.get()).toBeNull()

    setSingleThreadFlagForTest(true)
    setToolViewMode('technical')
    expect($productSettingsViews.get()).toBeNull()
  })
})
