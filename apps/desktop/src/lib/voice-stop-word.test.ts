import { describe, expect, it } from 'vitest'

import { interceptsTypedVoiceStop, isVoiceStopCommand } from './voice-stop-word'

describe('isVoiceStopCommand', () => {
  it.each([
    'OK，你关闭吧。', 'Ok你关闭吧', '好的，APEX，结束通话。', 'APEX结束通话',
    '请关闭语音', '关闭语音吧！', '停止聆听。', '暂停语音', '停止语音', '结束语音',
    '结束对话', '挂断通话', '别听了', '再见！', '拜拜', '停止', '暂停', '取消',
    'OK，你關閉吧。', '請關閉語音', '結束通話！', '停止聆聽', '再見', '暫停語音'
  ])('recognizes a complete Chinese voice-end utterance: %s', phrase => {
    expect(isVoiceStopCommand(phrase)).toBe(true)
    expect(interceptsTypedVoiceStop(true, phrase)).toBe(true)
    expect(interceptsTypedVoiceStop(false, phrase)).toBe(false)
    expect(interceptsTypedVoiceStop(true, phrase, 1)).toBe(false)
  })

  it.each([
    '关闭浏览器', '请关闭数据库', '停止下载', '暂停这个任务', '取消订单',
    '你关闭吧台的灯', '结束通话后帮我查热榜', '怎么关闭语音', '别停止语音',
    '不要结束通话', '他说再见是什么意思', '请關閉瀏覽器', '停止這個容器',
    '好的，APEX，查询抖音热榜', 'APEX', '好', '嗯'
  ])('preserves substantive Chinese tasks and bare addresses: %s', phrase => {
    expect(isVoiceStopCommand(phrase)).toBe(false)
    expect(interceptsTypedVoiceStop(true, phrase)).toBe(false)
  })
  it('matches bare stop commands', () => {
    for (const phrase of ['stop', 'Stop', 'STOP', 'stop.', 'stop!', ' stop ', 'stop…']) {
      expect(isVoiceStopCommand(phrase)).toBe(true)
    }
  })

  it('matches multi-word stop phrases', () => {
    for (const phrase of [
      'stop listening',
      'stop it',
      'please stop',
      'stop please',
      "that's all",
      'that is all',
      'never mind',
      'nevermind',
      'end conversation',
      'end the conversation',
      'goodbye',
      'bye',
      'cancel'
    ]) {
      expect(isVoiceStopCommand(phrase)).toBe(true)
    }
  })

  it('matches stop commands addressed to Hermes', () => {
    for (const phrase of ['hermes stop', 'hey hermes stop', 'hey hermes, stop', 'ok stop', 'okay stop']) {
      expect(isVoiceStopCommand(phrase)).toBe(true)
    }
  })

  it('does NOT match substantive requests that merely contain "stop"', () => {
    for (const phrase of [
      'stop the docker container',
      'how do I stop a running process',
      'can you stop the deployment',
      'stop the music and play something else',
      "don't stop now",
      'the bus stop is closed'
    ]) {
      expect(isVoiceStopCommand(phrase)).toBe(false)
    }
  })

  it('does not match bare address words or empty input', () => {
    for (const phrase of ['', '  ', 'hermes', 'hey hermes', 'ok', 'okay', 'hey']) {
      expect(isVoiceStopCommand(phrase)).toBe(false)
    }
  })

  it('does not match unrelated short utterances', () => {
    for (const phrase of ['hello', 'yes', 'what time is it', 'thanks']) {
      expect(isVoiceStopCommand(phrase)).toBe(false)
    }
  })
})

describe('interceptsTypedVoiceStop', () => {
  it('intercepts a typed bare stop command while the conversation is active', () => {
    for (const text of ['stop', 'Stop.', 'never mind', 'hey hermes, stop']) {
      expect(interceptsTypedVoiceStop(true, text)).toBe(true)
    }
  })

  it('never intercepts when the voice conversation is inactive', () => {
    for (const text of ['stop', 'never mind', 'goodbye']) {
      expect(interceptsTypedVoiceStop(false, text)).toBe(false)
    }
  })

  it('passes through substantive messages during a conversation', () => {
    for (const text of ['stop the docker container', 'how do I stop a process', 'hello']) {
      expect(interceptsTypedVoiceStop(true, text)).toBe(false)
    }
  })

  it('passes through when attachments ride along (real payload)', () => {
    expect(interceptsTypedVoiceStop(true, 'stop', 1)).toBe(false)
  })
})
