const PAGE_SIZE = 50
const loginView = document.querySelector('#login-view')
const segmentsView = document.querySelector('#segments-view')
const loginForm = document.querySelector('#login-form')
const loginError = document.querySelector('#login-error')
const status = document.querySelector('#status')
const body = document.querySelector('#segments')
const pageLabel = document.querySelector('#page')
const previous = document.querySelector('#previous')
const next = document.querySelector('#next')
let page = 1
let total = 0

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  const form = new FormData(loginForm)
  const response = await fetch('/api/admin/login', {
    body: JSON.stringify({
      password: form.get('password'),
      username: form.get('username'),
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) {
    loginError.textContent = '用户名或密码错误'
    loginError.hidden = false
    return
  }
  loginError.hidden = true
  loginView.hidden = true
  segmentsView.hidden = false
  await load()
})

document.querySelector('#logout').addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST' })
  body.replaceChildren()
  segmentsView.hidden = true
  loginView.hidden = false
  loginForm.reset()
})
previous.addEventListener('click', async () => {
  page--
  await load()
})
next.addEventListener('click', async () => {
  page++
  await load()
})

async function load() {
  status.textContent = '加载中…'
  const response = await fetch(`/api/admin/segments?page=${page}&pageSize=${PAGE_SIZE}`)
  if (response.status === 401) {
    segmentsView.hidden = true
    loginView.hidden = false
    return
  }
  if (!response.ok) {
    status.textContent = response.status === 503 ? '持久化未启用' : '加载失败'
    return
  }
  const data = await response.json()
  loginView.hidden = true
  segmentsView.hidden = false
  total = data.total
  render(data.items)
  status.textContent = total === 0 ? '暂无记录' : `共 ${total} 条记录`
  pageLabel.textContent = `第 ${page} 页 / ${Math.max(1, Math.ceil(total / PAGE_SIZE))} 页`
  previous.disabled = page <= 1
  next.disabled = page * PAGE_SIZE >= total
}

function render(items) {
  body.replaceChildren()
  for (const segment of items) {
    const row = document.createElement('tr')
    row.innerHTML = `<td>${formatTime(segment.capturedAt)}</td><td>${formatDuration(segment.durationMs)}</td><td class="recognition"></td><td>${escapeHtml(segment.callsign ?? '')}</td><td></td><td></td>`
    row.querySelector('.recognition').textContent = segment.recognition
    const manual = document.createElement('input')
    manual.value = segment.manualCallsign ?? ''
    manual.placeholder = '留空则使用 AI 呼号'
    manual.addEventListener('change', () => saveCallsign(segment.id, manual))
    row.children[4].append(manual)
    const play = document.createElement('audio')
    play.controls = true
    play.preload = 'none'
    play.src = `/api/admin/segments/${encodeURIComponent(segment.id)}/audio`
    row.children[5].append(play)
    body.append(row)
  }
}

async function saveCallsign(id, input) {
  const callsign = input.value.trim().toUpperCase()
  const response = await fetch(`/api/admin/segments/${encodeURIComponent(id)}/manual-callsign`, {
    body: JSON.stringify({ callsign: callsign || null }),
    headers: { 'content-type': 'application/json' },
    method: 'PATCH',
  })
  if (!response.ok) {
    status.textContent = '保存失败：呼号必须是规范呼号或 N0CALL'
    await load()
    return
  }
  input.value = callsign
  status.textContent = '已保存'
}

function formatTime(iso) {
  const date = new Date(iso)
  const formatter = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    second: '2-digit',
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
  })
  const values = Object.fromEntries(
    formatter.formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]),
  )
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`
}

function formatDuration(ms) {
  return `${(ms / 1000).toFixed(1)}s`
}

function escapeHtml(text) {
  const element = document.createElement('span')
  element.textContent = text
  return element.innerHTML
}

void load()
