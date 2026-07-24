import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $currentModel, $currentProvider } from '@/store/session'

import { ModelPill } from './model-pill'
import type { ChatBarState } from './types'

const getMoaModels = vi.fn()

vi.mock('@/hermes', () => ({
  getMoaModels: () => getMoaModels()
}))

const MANAGED = 'custom:apex-nodes.com'

// modelMenuContent must be set (any node) to take the DropdownMenu-backed
// render path — the computed `title` tooltip (what this file asserts on) only
// applies there; the content itself is irrelevant since the menu stays closed.
const model: ChatBarState['model'] = {
  model: '',
  provider: '',
  canSwitch: true,
  modelMenuContent: <div>dummy menu</div>
}

beforeEach(() => {
  $currentModel.set('')
  $currentProvider.set('')
  getMoaModels.mockResolvedValue(null)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderPill() {
  const queryClient = new QueryClient()

  return render(
    <QueryClientProvider client={queryClient}>
      <ModelPill disabled={false} model={model} />
    </QueryClientProvider>
  )
}

describe('ModelPill', () => {
  it('shows the plain model name + title for a single active model', async () => {
    $currentModel.set('glm-5.2')
    $currentProvider.set(MANAGED)

    renderPill()

    expect(await screen.findByText(/GLM 5.2/)).toBeTruthy()
    expect(screen.getByRole('button').getAttribute('title')).toMatch(new RegExp(MANAGED))
  })

  it('shows "N models selected" — never provider/model ids — for a composed selection', async () => {
    $currentModel.set('__auto__')
    $currentProvider.set('moa')
    getMoaModels.mockResolvedValue({
      presets: {
        __auto__: {
          reference_models: [{ provider: MANAGED, model: 'glm-5.2' }],
          aggregator: { provider: MANAGED, model: 'qwen3.7-max' }
        }
      }
    })

    renderPill()

    expect(await screen.findByText(/2 models selected/i)).toBeTruthy()
    const button = screen.getByRole('button')
    expect(button.getAttribute('title')).toMatch(/2 models selected/i)
    expect(button.textContent).not.toMatch(/__auto__|\bmoa\b/i)
    expect(button.getAttribute('title')).not.toMatch(/__auto__|\bmoa\b/i)
  })

  // The pill is `max-w-40` around a `truncate` label, so only the short form
  // fits. It used to share Settings › Model's long sentence (which continues
  // "· they answer together, each billed to your ledger …"), which clipped
  // mid-word on a real install. The label AND the title (also the aria-label)
  // must stay short.
  it('keeps the composed label short enough not to truncate in the pill', async () => {
    $currentModel.set('__auto__')
    $currentProvider.set('moa')
    getMoaModels.mockResolvedValue({
      presets: {
        __auto__: {
          reference_models: [{ provider: MANAGED, model: 'glm-5.2' }],
          aggregator: { provider: MANAGED, model: 'qwen3.7-max' }
        }
      }
    })

    renderPill()

    const label = await screen.findByText(/2 models selected/i)
    expect(label.textContent).toBe('2 models selected')

    const button = screen.getByRole('button')
    expect(button.getAttribute('title')).toBe('2 models selected')
    // The billing explanation belongs to the roomy Settings › Model callout.
    expect(button.textContent).not.toMatch(/answer together|ledger|actual usage/i)
    expect(button.getAttribute('title')).not.toMatch(/answer together|ledger|actual usage/i)
  })
})
