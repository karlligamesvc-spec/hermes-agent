export interface VideoFrameEvidence {
  seconds: number
  dataUrl: string
}

export function captureVideoFrame(player: HTMLVideoElement): VideoFrameEvidence {
  if (player.seeking || player.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      !Number.isFinite(player.currentTime) || player.currentTime < 0 ||
      !player.videoWidth || !player.videoHeight) {
    throw new Error('frame_not_decoded')
  }

  const canvas = document.createElement('canvas')
  const scale = Math.min(1, 640 / player.videoWidth, 360 / player.videoHeight)
  canvas.width = Math.max(1, Math.round(player.videoWidth * scale))
  canvas.height = Math.max(1, Math.round(player.videoHeight * scale))
  const context = canvas.getContext('2d')

  if (!context) {throw new Error('frame_context_unavailable')}

  context.drawImage(player, 0, 0, canvas.width, canvas.height)
  const dataUrl = canvas.toDataURL('image/jpeg', 0.78)

  if (!dataUrl.startsWith('data:image/jpeg;base64,')) {throw new Error('frame_encoding_unavailable')}

  return { seconds: player.currentTime, dataUrl }
}

function waitForVideoEvent(video: HTMLVideoElement, eventName: 'loadedmetadata' | 'seeked', start?: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(new Error('video_timeout')), 8000)
    const onSuccess = () => finish()
    const onError = () => finish(new Error('video_unavailable'))

    function finish(error?: Error) {
      window.clearTimeout(timeout)
      video.removeEventListener(eventName, onSuccess)
      video.removeEventListener('error', onError)
      if (error) {reject(error)} else {resolve()}
    }

    video.addEventListener(eventName, onSuccess, { once: true })
    video.addEventListener('error', onError, { once: true })

    try {start?.()} catch (error) {finish(error instanceof Error ? error : new Error('video_unavailable'))}
  })
}

/** Samples only decoded frames from the user's manually paired local video. */
export async function sampleVideoFrames(videoUrl: string, seconds: readonly number[]): Promise<VideoFrameEvidence[]> {
  const video = document.createElement('video')
  video.preload = 'auto'
  video.muted = true

  try {
    const metadata = waitForVideoEvent(video, 'loadedmetadata', () => {video.src = videoUrl})
    await metadata

    if (!Number.isFinite(video.duration) || video.duration <= 0) {return []}

    const frames: VideoFrameEvidence[] = []

    for (const second of seconds.slice(0, 3)) {
      if (!Number.isFinite(second) || second < 0 || second >= video.duration) {continue}

      try {
        await waitForVideoEvent(video, 'seeked', () => {video.currentTime = second})
        frames.push(captureVideoFrame(video))
      } catch {
        // A failed seek is not visual evidence; another timestamp may still decode.
      }
    }

    return frames
  } catch {return []}
  finally {
    video.removeAttribute('src')
    try {video.load()} catch { /* Cleanup still releases the temporary source in test DOMs. */ }
  }
}
