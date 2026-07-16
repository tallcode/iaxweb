const topology = document.querySelector('#topology')
const canvas = document.querySelector('#edges')
const nodesLayer = document.querySelector('#nodes')
const empty = document.querySelector('#empty')
const summary = document.querySelector('#summary')
const context = canvas.getContext('2d')
const positions = new Map()
const elements = new Map()
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
const mobileViewport = matchMedia('(max-width: 680px)')

let state = {}
let edges = []
let animationFrame = 0
let reconnectAttempt = 0

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  month: '2-digit',
  second: '2-digit',
})

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(`${protocol}//${location.host}/status`)

  socket.addEventListener('open', () => {
    reconnectAttempt = 0
    summary.textContent = '已连接，等待完整节点状态…'
  })
  socket.addEventListener('message', (event) => {
    try {
      update(JSON.parse(event.data))
    }
    catch {
      summary.textContent = '收到无法解析的状态数据'
    }
  })
  socket.addEventListener('close', () => {
    summary.textContent = '状态服务已断开，正在重连…'
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempt++, 5))
    setTimeout(connect, delay)
  })
  socket.addEventListener('error', () => socket.close())
}

function update(nextState) {
  state = nextState
  const nodeIds = Object.keys(state)
  const activeIds = new Set(nodeIds)

  for (const [nodeId, element] of elements) {
    if (!activeIds.has(nodeId)) {
      element.remove()
      elements.delete(nodeId)
      positions.delete(nodeId)
    }
  }

  for (const [index, nodeId] of nodeIds.entries()) {
    if (!positions.has(nodeId))
      positions.set(nodeId, initialPosition(index, nodeIds.length))
    renderNode(nodeId, state[nodeId])
  }

  edges = collectEdges(state)
  empty.hidden = nodeIds.length > 0
  const onlineCount = nodeIds.filter(nodeId => state[nodeId].ONLINE === true).length
  const transmittingCount = nodeIds.filter(nodeId => state[nodeId].TYPE !== 'HUB' && state[nodeId].TX_SOURCE).length
  const summaryLabel = `${nodeIds.length} 个节点 · ${onlineCount} 个在线 · ${transmittingCount} 个正在发射`
  summary.textContent = mobileViewport.matches ? `${nodeIds.length}/${onlineCount}/${transmittingCount}` : summaryLabel
  summary.setAttribute('aria-label', summaryLabel)
  startLayout()
}

function renderNode(nodeId, node) {
  let element = elements.get(nodeId)
  if (!element) {
    element = document.createElement('article')
    element.className = 'node'
    element.innerHTML = `
      <p class="node-name"></p>
      <div class="node-meta">
        <span class="node-kind">HUB</span>
        <span class="node-frequency"></span>
      </div>
      <div class="node-status">
        <span class="node-state">
          <span class="online-label"><i class="dot"></i><span></span></span>
          <span class="tx-label"></span>
        </span>
        <time></time>
      </div>
    `
    nodesLayer.append(element)
    elements.set(nodeId, element)
  }

  const isHub = node.TYPE === 'HUB'
  const online = node.ONLINE === true
  const source = online && !isHub ? node.TX_SOURCE : null
  const displayName = mobileViewport.matches ? (node.NAME || nodeId) : (node.DESC || node.NAME || nodeId)
  element.className = `node ${isHub ? 'hub' : 'repeater'} ${online ? 'online' : 'offline'}${source ? ` tx-${source}` : ''}`
  element.querySelector('.node-kind').hidden = !isHub
  element.querySelector('.node-name').textContent = displayName
  const frequency = element.querySelector('.node-frequency')
  frequency.hidden = isHub
  frequency.textContent = node.FREQ || '频率未配置'
  const onlineLabel = element.querySelector('.online-label')
  onlineLabel.hidden = Boolean(source)
  onlineLabel.querySelector('span').textContent = online ? '在线' : '离线'
  onlineLabel.querySelector('.dot').className = `dot ${online ? 'online' : 'offline'}`
  const status = element.querySelector('.node-status')
  status.hidden = false
  const transmit = element.querySelector('.tx-label')
  transmit.hidden = !source
  transmit.textContent = transmitLabel(source)
  const time = element.querySelector('time')
  time.hidden = isHub || Boolean(source)
  time.textContent = node.LAST_TX_AT ? `上次 ${timeFormatter.format(new Date(node.LAST_TX_AT))}` : '暂无发射记录'
  time.dateTime = node.LAST_TX_AT || ''
  element.setAttribute('aria-label', isHub
    ? `${nodeId} ${displayName}，HUB，${online ? '在线' : '离线'}`
    : `${nodeId} ${displayName}，${online ? '在线' : '离线'}${source ? `，${transmitLabel(source)}` : ''}`)
}

