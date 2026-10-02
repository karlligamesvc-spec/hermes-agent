import { afterEach, describe, expect, it, vi } from 'vitest'

import { captureVideoFrame, sampleVideoFrames } from './video-frame-evidence'

afterEach(() => vi.restoreAllMocks())

describe('video frame evidence', () => {
  it('samples only decoded times within the manually paired local video', async () => {
    const video = document.createElement('video')
    const createElement = document.createElement.bind(document)
    let readyState: number = HTMLMediaElement.HAVE_NOTHING
    let currentTime = 0
    const drawImage = vi.fn()

    Object.defineProperties(video, {
      src: { configurable: true, set: () => {queueMicrotask(() => {readyState = HTMLMediaElement.HAVE_METADATA; video.dispatchEvent(new Event('loadedmetadata'))})} },
      duration: { configurable: true, value: 10 },
      currentTime: { configurable: true, get: () => currentTime, set: (value: number) => {
        currentTime = value
        queueMicrotask(() => {readyState = HTMLMediaElement.HAVE_CURRENT_DATA; video.dispatchEvent(new Event('seeked'))})
      } },
      readyState: { configurable: true, get: () => readyState },
      videoWidth: { configurable: true, value: 1920 },
      videoHeight: { configurable: true, value: 1080 }
    })
    vi.spyOn(video, 'load').mockImplementation(() => undefined)
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: ElementCreationOptions) =>
      tagName === 'video' ? video : createElement(tagName, options)) as Document['createElement'])
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,ZmFrZQ==')

    const frames = await sampleVideoFrames('blob:paired-video', [2.5, 15, 7.5])

    expect(frames).toEqual([
      { seconds: 2.5, dataUrl: 'data:image/jpeg;base64,ZmFrZQ==' },
      { seconds: 7.5, dataUrl: 'data:image/jpeg;base64,ZmFrZQ==' }
    ])
    expect(drawImage).toHaveBeenCalledTimes(2)
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 640, 360)
    expect(video.hasAttribute('src')).toBe(false)
  })

  it.each([
    { readyState: HTMLMediaElement.HAVE_METADATA, seeking: false },
    { readyState: HTMLMediaElement.HAVE_CURRENT_DATA, seeking: true }
  ])('refuses an unsettled frame ($readyState, seeking=$seeking)', ({ readyState, seeking }) => {
    const video = document.createElement('video')
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,ZmFrZQ==')
    Object.defineProperties(video, {
      readyState: { configurable: true, value: readyState },
      seeking: { configurable: true, value: seeking },
      videoWidth: { configurable: true, value: 1920 },
      videoHeight: { configurable: true, value: 1080 }
    })

    expect(() => captureVideoFrame(video)).toThrow('frame_not_decoded')
    expect(getContext).not.toHaveBeenCalled()
  })
})
