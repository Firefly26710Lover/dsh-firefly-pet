/**
 * dsh-firefly-pet 渲染端（nodeIntegration 打开，本地版够用）
 *
 * 职责：双层宠物（待机常驻 + 动作淡入淡出）、点击开聊天、流式打字、气泡自动收起、
 * 右键菜单、拖动。拖动由主进程按 OS 光标逐帧 setPosition，所以不用 CSS app-region。
 */
const { ipcRenderer } = require('electron')

const stage = document.getElementById('stage')
const img = document.getElementById('pet')
const actionImg = document.getElementById('pet-action')
const bubble = document.getElementById('bubble')
const bubbleTag = document.getElementById('bubble-tag')
const composer = document.getElementById('composer')
const input = document.getElementById('text')
const sendBtn = document.getElementById('send')

const params = new URLSearchParams(location.search)
const size = Number(params.get('size')) || 220

stage.style.width = `${size}px`
stage.style.height = `${size}px`

// ---------------- 待机层 / 动作层 ----------------

let playingTimer = null
let playing = false

/** 打断正在播的动作，直接回到待机层。 */
function cancelAction() {
  if (playingTimer) {
    clearTimeout(playingTimer)
    playingTimer = null
  }
  playing = false
  actionImg.classList.remove('on')
  img.classList.remove('away')
}

function showGif(src) {
  if (!src) return
  img.src = src
  cancelAction()
}

/**
 * 单击动作：先解码再淡入，避免第一帧闪一下空白；
 * 播完一轮后淡出，待机层一直在下面，所以回切也是渐隐而不是硬切。
 */
async function playOnce(src, duration) {
  if (!src || playing) return
  playing = true
  try {
    const probe = new Image()
    probe.src = src
    if (typeof probe.decode === 'function') await probe.decode().catch(() => {})
  } catch {
    /* 解码失败就直接塞，反正下面还有待机层 */
  }
  actionImg.src = src
  requestAnimationFrame(() => {
    actionImg.classList.add('on')
    img.classList.add('away')
  })
  playingTimer = setTimeout(() => {
    actionImg.classList.remove('on')
    img.classList.remove('away')
    playingTimer = setTimeout(() => {
      playing = false
      playingTimer = null
    }, 240)
  }, Math.max(600, Number(duration) || 3000))
}

showGif(params.get('gif'))
ipcRenderer.on('firefly:set-gif', (_event, src) => showGif(src))
ipcRenderer.on('firefly:play', (_event, payload) => playOnce(payload?.src, payload?.duration))

// ---------------- 点击穿透 ----------------

let interactive = false
let chatOpen = false

function setInteractive(next) {
  if (next === interactive) return
  interactive = next
  ipcRenderer.send('firefly:interactive', next)
}

function overPet(event) {
  const rect = img.getBoundingClientRect()
  return (
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom
  )
}

function overBubble(event) {
  if (!bubble.classList.contains('show')) return false
  const rect = bubble.getBoundingClientRect()
  return (
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom
  )
}

window.addEventListener('mousemove', (event) => {
  setInteractive(chatOpen || overPet(event) || overBubble(event))
})

window.addEventListener('mouseleave', () => {
  if (!chatOpen) setInteractive(false)
  scheduleHide(8000)
})

// ---------------- 气泡与聊天 ----------------

let pending = false
let hideTimer = null
let settleTimer = null

function clearTimers() {
  if (hideTimer) clearTimeout(hideTimer)
  if (settleTimer) clearTimeout(settleTimer)
  hideTimer = null
  settleTimer = null
}

/** 会话标签：告诉用户这条播报来自哪个对话框；null 表示不显示。 */
function setTag(text) {
  if (text) {
    bubbleTag.textContent = text
    bubbleTag.classList.add('show')
  } else {
    bubbleTag.classList.remove('show')
  }
}

function hideBubble() {
  bubble.classList.remove('show')
  bubbleTag.classList.remove('show')
}

