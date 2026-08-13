import type { TopologyEdge } from './topology-graph'

interface NodeMotionState {
  vx: number
  vy: number
  x: number
  y: number
}

const LAYOUT_ITERATION_LIMIT = 480
const INITIAL_ANIMATION_MS = 2_000
const RELAYOUT_ANIMATION_MS = 1_000
const REQUIRED_STABLE_ITERATIONS = 36
const STABLE_SPEED_THRESHOLD = 0.03

export class TopologyLayout {
  private animationFrame = 0
  private readonly canvas: HTMLCanvasElement
  private readonly context: CanvasRenderingContext2D
  private readonly nodeElements: Map<string, HTMLElement>
  private edges: TopologyEdge[] = []
  private readonly motionStates = new Map<string, NodeMotionState>()
  private readonly reduceMotion: boolean
  private signature = ''
  private hasStartedLayout = false
  private readonly topology: HTMLElement

  constructor(
    topology: HTMLElement,
    canvas: HTMLCanvasElement,
    nodeElements: Map<string, HTMLElement>,
    reduceMotion: boolean,
  ) {
    this.topology = topology
    this.canvas = canvas
    const context = canvas.getContext('2d')
    if (!context)
      throw new Error('Canvas 2D context is unavailable')
    this.context = context
    this.nodeElements = nodeElements
    this.reduceMotion = reduceMotion
  }

  ensureNode(nodeId: string, index: number, total: number): void {
    if (!this.motionStates.has(nodeId))
      this.motionStates.set(nodeId, this.initialMotionState(index, total))
  }

  removeNode(nodeId: string): void {
    this.motionStates.delete(nodeId)
  }

  updateGraph(edges: TopologyEdge[], signature: string): void {
    this.edges = edges
    if (signature !== this.signature) {
      this.signature = signature
      this.startLayout()
      return
    }
    this.draw(performance.now())
    this.ensureFlowAnimation()
  }

  relayout(): void {
    this.startLayout()
  }

  private initialMotionState(index: number, total: number): NodeMotionState {
    const width = this.topology.clientWidth || 800
    const height = this.topology.clientHeight || 600
    const angle = total > 1 ? index / total * Math.PI * 2 : 0
    const radiusRatio = width < 680 ? 0.22 : 0.3
    const radius = Math.min(width, height) * radiusRatio
    return {
      vx: 0,
      vy: 0,
      x: width / 2 + Math.cos(angle) * radius,
      y: height / 2 + Math.sin(angle) * radius,
    }
  }

  private startLayout(): void {
    cancelAnimationFrame(this.animationFrame)
    this.animationFrame = 0
    const duration = this.hasStartedLayout ? RELAYOUT_ANIMATION_MS : INITIAL_ANIMATION_MS
    this.hasStartedLayout = true
    const initialStates = cloneMotionStates(this.motionStates)
    let stableIterations = 0

    // Solve the stable target up front, then animate toward that immutable
    // result. This keeps the original opening motion without coupling physics
    // progress to requestAnimationFrame or leaving a half-converged graph.
    for (let iteration = 0; iteration < LAYOUT_ITERATION_LIMIT && stableIterations < REQUIRED_STABLE_ITERATIONS; iteration++) {
      const maximumSpeed = this.simulate()
      stableIterations = maximumSpeed < STABLE_SPEED_THRESHOLD ? stableIterations + 1 : 0
    }
    const targetStates = cloneMotionStates(this.motionStates)
    copyMotionStates(this.motionStates, initialStates)

    const startedAt = performance.now()
    const animate = (timestamp: number): void => {
      const progress = Math.min(1, Math.max(0, (timestamp - startedAt) / duration))
      const eased = 1 - (1 - progress) ** 3
      for (const [nodeId, target] of targetStates) {
        const initial = initialStates.get(nodeId) ?? target
        const current = this.motionStates.get(nodeId)
        if (!current)
          continue
        current.x = lerp(initial.x, target.x, eased)
        current.y = lerp(initial.y, target.y, eased)
        current.vx = progress === 1 ? target.vx : 0
        current.vy = progress === 1 ? target.vy : 0
      }
      this.draw(timestamp)
      if (progress < 1) {
        this.animationFrame = requestAnimationFrame(animate)
        return
      }
      this.animationFrame = 0
      this.ensureFlowAnimation()
    }

    animate(startedAt)
  }

  private ensureFlowAnimation(): void {
    if (this.animationFrame || !this.shouldAnimateFlow())
      return

    const animate = (timestamp: number): void => {
      this.draw(timestamp)
      if (this.shouldAnimateFlow())
        this.animationFrame = requestAnimationFrame(animate)
      else
        this.animationFrame = 0
    }

    this.animationFrame = requestAnimationFrame(animate)
  }

  private shouldAnimateFlow(): boolean {
    return !this.reduceMotion && this.edges.some(edge => edge.connected)
  }

