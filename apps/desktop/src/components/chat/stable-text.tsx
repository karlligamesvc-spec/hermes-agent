import { cn } from '@/lib/utils'

interface StableTextProps {
  children: string
  className?: string
}

// Full-width (CJK) characters are two cells wide, so a localized unit such as
// 「秒」 holds as steady as the digits beside it instead of spilling over them.
const WIDE_CHAR_RE = /[⺀-鿿가-힯豈-﫿＀-｠￠-￦]/

/**
 * Renders text as a row of fixed-width cells so individual characters can't
 * shift the layout as they change (e.g. digits in a ticking timer).
 * Works with any proportional font — no need for font-mono.
 */
export function StableText({ children, className }: StableTextProps) {
  return (
    <span className={cn('inline-flex', className)}>
      {children.split('').map((char, i) => (
        <span className={cn('inline-block text-center', WIDE_CHAR_RE.test(char) ? 'w-[2ch]' : 'w-[1ch]')} key={i}>
          {char}
        </span>
      ))}
    </span>
  )
}
