import type { ReactNode } from 'react'

import { PlatformAvatar } from '@/app/messaging/platform-icon'
import { StatusDot, type StatusTone } from '@/components/status-dot'
import { useI18n } from '@/i18n'

// hc-555 显化 — a delegated / direct task rendered as an in-conversation card:
// task name + source-channel tag + target (cloud 分身 / 本机) + a live status dot
// and heartbeat. This is the desktop display piece (hc-548 桌面面); it is a pure
// presentational component so the delegated-task feed can render one wherever a
// task is dispatched, without this file knowing where the data comes from.

export type TaskCardStatus = 'running' | 'done' | 'failed' | 'queued'
export type TaskCardTarget = 'cloud' | 'local'

export interface DelegatedTaskCardProps {
  title: string
  status: TaskCardStatus
  target: TaskCardTarget
  /** Source channel that dispatched the task (feishu / weixin / qqbot / …). */
  sourceChannelId?: string
  sourceChannelName?: string
  /** Epoch ms of the last heartbeat; drives the "heartbeat N ago" line. */
  heartbeatAt?: number
  /** One-line status detail (next run, push target, /status hint). */
  detail?: ReactNode
  /** Injectable clock for deterministic tests. */
  now?: number
}

const STATUS_TONE: Record<TaskCardStatus, StatusTone> = {
  running: 'good',
  done: 'good',
  failed: 'bad',
  queued: 'muted'
}

// A "running" task whose heartbeat has gone quiet is shown as stale (warn) — a
// card that claims running with a cold heartbeat would otherwise read as falsely
// healthy. Mirrors the /tasks stuck-detection intent, at the heartbeat cadence.
const STALE_HEARTBEAT_MS = 90_000

export function DelegatedTaskCard({
  detail,
  heartbeatAt,
  now = Date.now(),
  sourceChannelId,
  sourceChannelName,
  status,
  target,
  title
}: DelegatedTaskCardProps) {
  const { t } = useI18n()
  const s = t.scenarios

  const hasHeartbeat = typeof heartbeatAt === 'number' && heartbeatAt > 0
  const secondsAgo = hasHeartbeat ? Math.max(0, Math.round((now - heartbeatAt) / 1000)) : null
  const stale = status === 'running' && hasHeartbeat && now - heartbeatAt > STALE_HEARTBEAT_MS
  const tone: StatusTone = stale ? 'warn' : STATUS_TONE[status]

  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) px-3 py-2.5">
      <div className="flex items-center gap-2 text-xs font-medium text-foreground">
        {sourceChannelId ? (
          <PlatformAvatar
            className="size-4"
            platformId={sourceChannelId}
            platformName={sourceChannelName ?? sourceChannelId}
          />
        ) : null}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span className="shrink-0 rounded-full border border-(--ui-stroke-tertiary) px-2 py-0.5 text-[0.6875rem] font-normal text-(--ui-text-tertiary)">
          {target === 'cloud' ? s.taskTargetCloud : s.taskTargetLocal}
        </span>
      </div>
      <div className="flex items-center gap-1.5 text-[0.6875rem] text-(--ui-text-tertiary)">
        <StatusDot tone={tone} />
        <span className="shrink-0">{s.taskStatus[status]}</span>
        {secondsAgo !== null ? <span className="shrink-0">· {s.heartbeatAgo(secondsAgo)}</span> : null}
        {detail ? <span className="min-w-0 truncate">· {detail}</span> : null}
      </div>
    </div>
  )
}