function transmitLabel(source) {
  if (source === 'local')
    return '本地发射'
  if (source === 'remote')
    return '远程发射'
  if (source === 'system')
    return '系统发射'
  return ''
}

function collectEdges(snapshot) {
  const knownNodes = new Set(Object.keys(snapshot))
  const found = new Map()
  for (const [nodeId, node] of Object.entries(snapshot)) {
    for (const linkedId of node.LINK || []) {
      if (!knownNodes.has(linkedId))
        continue
      const pair = [nodeId, linkedId].sort((left, right) => Number(left) - Number(right))
      found.set(pair.join(':'), {
        connected: isConnected(snapshot, pair[0], pair[1]),
        source: pair[0],
        target: pair[1],
      })
    }
  }
  return [...found.values()]
}

function isConnected(snapshot, source, target) {
  return connectionIsEstablished(snapshot[source]?.CONNS?.[target])
    || connectionIsEstablished(snapshot[target]?.CONNS?.[source])
}

function connectionIsEstablished(connection) {
  return connection && (!connection.CSTATE || connection.CSTATE === 'ESTABLISHED')
}

function initialPosition(index, total) {
  const width = topology.clientWidth || 800
  const height = topology.clientHeight || 600
  const angle = total > 1 ? index / total * Math.PI * 2 : 0
  const radius = Math.min(width, height) * 0.3
  return {
    vx: 0,
    vy: 0,
    x: width / 2 + Math.cos(angle) * radius,
    y: height / 2 + Math.sin(angle) * radius,
  }
}

function startLayout() {
  cancelAnimationFrame(animationFrame)
  let frame = 0
  const maxFrames = topology.clientWidth < 680 ? 240 : 160

  function animate(timestamp) {
    if (frame < maxFrames) {
      simulate()
      frame++
    }
    draw(timestamp)
    if (frame < maxFrames || shouldAnimateFlow())
      animationFrame = requestAnimationFrame(animate)
  }

  animate(performance.now())
}

function shouldAnimateFlow() {
  return !reduceMotion && edges.some(edge => edge.connected)
}

function simulate() {
  const entries = [...positions.entries()]
  const width = topology.clientWidth
  const height = topology.clientHeight

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

      const firstElement = elements.get(entries[left][0])
      const secondElement = elements.get(entries[right][0])
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

  for (const edge of edges) {
    const source = positions.get(edge.source)
    const target = positions.get(edge.target)
    if (!source || !target)
      continue
    const dx = target.x - source.x
    const dy = target.y - source.y
    const distance = Math.max(1, Math.hypot(dx, dy))
    const idealDistance = width < 680 ? clamp(width * 0.42, 120, 170) : 265
    const force = (distance - idealDistance) * 0.0028
    const fx = dx / distance * force
    const fy = dy / distance * force
    source.vx += fx
    source.vy += fy
    target.vx -= fx
    target.vy -= fy
  }

  for (const [nodeId, position] of entries) {
    const element = elements.get(nodeId)
    const marginX = Math.min(width / 2, (element?.offsetWidth || 0) / 2 + 8)
    const marginY = Math.min(height / 2, (element?.offsetHeight || 0) / 2 + 8)
    position.vx += (width / 2 - position.x) * 0.0007
    position.vy += (height / 2 - position.y) * 0.0007
    position.vx *= 0.88
    position.vy *= 0.88
    position.x = clamp(position.x + position.vx, marginX, Math.max(marginX, width - marginX))
    position.y = clamp(position.y + position.vy, marginY, Math.max(marginY, height - marginY))
  }
}

