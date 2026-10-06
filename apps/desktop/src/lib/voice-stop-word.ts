// Spoken stop-word detection for the voice conversation loop.
//
// When someone is in a hands-free "Hey Hermes" voice chat, the natural way to
// end it is to SAY "stop" — not reach for the mouse. Without this, a spoken
// "stop" is just transcribed and sent to the agent as a normal turn, so the
// conversation never ends (the reported bug). This matcher recognises a short
// utterance whose entire content is a stop command and ends the conversation
// instead of submitting it.
//
// Deliberately conservative: it only fires when the WHOLE utterance is a stop
// phrase (optionally addressed to Hermes), so a real turn that merely contains
// the word "stop" — e.g. "stop the docker container" or "how do I stop a
// running process" — is never swallowed.

// Canonical stop commands. Kept short and unambiguous; each must be the entire
// spoken utterance to match.
const STOP_PHRASES: readonly string[] = [
  'stop',
  'stop listening',
  'stop it',
  'stop please',
  'please stop',
  'stop stop',
  'that is all',
  "that's all",
  'never mind',
  'nevermind',
  'end conversation',
  'end the conversation',
  'goodbye',
  'good bye',
  'bye',
  'cancel',
  '停止',
  '暂停',
  '取消',
  '再见',
  '拜拜',
  '关闭吧',
  '你关闭吧',
  '关闭语音',
  '关闭语音吧',
  '停止语音',
  '暂停语音',
  '结束语音',
  '结束通话',
  '挂断通话',
  '结束对话',
  '停止聆听',
  '别听了',
  '關閉吧',
  '你關閉吧',
  '關閉語音',
  '關閉語音吧',
  '停止語音',
  '暫停語音',
  '結束語音',
  '結束通話',
  '掛斷通話',
  '結束對話',
  '停止聆聽',
  '別聽了',
  '暫停',
  '再見'
]

// Optional address prefixes so "hermes stop" / "ok stop" / "hey hermes, stop"
// still count. Stripped before matching the core phrase.
const ADDRESS_PREFIXES: readonly string[] = ['hey hermes', 'hey apex', 'hermes', 'apex', 'okay', 'ok', 'hey', '好的', '好', '嗯', '请', '請']

// Normalise: lowercase, strip surrounding punctuation/whitespace, collapse
// internal runs of spaces. Trailing punctuation (".", "!", "…") is common in
// STT output and must not defeat the match.
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?;:…，。！？；：、．]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function stripAddress(text: string): string {
  let remaining = text

  while (remaining) {
    const prefix = ADDRESS_PREFIXES.find(address => remaining.startsWith(address) &&
      (remaining[address.length] === ' ' || /[\u3400-\u9fff]/u.test(remaining[address.length] ?? '')))

    if (!prefix) {break}
    remaining = remaining.slice(prefix.length).trim()
  }

  return remaining
}

/**
 * True when the entire spoken utterance is a stop command (optionally addressed
 * to Hermes). Returns false for anything that merely contains "stop" as part of
 * a longer, substantive request.
 */
export function isVoiceStopCommand(transcript: string): boolean {
  if (!transcript) {
    return false
  }

  const normalized = normalize(transcript)

  if (!normalized) {
    return false
  }

  // Match with the address prefix stripped, and also as-is (so a bare "stop"
  // with no prefix still matches, and "please stop" — where "please" isn't a
  // prefix — matches directly).
  const candidates = new Set([normalized, stripAddress(normalized)])

  for (const candidate of candidates) {
    if (STOP_PHRASES.includes(candidate)) {
      return true
    }
  }

  return false
}

/**
 * Typed-stop interception decision for the composer: a bare stop command
 * typed while the voice conversation is live ends the conversation instead of
 * being sent as a turn. Attachments mean the message is a real payload —
 * never intercepted. Outside a voice conversation typed text always passes
 * through unchanged.
 */
export function interceptsTypedVoiceStop(conversationActive: boolean, text: string, attachmentCount = 0): boolean {
  return conversationActive && attachmentCount === 0 && isVoiceStopCommand(text)
}
