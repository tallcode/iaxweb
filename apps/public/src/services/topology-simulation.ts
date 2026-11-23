import type { TopologyEdge } from './topology-graph'

export interface NodeMotionState {
  vx: number
  vy: number
  x: number
  y: number
}

interface NodeSize {
  width: number
  height: number
}

interface LayoutBounds {
  width: number
  height: number
  isMobile: boolean
  nodeSizes: ReadonlyMap<string, NodeSize>
}

const LAYOUT_ITERATION_LIMIT = 480
const REQUIRED_STABLE_ITERATIONS = 36
const STABLE_SPEED_THRESHOLD = 0.03

export function solveTopologyLayout(
  initialStates: ReadonlyMap<string, NodeMotionState>,
  edges: readonly TopologyEdge[],
  { width, height, isMobile, nodeSizes }: LayoutBounds,
): Map<string, NodeMotionState> {
  const states = new Map([...initialStates].map(([id, state]) => [id, { ...state }]))
  const entries = [...states.entries()]
  const repulsionStrength = isMobile ? 13_500 : 18_000
  const linkStrength = isMobile ? 0.0045 : 0.0028
  const centerStrength = isMobile ? 0.00105 : 0.0007
  const idealDistance = isMobile ? clamp(width * 0.3, 80, 120) : 265
  const cardGap = isMobile ? 24 : 12
  const collisionStrength = isMobile ? 0.12 : 0.04
  const maximumCollisionForce = isMobile ? 4 : 2.5
  const edgePadding = isMobile ? 16 : 8

  let stableIterations = 0
  for (let iteration = 0; iteration < LAYOUT_ITERATION_LIMIT && stableIterations < REQUIRED_STABLE_ITERATIONS; iteration++) {
    const maximumSpeed = simulate()
    stableIterations = maximumSpeed < STABLE_SPEED_THRESHOLD ? stableIterations + 1 : 0
  }
  return states

  function simulate(): number {
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

        const firstSize = nodeSizes.get(firstEntry[0])
        const secondSize = nodeSizes.get(secondEntry[0])
        const minimumX = ((firstSize?.width || 0) + (secondSize?.width || 0)) / 2 + cardGap
        const minimumY = ((firstSize?.height || 0) + (secondSize?.height || 0)) / 2 + cardGap
        const overlapX = minimumX - Math.abs(dx)
        const overlapY = minimumY - Math.abs(dy)
        if (overlapX > 0 && overlapY > 0) {
          if (overlapX < overlapY) {
            const direction = dx >= 0 ? 1 : -1
            const collisionForce = Math.min(maximumCollisionForce, overlapX * collisionStrength)
            first.vx -= direction * collisionForce
            second.vx += direction * collisionForce
          }
          else {
            const direction = dy >= 0 ? 1 : -1
            const collisionForce = Math.min(maximumCollisionForce, overlapY * collisionStrength)
            first.vy -= direction * collisionForce
            second.vy += direction * collisionForce
          }
        }
      }
    }

    for (const edge of edges) {
      const source = states.get(edge.source)
      const target = states.get(edge.target)
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
      const size = nodeSizes.get(nodeId)
      const marginX = Math.min(width / 2, (size?.width || 0) / 2 + edgePadding)
      const marginY = Math.min(height / 2, (size?.height || 0) / 2 + edgePadding)
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
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}
