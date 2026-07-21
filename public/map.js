import { AudioStreamPlayer, SpectrumMeter } from './audio-player.js'
import { expireSnapshot, StatusStreamClient } from './status-client.js'
import { TopologyLayout } from './topology-layout.js'
import { collectEdges, graphSignature } from './topology-model.js'

const topology = document.querySelector('#topology')
const canvas = document.querySelector('#edges')
const nodesLayer = document.querySelector('#nodes')
const empty = document.querySelector('#empty')
const summary = document.querySelector('#summary')
const elements = new Map()
const audioMeters = new Map()
const audioPlayer = new AudioStreamPlayer()
const mobileViewport = matchMedia('(max-width: 680px)')

let viewportHeight = 0

function syncViewportHeight() {
  const nextHeight = Math.floor(window.visualViewport?.height ?? window.innerHeight)
  if (nextHeight === viewportHeight)
    return

  viewportHeight = nextHeight
  document.documentElement.style.setProperty('--app-height', `${nextHeight}px`)
}

syncViewportHeight()
window.addEventListener('resize', syncViewportHeight)
window.visualViewport?.addEventListener('resize', syncViewportHeight)

const layout = new TopologyLayout(
  topology,
  canvas,
  elements,
  matchMedia('(prefers-reduced-motion: reduce)').matches,
)

let snapshot = {}

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  month: '2-digit',
  second: '2-digit',
})

function renderSnapshot(nextSnapshot) {
  snapshot = nextSnapshot
  const nodeIds = Object.keys(snapshot)
  const activeIds = new Set(nodeIds)

  for (const [nodeId, element] of elements) {
    if (!activeIds.has(nodeId)) {
      if (audioPlayer.playingKey === nodeId)
        void audioPlayer.stop()
      audioMeters.delete(nodeId)
      element.remove()
      elements.delete(nodeId)
      layout.removeNode(nodeId)
    }
  }

  for (const [index, nodeId] of nodeIds.entries()) {
    layout.ensureNode(nodeId, index, nodeIds.length)
    renderNode(nodeId, snapshot[nodeId])
  }

  const edges = collectEdges(snapshot)
  empty.hidden = nodeIds.length > 0
  renderSummary(nodeIds)
  layout.updateGraph(
    edges,
    graphSignature(nodeIds, edges, elements, mobileViewport.matches),
  )
}

function renderSummary(nodeIds) {
  const onlineCount = nodeIds.filter(nodeId => snapshot[nodeId].ONLINE === true).length
  const transmittingCount = nodeIds.filter(nodeId => snapshot[nodeId].TYPE !== 'HUB' && snapshot[nodeId].TX_SOURCE).length
  const label = `${nodeIds.length} 个节点 · ${onlineCount} 个在线 · ${transmittingCount} 个正在发射`
  summary.textContent = mobileViewport.matches ? `${nodeIds.length}/${onlineCount}/${transmittingCount}` : label
  summary.setAttribute('aria-label', label)
}

