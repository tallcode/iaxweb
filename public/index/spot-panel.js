// AI Spot: newest recognized callsign per station, backed by /api/spots history
// and live {type:'spot'} messages on the status WebSocket.
const MAX_ITEMS = 100
const NO_CALLSIGN = 'N0CALL'

export class SpotPanel {
  constructor(root) {
    this.root = root
    this.list = root.querySelector('.spot-list')
    this.empty = root.querySelector('.spot-empty')
    this.spots = new Map() // segment id → spot
    this.enabled = false
    this.started = false
  }

  setEnabled(enabled) {
    if (this.enabled === enabled)
      return
    this.enabled = enabled
    this.root.hidden = !enabled
    if (enabled && !this.started)
      this.start()
  }

  start() {
    this.started = true
    void this.loadHistory()
    // Keep relative timestamps live.
    setInterval(() => this.render(), 15_000)
  }

  // Applies a live spot or merges loaded history by immutable segment id.
  apply(spot) {
    if (!this.enabled)
      return
    if (spot.callsign === NO_CALLSIGN) {
      this.spots.delete(spot.id)
      this.render()
      return
    }
    const previous = this.spots.get(spot.id)
    if (!previous || spot.at >= previous.at) {
      this.spots.set(spot.id, spot)
      this.render()
    }
  }

  async loadHistory() {
    try {
      const response = await fetch('/api/spots')
      if (!response.ok)
        return
      for (const spot of await response.json())
        this.apply(spot)
      this.render()
    }
    catch {
      // History is optional; live spots still work.
    }
  }

  render() {
    const newestByCallsign = new Map()
    for (const spot of this.spots.values()) {
      const current = newestByCallsign.get(spot.callsign)
      if (!current || spot.at >= current.at)
        newestByCallsign.set(spot.callsign, spot)
    }
    const sorted = [...newestByCallsign.values()].sort((a, b) => (a.at < b.at ? 1 : -1))
    this.empty.hidden = sorted.length > 0

    const keyFor = spot => `${spot.id}|${spot.callsign}|${spot.node}|${spot.at}`
    const currentKeys = new Set([...this.list.children].map(child => child.dataset.key))
    const desiredKeys = new Set(sorted.map(keyFor))
    const sameSet = currentKeys.size === desiredKeys.size
      && [...currentKeys].every(key => desiredKeys.has(key))

    if (sameSet) {
      // Only the timestamps changed: refresh them in place.
      const items = [...this.list.children]
      sorted.slice(0, MAX_ITEMS).forEach((spot, index) => {
        const time = items[index]?.querySelector('time')
        if (time)
          time.textContent = relativeTime(spot.at)
      })
      return
    }

    this.list.replaceChildren()
    for (const spot of sorted.slice(0, MAX_ITEMS)) {
      const li = document.createElement('li')
      li.className = 'spot-item'
      li.dataset.key = keyFor(spot)
      li.innerHTML = `
        <span class="spot-callsign">${escapeHtml(spot.callsign)}</span>
        <time class="spot-time" datetime="${escapeAttr(spot.at)}"></time>
      `
      li.querySelector('time').textContent = relativeTime(spot.at)
      this.list.append(li)
    }
  }
}

function relativeTime(iso) {
  const then = new Date(iso)
  if (Number.isNaN(then.getTime()))
    return ''
  const seconds = Math.max(0, Math.round((Date.now() - then.getTime()) / 1000))
  if (seconds < 60)
    return `${seconds}秒前`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60)
    return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24)
    return `${hours}小时前`
  return `${Math.floor(hours / 24)}天前`
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    '\'': '&#39;',
  })[char])
}

function escapeAttr(text) {
  return escapeHtml(text)
}
