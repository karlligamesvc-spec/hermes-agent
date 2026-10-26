import { Codicon } from '@/components/ui/codicon'
import { cn } from '@/lib/utils'

/**
 * The 「登录已失效」 card: a warning disc, the title, and what a click does.
 * AccountPanel shows it in place of the account row when the relay key is dead
 * (hc-519); CloudLoginNotice shows it above a working row when only the login
 * JWT is (hc-1073), with `cloudLogin` marking that use.
 */
export function SessionExpiredCard({
  action,
  cloudLogin = false,
  onClick,
  title
}: {
  action: string
  cloudLogin?: boolean
  onClick: () => void
  title: string
}) {
  return (
    <button
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition-colors',
        'hover:bg-(--ui-control-hover-background)'
      )}
      data-apex-cloud-login={cloudLogin ? '' : undefined}
      onClick={onClick}
      type="button"
    >
      <span
        aria-hidden
        className="grid size-7 shrink-0 place-items-center rounded-full text-white"
        style={{ backgroundColor: 'var(--theme-danger, #d9534f)' }}
      >
        <Codicon name="warning" size="0.875rem" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-[0.8125rem] font-medium text-foreground">{title}</span>
        <span className="truncate text-[0.6875rem] text-(--ui-text-tertiary)">{action}</span>
      </span>
    </button>
  )
}
