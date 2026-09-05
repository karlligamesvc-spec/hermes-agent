import type { ReactNode } from 'react'

export function RunFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-(--ui-text-tertiary)">{label}</dt>
      <dd className="mt-1 truncate text-sm font-medium">{value}</dd>
    </div>
  )
}

export function RunSection({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="mt-8">
      <h2 className="border-b border-(--ui-stroke-tertiary) pb-2 text-sm font-semibold">{title}</h2>
      <div>{children}</div>
    </section>
  )
}
