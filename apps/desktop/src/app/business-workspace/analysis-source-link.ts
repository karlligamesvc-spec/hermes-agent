export interface AnalysisSourceLink {
  url: string | null
  isFeishu: boolean
  error: 'invalid_source_link' | 'multiple_source_links' | null
}

function trimSharedLink(value: string, quoted: boolean): string {
  let candidate = value

  if (quoted) {candidate = candidate.replace(/'[.,!?;:]*$/, '')}

  for (;;) {
    const last = candidate.at(-1) ?? ''
    const opening = { ')': '(', ']': '[', '}': '{' }[last]
    const unbalanced = opening && candidate.split(last).length > candidate.split(opening).length
    // Query/fragment punctuation can be part of the address, including nested URLs.
    const punctuation = !/[?#]/.test(candidate) && /[.,!?;:]/.test(last)

    if (!unbalanced && !punctuation) {return candidate}

    candidate = candidate.slice(0, -1)
  }
}

export function parseAnalysisSourceLink(input: string): AnalysisSourceLink {
  const text = input.trim()
  const invalid: AnalysisSourceLink = { url: null, isFeishu: false, error: 'invalid_source_link' }

  if (!text) {return { url: null, isFeishu: false, error: null }}

  // A bare URL keeps its punctuation: trimming it could change a path or query.
  const joinedLinks = /[,;，。；][a-z][a-z\d+.-]*:\/\//i.test(text.split(/[?#]/)[0])
  const bare = /^[a-z][a-z\d+.-]*:\/\/\S+$/i.test(text) && !joinedLinks

  const candidates = bare ? [text] : Array.from(text.matchAll(/[a-z][a-z\d+.-]*:\/\/[^\s<>"`“”‘’「」『』?#，。！？；：、]*(?:[?#][^\s<>"`“”‘’「」『』]+)?/gi), match => {
    const value = match[0]
    const path = value.split(/[?#]/)[0]
    const parts = path.split(/[,;](?=[a-z][a-z\d+.-]*:\/\/)/i)

    parts[parts.length - 1] += value.slice(path.length)

    return parts.map((part, index) => trimSharedLink(part, index === 0 && text[match.index - 1] === "'"))
  }).flat()

  if (!candidates.length) {return invalid}

  const urls = new Map<string, URL>()

  for (const candidate of candidates) {
    try {
      const url = new URL(candidate)
      const authority = candidate.split('://')[1]?.split(/[/?#\\]/)[0]

      if (url.protocol !== 'https:' || !authority || authority.includes('@') || url.username || url.password) {return invalid}

      urls.set(url.href, url)
    } catch {return invalid}
  }

  if (urls.size !== 1) {return { url: null, isFeishu: false, error: 'multiple_source_links' }}

  const url = urls.values().next().value!
  const isFeishu = ['feishu.cn', 'larksuite.com'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))

  return { url: url.href, isFeishu, error: null }
}
