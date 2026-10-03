import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type RenderOptions, render as testingRender } from '@testing-library/react'
import type { ReactNode } from 'react'

/** Match the app's query context, with a fresh cache for each isolated workspace test. */
export function render(ui: ReactNode, options?: RenderOptions) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return testingRender(ui, {
    ...options,
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  })
}