function draw(timestamp = 0) {
  const width = topology.clientWidth
  const height = topology.clientHeight
  const pixelRatio = devicePixelRatio || 1
  if (canvas.width !== Math.round(width * pixelRatio) || canvas.height !== Math.round(height * pixelRatio)) {
    canvas.width = Math.round(width * pixelRatio)
    canvas.height = Math.round(height * pixelRatio)
  }
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
  context.clearRect(0, 0, width, height)

  for (const [edgeIndex, edge] of edges.entries()) {
    const source = positions.get(edge.source)
    const target = positions.get(edge.target)
    if (!source || !target)
      continue
    context.save()
    context.setLineDash(edge.connected ? [] : [7, 7])
    context.lineWidth = edge.connected ? 2.8 : 1.4
    context.strokeStyle = edge.connected ? '#52c9c3' : '#465465'
    if (edge.connected) {
      context.shadowBlur = 9
      context.shadowColor = '#52c9c3'
    }
    context.beginPath()
    context.moveTo(source.x, source.y)
    context.lineTo(target.x, target.y)
    context.stroke()
    context.restore()

    if (edge.connected && !reduceMotion)
      drawFlowParticles(source, target, timestamp, edgeIndex)
  }
  context.setLineDash([])

  for (const [nodeId, position] of positions) {
    const element = elements.get(nodeId)
    if (element) {
      element.style.left = `${position.x}px`
      element.style.top = `${position.y}px`
    }
  }
}

function drawFlowParticles(source, target, timestamp, edgeIndex) {
  const dx = target.x - source.x
  const dy = target.y - source.y
  const distance = Math.max(1, Math.hypot(dx, dy))
  const unitX = dx / distance
  const unitY = dy / distance
  const normalX = -unitY
  const normalY = unitX

  for (const phase of [0, 0.5]) {
    const progress = (timestamp / 1_650 + phase + edgeIndex * 0.13) % 1
    drawDirectionalPulse(source, target, unitX, unitY, normalX, normalY, progress, 1)
    drawDirectionalPulse(source, target, unitX, unitY, normalX, normalY, 1 - progress, -1)
  }
}

function drawDirectionalPulse(source, target, unitX, unitY, normalX, normalY, progress, direction) {
  const laneOffset = direction * 3.5
  const x = source.x + (target.x - source.x) * progress + normalX * laneOffset
  const y = source.y + (target.y - source.y) * progress + normalY * laneOffset
  const tailX = x - unitX * direction * 15
  const tailY = y - unitY * direction * 15

  context.save()
  const gradient = context.createLinearGradient(tailX, tailY, x, y)
  gradient.addColorStop(0, 'rgb(114 239 231 / 0)')
  gradient.addColorStop(1, '#d8fffc')
  context.strokeStyle = gradient
  context.lineWidth = 3
  context.lineCap = 'round'
  context.shadowBlur = 11
  context.shadowColor = '#72efe7'
  context.beginPath()
  context.moveTo(tailX, tailY)
  context.lineTo(x, y)
  context.stroke()

  context.fillStyle = '#e8fffd'
  context.beginPath()
  context.arc(x, y, 2.4, 0, Math.PI * 2)
  context.fill()
  context.restore()
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value))
}

new ResizeObserver(() => startLayout()).observe(topology)
mobileViewport.addEventListener('change', () => update(state))
connect()
