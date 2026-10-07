/** Local audio boundaries only; the primary assistant decides what the words mean. */
export class VoicePcmTurn {
  private preroll: Float32Array[] = []
  private prerollSamples = 0
  private loudSamples = 0
  private quietSamples = 0
  private turnSamples = 0
  private active = false

  constructor(
    private readonly sampleRate: number,
    private readonly handlers: { start: () => void; append: (samples: Float32Array) => void; commit: () => void }
  ) {}

  feed(samples: Float32Array): void {
    const loud = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / Math.max(1, samples.length)) >= 0.025

    if (!this.active) {
      this.preroll.push(samples.slice())
      this.prerollSamples += samples.length
      this.loudSamples = loud ? this.loudSamples + samples.length : 0

      while (this.prerollSamples > this.sampleRate * 0.5 && this.preroll.length > 1) {
        this.prerollSamples -= this.preroll.shift()!.length
      }

      if (this.loudSamples < this.sampleRate * 0.2) {return}
      this.active = true
      this.turnSamples = this.prerollSamples
      this.handlers.start()
      this.preroll.forEach(frame => this.handlers.append(frame))
      this.preroll = []
      this.prerollSamples = 0
    } else {
      this.handlers.append(samples)
      this.turnSamples += samples.length
    }

    this.quietSamples = loud ? 0 : this.quietSamples + samples.length

    if (this.quietSamples >= this.sampleRate * 1.5 || this.turnSamples >= this.sampleRate * 45) {
      this.finish()
    }
  }

  finish(): void {
    const committed = this.active
    this.active = false
    this.preroll = []
    this.prerollSamples = this.loudSamples = this.quietSamples = this.turnSamples = 0
    if (committed) {this.handlers.commit()}
  }

  reset(): void {
    this.active = false
    this.preroll = []
    this.prerollSamples = this.loudSamples = this.quietSamples = this.turnSamples = 0
  }
}
