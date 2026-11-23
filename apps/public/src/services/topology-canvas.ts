import type { TopologyEdge } from './topology-graph'
import type { NodeMotionState } from './topology-simulation'

type Point = Pick<NodeMotionState, 'x' | 'y'>

export class TopologyCanvas {
  private readonly context: CanvasRenderingContext2D

  constructor(private readonly canvas: HTMLCanvasElement, private readonly reduceMotion: boolean) {
    const context = canvas.getContext('2d')
    if (!context)
      throw new Error('Canvas 2D context is unavailable')
    this.context = context
  }

  clear(): void {
    this.canvas.width = 0
    this.canvas.height = 0
  }

  draw(width: number, height: number, edges: readonly TopologyEdge[], positions: ReadonlyMap<string, Point>, timestamp: number): void {
    const pixelRatio = devicePixelRatio || 1
    if (this.canvas.width !== Math.round(width * pixelRatio) || this.canvas.height !== Math.round(height * pixelRatio)) {
      this.canvas.width = Math.round(width * pixelRatio)
      this.canvas.height = Math.round(height * pixelRatio)
    }
    this.context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
    this.context.clearRect(0, 0, width, height)

    for (const [edgeIndex, edge] of edges.entries()) {
      const source = positions.get(edge.source)
      const target = positions.get(edge.target)
      if (!source || !target)
        continue
      this.context.save()
      this.context.setLineDash(edge.connected ? [] : [7, 7])
      this.context.lineWidth = edge.connected ? 1.7 : 1.2
      this.context.strokeStyle = edge.connected ? 'rgb(82 201 195 / 60%)' : 'rgb(70 84 101 / 75%)'
      if (edge.connected) {
        this.context.shadowBlur = 3
        this.context.shadowColor = 'rgb(82 201 195 / 25%)'
      }
      this.context.beginPath()
      this.context.moveTo(source.x, source.y)
      this.context.lineTo(target.x, target.y)
      this.context.stroke()
      this.context.restore()

      if (edge.connected && !this.reduceMotion)
        this.drawFlowParticles(source, target, timestamp, edgeIndex)
    }
    this.context.setLineDash([])
  }

  private drawFlowParticles(source: Point, target: Point, timestamp: number, edgeIndex: number): void {
    const dx = target.x - source.x
    const dy = target.y - source.y
    const distance = Math.max(1, Math.hypot(dx, dy))
    const unitX = dx / distance
    const unitY = dy / distance
    const travelMs = 2_500
    const gapMs = 850
    const cycleMs = (travelMs + gapMs) * 2
    const elapsed = (timestamp + edgeIndex * 617) % cycleMs

    if (elapsed < travelMs) {
      this.drawDirectionalPulse(source, target, unitX, unitY, elapsed / travelMs, 1)
      return
    }

    const returnStart = travelMs + gapMs
    if (elapsed >= returnStart && elapsed < returnStart + travelMs) {
      const progress = 1 - (elapsed - returnStart) / travelMs
      this.drawDirectionalPulse(source, target, unitX, unitY, progress, -1)
    }
  }

  private drawDirectionalPulse(
    source: Point,
    target: Point,
    unitX: number,
    unitY: number,
    progress: number,
    direction: number,
  ): void {
    const x = source.x + (target.x - source.x) * progress
    const y = source.y + (target.y - source.y) * progress
    const tailX = x - unitX * direction * 15
    const tailY = y - unitY * direction * 15

    this.context.save()
    const gradient = this.context.createLinearGradient(tailX, tailY, x, y)
    gradient.addColorStop(0, 'rgb(114 239 231 / 0)')
    gradient.addColorStop(1, '#d8fffc')
    this.context.strokeStyle = gradient
    this.context.lineWidth = 2.2
    this.context.lineCap = 'round'
    this.context.shadowBlur = 5
    this.context.shadowColor = '#72efe7'
    this.context.beginPath()
    this.context.moveTo(tailX, tailY)
    this.context.lineTo(x, y)
    this.context.stroke()

    this.context.fillStyle = '#e8fffd'
    this.context.beginPath()
    this.context.arc(x, y, 1.9, 0, Math.PI * 2)
    this.context.fill()
    this.context.restore()
  }
}