  private simulate(): number {
    const entries = [...this.motionStates.entries()]
    const width = this.topology.clientWidth
    const height = this.topology.clientHeight
    const isMobile = width < 680
    const repulsionStrength = isMobile ? 13_500 : 18_000
    const linkStrength = isMobile ? 0.0045 : 0.0028
    const centerStrength = isMobile ? 0.00105 : 0.0007
    const idealDistance = isMobile ? clamp(width * 0.3, 80, 120) : 265

    for (let left = 0; left < entries.length; left++) {
      for (let right = left + 1; right < entries.length; right++) {
        const firstEntry = entries[left]
        const secondEntry = entries[right]
        if (!firstEntry || !secondEntry)
          continue
        const first = firstEntry[1]
        const second = secondEntry[1]
        const dx = second.x - first.x || 0.1
        const dy = second.y - first.y || 0.1
        const distanceSquared = Math.max(400, dx * dx + dy * dy)
        const distance = Math.sqrt(distanceSquared)
        const force = repulsionStrength / distanceSquared
        const fx = dx / distance * force
        const fy = dy / distance * force
        first.vx -= fx
        first.vy -= fy
        second.vx += fx
        second.vy += fy

        const firstElement = this.nodeElements.get(firstEntry[0])
        const secondElement = this.nodeElements.get(secondEntry[0])
        const minimumX = ((firstElement?.offsetWidth || 0) + (secondElement?.offsetWidth || 0)) / 2 + 12
        const minimumY = ((firstElement?.offsetHeight || 0) + (secondElement?.offsetHeight || 0)) / 2 + 12
        const overlapX = minimumX - Math.abs(dx)
        const overlapY = minimumY - Math.abs(dy)
        if (overlapX > 0 && overlapY > 0) {
          if (overlapX < overlapY) {
            const direction = dx >= 0 ? 1 : -1
            const collisionForce = Math.min(2.5, overlapX * 0.04)
            first.vx -= direction * collisionForce
            second.vx += direction * collisionForce
          }
          else {
            const direction = dy >= 0 ? 1 : -1
            const collisionForce = Math.min(2.5, overlapY * 0.04)
            first.vy -= direction * collisionForce
            second.vy += direction * collisionForce
          }
        }
      }
    }

    for (const edge of this.edges) {
      const source = this.motionStates.get(edge.source)
      const target = this.motionStates.get(edge.target)
      if (!source || !target)
        continue
      const dx = target.x - source.x
      const dy = target.y - source.y
      const distance = Math.max(1, Math.hypot(dx, dy))
      const force = (distance - idealDistance) * linkStrength
      const fx = dx / distance * force
      const fy = dy / distance * force
      source.vx += fx
      source.vy += fy
      target.vx -= fx
      target.vy -= fy
    }

    let maximumSpeed = 0
    for (const [nodeId, position] of entries) {
      const element = this.nodeElements.get(nodeId)
      const edgePadding = isMobile ? 16 : 8
      const marginX = Math.min(width / 2, (element?.offsetWidth || 0) / 2 + edgePadding)
      const marginY = Math.min(height / 2, (element?.offsetHeight || 0) / 2 + edgePadding)
      position.vx += (width / 2 - position.x) * centerStrength
      position.vy += (height / 2 - position.y) * centerStrength
      position.vx *= 0.88
      position.vy *= 0.88
      maximumSpeed = Math.max(maximumSpeed, Math.hypot(position.vx, position.vy))
      position.x = clamp(position.x + position.vx, marginX, Math.max(marginX, width - marginX))
      position.y = clamp(position.y + position.vy, marginY, Math.max(marginY, height - marginY))
    }
    return maximumSpeed
  }

  private draw(timestamp = 0): void {
    const width = this.topology.clientWidth
    const height = this.topology.clientHeight
    const pixelRatio = devicePixelRatio || 1
    if (this.canvas.width !== Math.round(width * pixelRatio) || this.canvas.height !== Math.round(height * pixelRatio)) {
      this.canvas.width = Math.round(width * pixelRatio)
      this.canvas.height = Math.round(height * pixelRatio)
    }
    this.context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
    this.context.clearRect(0, 0, width, height)

    for (const [edgeIndex, edge] of this.edges.entries()) {
      const source = this.motionStates.get(edge.source)
      const target = this.motionStates.get(edge.target)
      if (!source || !target)
        continue
      this.context.save()
      this.context.setLineDash(edge.connected ? [] : [7, 7])
      this.context.lineWidth = edge.connected ? 2.8 : 1.4
      this.context.strokeStyle = edge.connected ? '#52c9c3' : '#465465'
      if (edge.connected) {
        this.context.shadowBlur = 9
        this.context.shadowColor = '#52c9c3'
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

    for (const [nodeId, position] of this.motionStates) {
      const element = this.nodeElements.get(nodeId)
      if (element) {
        element.style.left = `${position.x}px`
        element.style.top = `${position.y}px`
      }
    }
  }

  private drawFlowParticles(source: NodeMotionState, target: NodeMotionState, timestamp: number, edgeIndex: number): void {
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
    source: NodeMotionState,
    target: NodeMotionState,
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
    this.context.lineWidth = 3
    this.context.lineCap = 'round'
    this.context.shadowBlur = 11
    this.context.shadowColor = '#72efe7'
    this.context.beginPath()
    this.context.moveTo(tailX, tailY)
    this.context.lineTo(x, y)
    this.context.stroke()

    this.context.fillStyle = '#e8fffd'
    this.context.beginPath()
    this.context.arc(x, y, 2.4, 0, Math.PI * 2)
    this.context.fill()
    this.context.restore()
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function cloneMotionStates(states: Map<string, NodeMotionState>): Map<string, NodeMotionState> {
  return new Map([...states].map(([nodeId, state]) => [nodeId, { ...state }]))
}

function copyMotionStates(target: Map<string, NodeMotionState>, source: Map<string, NodeMotionState>): void {
  for (const [nodeId, state] of source)
    target.set(nodeId, { ...state })
}

function lerp(start: number, end: number, progress: number): number {
  return start + (end - start) * progress
}