function renderNode(nodeId, node) {
  let element = elements.get(nodeId)
  if (!element) {
    element = createNodeElement()
    nodesLayer.append(element)
    elements.set(nodeId, element)
  }

  const isHub = node.TYPE === 'HUB'
  const online = node.ONLINE === true
  const source = online && !isHub ? node.TX_SOURCE : null
  const hasAudio = isHub && node.AUDIO === true
  const displayName = mobileViewport.matches ? (node.NAME || nodeId) : (node.DESC || node.NAME || nodeId)
  element.className = `node ${isHub ? 'hub' : 'repeater'} ${online ? 'online' : 'offline'}${source ? ` tx-${source}` : ''}${hasAudio ? ' has-audio' : ''}`
  element.querySelector('.node-kind').hidden = !isHub
  element.querySelector('.node-name').textContent = displayName

  const frequency = element.querySelector('.node-frequency')
  frequency.hidden = isHub
  frequency.textContent = node.FREQ || '频率未配置'

  const onlineLabel = element.querySelector('.online-label')
  onlineLabel.hidden = Boolean(source)
  onlineLabel.querySelector('span').textContent = online ? '在线' : '离线'
  onlineLabel.querySelector('.dot').className = `dot ${online ? 'online' : 'offline'}`

  const transmit = element.querySelector('.tx-label')
  transmit.hidden = !source
  transmit.textContent = transmitLabel(source)

  const time = element.querySelector('time')
  time.hidden = isHub || Boolean(source)
  time.textContent = node.LAST_TX_AT ? `上次 ${timeFormatter.format(new Date(node.LAST_TX_AT))}` : '暂无发射记录'
  time.dateTime = node.LAST_TX_AT || ''

  const listeners = Number.isInteger(node.LISTENERS) && node.LISTENERS >= 0 ? node.LISTENERS : 0
  const listenerCount = element.querySelector('.listener-count')
  listenerCount.hidden = !hasAudio
  listenerCount.querySelector('.listener-number').textContent = String(listeners)
  listenerCount.title = `${listeners}人正在监听`
  listenerCount.setAttribute('aria-label', `${listeners}人正在监听`)

  renderAudioControl(nodeId, element, hasAudio)
  element.setAttribute('aria-label', isHub
    ? `${nodeId} ${displayName}，HUB，${online ? '在线' : '离线'}${hasAudio ? `，${listeners}人正在监听` : ''}`
    : `${nodeId} ${displayName}，${online ? '在线' : '离线'}${source ? `，${transmitLabel(source)}` : ''}`)
}

function createNodeElement() {
  const element = document.createElement('article')
  element.className = 'node'
  element.innerHTML = `
    <p class="node-name"></p>
    <div class="node-footer">
      <div class="node-details">
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
      </div>
      <div class="node-audio" hidden>
        <span class="listener-count" title="0人正在监听" aria-label="0人正在监听">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M16 11a4 4 0 1 0-3.45-6A4 4 0 0 0 16 11ZM8 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm8 1c-1.2 0-2.33.28-3.34.77A7.45 7.45 0 0 1 15.5 19v1H22v-1c0-3.31-2.69-6-6-6ZM8 14c-3.87 0-7 2.69-7 6h14c0-3.31-3.13-6-7-6Z"/>
          </svg>
          <span class="listener-number">0</span>
        </span>
        <div class="spectrum" aria-hidden="true"></div>
        <button class="audio-toggle" type="button" aria-label="播放音频" aria-pressed="false">▶</button>
      </div>
    </div>
  `
  return element
}

function renderAudioControl(nodeId, element, hasAudio) {
  const controls = element.querySelector('.node-audio')
  controls.hidden = !hasAudio
  if (!hasAudio) {
    if (audioPlayer.playingKey === nodeId)
      void audioPlayer.stop()
    return
  }
  if (audioMeters.has(nodeId))
    return

  const button = controls.querySelector('.audio-toggle')
  const meter = new SpectrumMeter(controls, { enabled: () => !mobileViewport.matches })
  button.addEventListener('click', () => {
    void audioPlayer.toggle(nodeId, button, meter, { play: '▶', stop: '■' })
      .catch(() => audioPlayer.stop())
  })
  audioMeters.set(nodeId, meter)
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

new ResizeObserver(() => layout.relayout()).observe(topology)
mobileViewport.addEventListener('change', (event) => {
  audioPlayer.setVisualizationEnabled(!event.matches)
  renderSnapshot(snapshot)
})

const statusClient = new StatusStreamClient({
  onExpired: () => renderSnapshot(expireSnapshot(snapshot)),
  onInvalidMessage: () => {
    summary.textContent = '收到无法解析的状态数据'
  },
  onConnecting: () => {
    summary.textContent = '状态服务已断开，正在重连…'
  },
  onOpen: () => {
    summary.textContent = '已连接，等待完整节点状态…'
  },
  onSnapshot: renderSnapshot,
})
statusClient.start()