function showBubble(text, isError = false) {
  clearTimers()
  setTag(null)
  bubble.textContent = text
  bubble.classList.toggle('err', isError)
  bubble.classList.add('show')
  bubble.scrollTop = bubble.scrollHeight
}

/** 回复结束后的收尾：5s 没动静收输入条，再过 delay 收气泡。 */
function scheduleSettle(delay = 20000) {
  clearTimers()
  settleTimer = setTimeout(() => {
    settleTimer = null
    if (pending) return
    hideComposer()
    scheduleHide(delay)
  }, 5000)
}

function scheduleHide(delay = 20000) {
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    hideTimer = null
    if (pending || chatOpen) return
    hideBubble()
  }, delay)
}

function showComposer() {
  clearTimers()
  chatOpen = true
  composer.classList.add('show')
  setInteractive(true)
  ipcRenderer.send('firefly:focus')
  setTimeout(() => input.focus(), 60)
}

function hideComposer() {
  chatOpen = false
  composer.classList.remove('show')
  input.blur()
  setInteractive(false)
}

function openChat() {
  showComposer()
}

function closeChat() {
  hideComposer()
  scheduleHide(1500)
}

function sendMessage() {
  const text = input.value.trim()
  if (!text || pending) return
  input.value = ''
  pending = true
  sendBtn.disabled = true
  showBubble('…')
  ipcRenderer.send('firefly:chat', { text })
}

ipcRenderer.on('firefly:open-chat', openChat)
ipcRenderer.on('firefly:clicked', () => (chatOpen ? input.focus() : openChat()))

// 任务进度播报：不抢焦点、不打断对话，7 秒自动收
ipcRenderer.on('firefly:notify', (_event, message) => {
  if (pending || chatOpen) return
  clearTimers()
  bubble.classList.remove('err')
  setTag(message.tag ?? null)
  bubble.textContent = message.text ?? ''
  bubble.classList.add('show')
  hideTimer = setTimeout(() => {
    hideTimer = null
    if (!pending && !chatOpen) hideBubble()
  }, Number(message.duration) || 7000)
})

ipcRenderer.on('firefly:update', (_event, message) => {
  clearTimers() // 说的时候别收
  bubble.classList.add('show')
  bubble.classList.remove('err')
  setTag(message.tag ?? null)
  bubble.textContent = message.text ?? ''
  bubble.scrollTop = bubble.scrollHeight
})

ipcRenderer.on('firefly:done', () => {
  pending = false
  sendBtn.disabled = false
  scheduleSettle()
})

ipcRenderer.on('firefly:error', (_event, message) => {
  pending = false
  sendBtn.disabled = false
  showBubble(`（${message?.message || '出错了'}）`, true)
  scheduleSettle(30000)
})

composer.addEventListener('submit', (event) => {
  event.preventDefault()
  sendMessage()
})

// 用户开始打字就取消收尾计时，别在输入时把框抽走
input.addEventListener('input', clearTimers)
input.addEventListener('focus', clearTimers)

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeChat()
})

// ---------------- 拖动与菜单 ----------------

let dragging = false

img.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return // 右键留给菜单
  event.preventDefault()
  try {
    img.setPointerCapture(event.pointerId)
  } catch {
    /* 拿不到捕获也不影响，位置由主进程轮询 */
  }
  dragging = true
  img.classList.add('dragging')
  ipcRenderer.send('firefly:drag-start')
})

function endDrag() {
  if (!dragging) return
  dragging = false
  img.classList.remove('dragging')
  ipcRenderer.send('firefly:drag-end')
}

img.addEventListener('pointerup', endDrag)
img.addEventListener('pointercancel', endDrag)

img.addEventListener('dblclick', () => openChat())

img.addEventListener('contextmenu', (event) => {
  event.preventDefault()
  ipcRenderer.send('firefly:menu')
})

img.addEventListener('error', () => {
  console.error('[firefly] GIF 加载失败：', img.src)
})