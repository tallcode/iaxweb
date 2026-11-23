const SPECTRUM_BARS = 28

export class SpectrumMeter {
  private analyser: AnalyserNode | null = null
  private readonly bars: HTMLSpanElement[] = []
  private frame = 0
  private freqData: Uint8Array<ArrayBuffer> | null = null
  private readonly levelFill: HTMLElement | null
  private readonly levelPeak: HTMLElement | null
  private peak = 0
  private readonly spectrum: HTMLElement
  private timeData: Uint8Array<ArrayBuffer> | null = null

  constructor(rootElement: HTMLElement) {
    const spectrum = rootElement.querySelector<HTMLElement>('.spectrum')
    if (!spectrum)
      throw new Error('Spectrum meter requires a .spectrum element')
    this.spectrum = spectrum
    this.levelFill = rootElement.querySelector('.level-fill')
    this.levelPeak = rootElement.querySelector('.level-peak')
    this.render = this.render.bind(this)
    this.reset()
  }

  attach(analyser: AnalyserNode): void {
    this.ensureBars()
    this.analyser = analyser
    this.timeData = new Uint8Array(analyser.fftSize)
    this.freqData = new Uint8Array(analyser.frequencyBinCount)
    if (!this.frame)
      this.frame = requestAnimationFrame(this.render)
  }

  detach(): void {
    if (this.frame) {
      cancelAnimationFrame(this.frame)
      this.frame = 0
    }
    this.analyser = null
    this.peak = 0
    this.reset()
  }

  private ensureBars(): void {
    if (this.bars.length > 0)
      return
    for (let index = 0; index < SPECTRUM_BARS; index++) {
      const bar = document.createElement('span')
      bar.className = 'bar'
      this.spectrum.append(bar)
      this.bars.push(bar)
    }
  }

  private reset(): void {
    for (const bar of this.bars)
      bar.style.transform = 'scaleY(0.02)'
    if (this.levelFill)
      this.levelFill.style.transform = 'scaleX(0)'
    if (this.levelPeak)
      this.levelPeak.style.left = '0%'
  }

  private render(): void {
    const analyser = this.analyser
    const timeData = this.timeData
    const freqData = this.freqData
    if (!analyser || !timeData || !freqData)
      return
    this.frame = requestAnimationFrame(this.render)

    if (this.levelFill && this.levelPeak) {
      analyser.getByteTimeDomainData(timeData)
      const sumSquares = timeData.reduce((sum, value) => {
        const sample = (value - 128) / 128
        return sum + sample * sample
      }, 0)
      const rms = Math.sqrt(sumSquares / timeData.length)
      const dbfs = rms > 0 ? 20 * Math.log10(rms) : Number.NEGATIVE_INFINITY
      const level = Number.isFinite(dbfs) ? Math.max(0, Math.min(1, (dbfs + 60) / 60)) : 0
      this.levelFill.style.transform = `scaleX(${level})`
      this.peak = Math.max(level, this.peak - 0.01)
      this.levelPeak.style.left = `${this.peak * 100}%`
    }

    analyser.getByteFrequencyData(freqData)
    const usableBins = Math.floor(freqData.length * 0.85)
    this.bars.forEach((bar, index) => {
      const start = Math.floor((index / this.bars.length) * usableBins)
      const end = Math.max(start + 1, Math.floor(((index + 1) / this.bars.length) * usableBins))
      let sum = 0
      for (let bin = start; bin < end; bin++)
        sum += freqData[bin] ?? 0
      bar.style.transform = `scaleY(${Math.max(0.02, sum / (end - start) / 255)})`
    })
  }
}
