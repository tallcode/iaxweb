export class TopologyLayout {
  constructor(topology, canvas, elements, reduceMotion) {
    this.topology = topology
    this.canvas = canvas
    this.context = canvas.getContext('2d')
    this.elements = elements
    this.reduceMotion = reduceMotion
    this.positions = new Map()
    this.edges = []
    this.animationFrame = 0
    this.signature = ''
  }

  ensureNode(nodeId, index, total) {
    if (!this.positions.has(nodeId))
      this.positions.set(nodeId, this.initialPosition(index, total))
  }

  removeNode(nodeId) {
    this.positions.delete(nodeId)
  }

  updateGraph(edges, signature) {
    this.edges = edges
    if (signature !== this.signature) {
      this.signature = signature
      this.startLayout()
      return
    }
    this.draw(performance.now())
    this.ensureFlowAnimation()
  }

  relayout() {
    this.signature = ''
    this.startLayout()
  }

  initialPosition(index, total) {
    const width = this.topology.clientWidth || 800
    const height = this.topology.clientHeight || 600
    const angle = total > 1 ? index / total * Math.PI * 2 : 0
    const radius = Math.min(width, height) * 0.3
    return {
      vx: 0,
      vy: 0,
      x: width / 2 + Math.cos(angle) * radius,
      y: height / 2 + Math.sin(angle) * radius,
    }
  }

  startLayout() {
    cancelAnimationFrame(this.animationFrame)
    let frame = 0
    const maxFrames = this.topology.clientWidth < 680 ? 240 : 160

    const animate = (timestamp) => {
      if (frame < maxFrames) {
        this.simulate()
        frame++
      }
      this.draw(timestamp)
      if (frame < maxFrames || this.shouldAnimateFlow())
        this.animationFrame = requestAnimationFrame(animate)
      else
        this.animationFrame = 0
    }

    animate(performance.now())
  }

  ensureFlowAnimation() {
    if (this.animationFrame || !this.shouldAnimateFlow())
      return

    const animate = (timestamp) => {
      this.draw(timestamp)
      if (this.shouldAnimateFlow())
        this.animationFrame = requestAnimationFrame(animate)
      else
        this.animationFrame = 0
    }

    this.animationFrame = requestAnimationFrame(animate)
  }

  shouldAnimateFlow() {
    return !this.reduceMotion && this.edges.some(edge => edge.connected)
  }

  simulate() {
    const entries = [...this.positions.entries()]
    const width = this.topology.clientWidth
    const height = this.topology.clientHeight

    for (let left = 0; left < entries.length; left++) {
      for (let right = left + 1; right < entries.length; right++) {
        const first = entries[left][1]
        const second = entries[right][1]
        const dx = second.x - first.x || 0.1
        const dy = second.y - first.y || 0.1
        const distanceSquared = Math.max(400, dx * dx + dy * dy)
        const distance = Math.sqrt(distanceSquared)
        const force = 18_000 / distanceSquared
        const fx = dx / distance * force
        const fy = dy / distance * force
        first.vx -= fx
        first.vy -= fy
        second.vx += fx
        second.vy += fy

        const firstElement = this.elements.get(entries[left][0])
        const secondElement = this.elements.get(entries[right][0])
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
      const source = this.positions.get(edge.source)
      const target = this.positions.get(edge.target)
      if (!source || !target)
        continue
      const dx = target.x - source.x
      const dy = target.y - source.y
      const distance = Math.max(1, Math.hypot(dx, dy))
      const idealDistance = width < 680 ? clamp(width * 0.3, 80, 120) : 265
      const force = (distance - idealDistance) * 0.0028
      const fx = dx / distance * force
      const fy = dy / distance * force
      source.vx += fx
      source.vy += fy
      target.vx -= fx
      target.vy -= fy
    }

    for (const [nodeId, position] of entries) {
      const element = this.elements.get(nodeId)
      const edgePadding = width < 680 ? 16 : 8
      const marginX = Math.min(width / 2, (element?.offsetWidth || 0) / 2 + edgePadding)
      const marginY = Math.min(height / 2, (element?.offsetHeight || 0) / 2 + edgePadding)
      position.vx += (width / 2 - position.x) * 0.0007
      position.vy += (height / 2 - position.y) * 0.0007
      position.vx *= 0.88
      position.vy *= 0.88
      position.x = clamp(position.x + position.vx, marginX, Math.max(marginX, width - marginX))
      position.y = clamp(position.y + position.vy, marginY, Math.max(marginY, height - marginY))
    }
  }

  draw(timestamp = 0) {
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
      const source = this.positions.get(edge.source)
      const target = this.positions.get(edge.target)
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

    for (const [nodeId, position] of this.positions) {
      const element = this.elements.get(nodeId)
      if (element) {
        element.style.left = `${position.x}px`
        element.style.top = `${position.y}px`
      }
    }
  }

  drawFlowParticles(source, target, timestamp, edgeIndex) {
    const dx = target.x - source.x
    const dy = target.y - source.y
    const distance = Math.max(1, Math.hypot(dx, dy))
    const unitX = dx / distance
    const unitY = dy / distance
    const normalX = -unitY
    const normalY = unitX

    for (const phase of [0, 0.5]) {
      const progress = (timestamp / 1_650 + phase + edgeIndex * 0.13) % 1
      this.drawDirectionalPulse(source, target, unitX, unitY, normalX, normalY, progress, 1)
      this.drawDirectionalPulse(source, target, unitX, unitY, normalX, normalY, 1 - progress, -1)
    }
  }

  drawDirectionalPulse(source, target, unitX, unitY, normalX, normalY, progress, direction) {
    const laneOffset = direction * 3.5
    const x = source.x + (target.x - source.x) * progress + normalX * laneOffset
    const y = source.y + (target.y - source.y) * progress + normalY * laneOffset
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

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value))
}
