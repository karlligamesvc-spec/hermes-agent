import type { FC } from 'react'
import { Fragment, useMemo } from 'react'

import { DirectiveContent } from '@/components/assistant-ui/directive-text'
import { referenceRe } from '@/components/assistant-ui/reference-kinds'
import { ExternalLink } from '@/lib/external-link'
import { cn } from '@/lib/utils'
import { useSingleThreadMode } from '@/store/single-thread'

// User messages should render the bare-minimum of markdown: backtick `code`
// spans and ``` fenced blocks. We deliberately don't pull in the full
// assistant Markdown pipeline (Streamdown + KaTeX + syntax highlighter)
// because user input rarely contains structured docs and the heavy pipeline
// adds a lot of runtime cost per bubble.
//
// Directive chips (`@file:`, `@image:`, ...) still resolve via DirectiveContent
// inside the plain-text segments.

interface FenceSegment {
  kind: 'fence'
  code: string
  lang: string | null
}

interface InlineSegment {
  kind: 'inline'
  text: string
}

interface InlineCodeSegment {
  kind: 'inline-code'
  code: string
}

interface InlineTextSegment {
  kind: 'inline-text'
  text: string
}

type TopSegment = FenceSegment | InlineSegment
type InlineNode = InlineCodeSegment | InlineTextSegment

const FENCE_RE = /```([^\n`]*)\n([\s\S]*?)```/g

// Greedy backtick run length so ``code with `backticks` inside`` works.
const INLINE_CODE_RE = /(`+)([^`\n][\s\S]*?)\1/g

// A directive's value is BACKTICK-QUOTED whenever it needs to be (`@url:`
// always, and any path with a space), so the inline-code scanner would claim
// those backticks first and split one reference into a bare `@url:` plus a code
// span — the composer's chip, flattened on send. Directives win: this is syntax
// the composer wrote, not something the user typed as code.

/** Inline-code matches that don't overlap a directive, so a quoted directive
 *  value reaches DirectiveContent whole. */
function inlineCodeOutsideDirectives(text: string): RegExpMatchArray[] {
  const directives = Array.from(text.matchAll(referenceRe())).map(match => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length
  }))

  return Array.from(text.matchAll(INLINE_CODE_RE)).filter(match => {
    const start = match.index ?? 0
    const end = start + match[0].length

    return !directives.some(directive => start < directive.end && end > directive.start)
  })
}

// hc-1101: a web address you typed. Stops at whitespace, quotes, brackets and
// CJK punctuation; trailing sentence punctuation stays prose (LINK_TAIL_RE).
const LINK_RE = /https?:\/\/[^\s<>"'`，。！？、；：（）「」『』【】《》]+/g
const LINK_TAIL_RE = /[.,;:!?)\]}]+$/

export type LinkPiece = { kind: 'link'; url: string } | { kind: 'text'; text: string }

/**
 * A plain-text run split into prose and the web addresses in it, for single-thread
 * mode's clickable links. A reference the composer wrote (`@url:`…) stays one
 * piece of prose, so it still chips.
 */
export function splitLinks(text: string): LinkPiece[] {
  const references = Array.from(text.matchAll(referenceRe())).map(match => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length
  }))

  const pieces: LinkPiece[] = []
  let cursor = 0

  for (const match of text.matchAll(LINK_RE)) {
    const start = match.index ?? 0
    const url = match[0].replace(LINK_TAIL_RE, '')
    const end = start + url.length

    if (references.some(reference => start < reference.end && end > reference.start)) {
      continue
    }

    if (start > cursor) {
      pieces.push({ kind: 'text', text: text.slice(cursor, start) })
    }

    pieces.push({ kind: 'link', url })
    cursor = end
  }

  if (cursor < text.length) {
    pieces.push({ kind: 'text', text: text.slice(cursor) })
  }

  return pieces
}

