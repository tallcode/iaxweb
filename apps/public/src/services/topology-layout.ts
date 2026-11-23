import type { TopologyEdge } from './topology-graph'
import type { NodeMotionState } from './topology-simulation'
import { TopologyCanvas } from './topology-canvas'
import { solveTopologyLayout } from './topology-simulation'

const INITIAL_ANIMATION_MS = 2_000
const RELAYOUT_ANIMATION_MS = 1_000

export class TopologyLayout {
  private disposed = false
  private animationFrame = 0
  private readonly renderer: TopologyCanvas
  private readonly nodeElements: Map<string, HTMLElement>
  private edges: TopologyEdge[] = []
  private readonly motionStates = new Map<string, NodeMotionState>()
  private readonly reduceMotion: boolean
  private readonly isMobile: () => boolean
  private signature = ''
  private hasStartedLayout = false
  private readonly topology: HTMLElement

  constructor(
    topology: HTMLElement,
    canvas: HTMLCanvasElement,
    nodeElements: Map<string, HTMLElement>,
    reduceMotion: boolean,
    isMobile: () => boolean,
  ) {
    this.topology = topology
    this.renderer = new TopologyCanvas(canvas, reduceMotion)
    this.nodeElements = nodeElements
    this.reduceMotion = reduceMotion
    this.isMobile = isMobile
  }

  ensureNode(nodeId: string, index: number, total: number): void {
    if (this.disposed)
      return
    if (!this.motionStates.has(nodeId))
      this.motionStates.set(nodeId, this.initialMotionState(index, total))
  }

  removeNode(nodeId: string): void {
    this.motionStates.delete(nodeId)
  }

  updateGraph(edges: TopologyEdge[], signature: string): void {
    if (this.disposed)
      return
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

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.animationFrame)
    this.animationFrame = 0
    this.edges = []
    this.motionStates.clear()
    this.nodeElements.clear()
    this.renderer.clear()
  }

  private initialMotionState(index: number, total: number): NodeMotionState {
    const width = this.topology.clientWidth || 800
    const height = this.topology.clientHeight || 600
    const angle = total > 1 ? index / total * Math.PI * 2 : 0
    const radiusRatio = this.isMobile() ? 0.22 : 0.3
    const radius = Math.min(width, height) * radiusRatio
    return {
      vx: 0,
      vy: 0,
      x: width / 2 + Math.cos(angle) * radius,
      y: height / 2 + Math.sin(angle) * radius,
    }
  }

  private startLayout(): void {
    if (this.disposed)
      return
    cancelAnimationFrame(this.animationFrame)
    this.animationFrame = 0
    const duration = this.hasStartedLayout ? RELAYOUT_ANIMATION_MS : INITIAL_ANIMATION_MS
    this.hasStartedLayout = true
    const initialStates = cloneMotionStates(this.motionStates)
    // Measure once for the synchronous layout pass.
    const nodeSizes = new Map([...this.nodeElements].map(([id, element]) => [id, {
      width: element.offsetWidth,
      height: element.offsetHeight,
    }]))
    // Solve the stable target up front, then animate toward it.
    const targetStates = solveTopologyLayout(initialStates, this.edges, {
      width: this.topology.clientWidth,
      height: this.topology.clientHeight,
      isMobile: this.isMobile(),
      nodeSizes,
    })

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

  private draw(timestamp: number): void {
    this.renderer.draw(this.topology.clientWidth, this.topology.clientHeight, this.edges, this.motionStates, timestamp)
    for (const [nodeId, position] of this.motionStates) {
      const element = this.nodeElements.get(nodeId)
      if (element) {
        element.style.left = `${position.x}px`
        element.style.top = `${position.y}px`
      }
    }
  }
}

function cloneMotionStates(states: Map<string, NodeMotionState>): Map<string, NodeMotionState> {
  return new Map([...states].map(([nodeId, state]) => [nodeId, { ...state }]))
}

function lerp(start: number, end: number, progress: number): number {
  return start + (end - start) * progress
}