const LinkedText: FC<{ text: string }> = ({ text }) => {
  const pieces = useMemo(() => splitLinks(text), [text])

  return pieces.map((piece, index) =>
    piece.kind === 'link' ? (
      <ExternalLink data-slot="aui_user-link" href={piece.url} key={`link-${index}`}>
        {piece.url}
      </ExternalLink>
    ) : (
      <DirectiveContent key={`text-${index}`} text={piece.text} />
    )
  )
}

function splitFences(text: string): TopSegment[] {
  const segments: TopSegment[] = []
  let cursor = 0

  for (const match of text.matchAll(FENCE_RE)) {
    const start = match.index ?? 0

    if (start > cursor) {
      segments.push({ kind: 'inline', text: text.slice(cursor, start) })
    }

    segments.push({
      kind: 'fence',
      lang: (match[1] || '').trim() || null,
      code: match[2] ?? ''
    })
    cursor = start + match[0].length
  }

  if (cursor < text.length) {
    segments.push({ kind: 'inline', text: text.slice(cursor) })
  }

  return segments
}

function splitInlineCode(text: string): InlineNode[] {
  const nodes: InlineNode[] = []
  let cursor = 0

  for (const match of inlineCodeOutsideDirectives(text)) {
    const start = match.index ?? 0

    if (start > cursor) {
      nodes.push({ kind: 'inline-text', text: text.slice(cursor, start) })
    }

    nodes.push({ kind: 'inline-code', code: match[2] })
    cursor = start + match[0].length
  }

  if (cursor < text.length) {
    nodes.push({ kind: 'inline-text', text: text.slice(cursor) })
  }

  return nodes
}

interface UserMessageTextProps {
  text: string
  className?: string
}

export const UserMessageText: FC<UserMessageTextProps> = ({ className, text }) => {
  const top = useMemo(() => splitFences(text), [text])

  return (
    <span className={cn('block', className)} data-slot="aui_user-message-text">
      {top.map((segment, segmentIndex) => {
        if (segment.kind === 'fence') {
          return (
            <pre
              className="my-1.5 max-w-full overflow-x-auto rounded-md border border-(--ui-stroke-tertiary) bg-[color-mix(in_srgb,currentColor_5%,transparent)] px-2.5 py-2 font-mono text-[0.86em] leading-snug"
              data-slot="aui_user-fence"
              key={`fence-${segmentIndex}`}
            >
              <code className="block whitespace-pre">{segment.code}</code>
            </pre>
          )
        }

        return (
          <Fragment key={`inline-${segmentIndex}`}>
            <InlineSegmentView text={segment.text} />
          </Fragment>
        )
      })}
    </span>
  )
}

const InlineSegmentView: FC<{ text: string }> = ({ text }) => {
  const nodes = useMemo(() => splitInlineCode(text), [text])
  // hc-1101: single-thread mode's bubble is plain words (no click-to-edit), so its links can open.
  const linked = useSingleThreadMode()

  return (
    // styles.css bidi hook (#44150); whitespace-pre-line makes each line its own
    // UAX#9 paragraph so it resolves direction independently.
    <span className="wrap-anywhere block whitespace-pre-line" data-slot="aui_user-inline-text">
      {nodes.map((node, nodeIndex) =>
        node.kind === 'inline-code' ? (
          <code
            className="mx-px rounded bg-[color-mix(in_srgb,currentColor_8%,transparent)] px-1 py-px font-mono text-[0.92em]"
            data-slot="aui_user-inline-code"
            key={`code-${nodeIndex}`}
          >
            {node.code}
          </code>
        ) : (
          // Pass plain-text bits through DirectiveContent so @file:/@url: chips
          // still render. DirectiveContent already preserves whitespace.
          <Fragment key={`text-${nodeIndex}`}>
            {linked ? <LinkedText text={node.text} /> : <DirectiveContent text={node.text} />}
          </Fragment>
        )
      )}
    </span>
  )
}
