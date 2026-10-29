/**
 * dsh-firefly-pet —— 桌面 helper（Electron 主进程，CommonJS）
 *
 * 透明、置顶、无边框的小窗口：显示 GIF、拖动、右键菜单、聊天气泡。
 * 与宿主的通道是 stdin/stdout 的 JSON 行协议（stdout 只走协议，日志走 stderr + 文件）：
 *   发出去：{"type":"chat","id":1,"text":"..."}
 *   收进来：{"type":"chunk","id":1,"text":"..."} / {"type":"done","id":1} / {"type":"error","id":1,"message":"..."}
 */
const { app, BrowserWindow, ipcMain, Menu, screen } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

// 显式命名：否则 Electron 会把 userData 落到 %APPDATA%\Electron，和别的脚本混在一起
app.setName('dsh-firefly-pet-helper')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

const DSH_HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh')
const STATE_DIR = path.join(DSH_HOME, 'dsh-firefly-pet')
const LOG_FILE = path.join(STATE_DIR, 'helper.log')

/** 日志：stdout 是 JSON 协议通道，不能混日志，所以落文件 + stderr。 */
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.appendFileSync(LOG_FILE, line, 'utf8')
  } catch {
    /* 盘写不了就算了 */
  }
  try {
    process.stderr.write(line)
  } catch {
    /* 管道断了 */
  }
}

const CONFIG = (() => {
  try {
    return JSON.parse(process.env.FIREFLY_CONFIG || '{}')
  } catch (error) {
    log(`配置 JSON 解析失败：${error?.message ?? error}`)
    return {}
  }
})()

const SIZE = Number(CONFIG.size) || 220
const MARGIN_X = Number(CONFIG.marginX) || 24
const MARGIN_Y = Number(CONFIG.marginY) || 16
/** 宠物上方的气泡/输入框预留 */
const PADDING = 190
const PACKAGE_ROOT = path.join(__dirname, '..', '..')
const GIF_DIR = CONFIG.gifDir || path.join(PACKAGE_ROOT, 'assets', 'gifs')

let mainWindow = null
let chatSeq = 0

// ---------- 与宿主的 JSON 行桥 ----------

const toHost = (payload) => {
  try {
    process.stdout.write(`${JSON.stringify(payload)}\n`)
  } catch {
    /* 管道断了 */
  }
}

/** 宿主 → helper 的一条消息（notify / update / done / error）；stdin 与 HTTP 两个入口共用。 */
function handleFromHost(message) {
  if (message?.type === 'notify') {
    mainWindow?.webContents.send('firefly:notify', message)
    log(`播报：${message.text}`)
    return
  }
  if (message?.type === 'update') {
    mainWindow?.webContents.send('firefly:update', message)
  } else if (message?.type === 'done') {
    mainWindow?.webContents.send('firefly:done', message)
  } else if (message?.type === 'error') {
    mainWindow?.webContents.send('firefly:error', message)
  }
}

// 入口 1：stdin（兜底；Electron 生 Electron 时这条管道不一定通）
process.stdin.setEncoding('utf8')
process.stdin.resume()
let stdinBuffer = ''
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk
  let index = stdinBuffer.indexOf('\n')
  while (index >= 0) {
    const line = stdinBuffer.slice(0, index).trim()
    stdinBuffer = stdinBuffer.slice(index + 1)
    if (line) {
      try {
        handleFromHost(JSON.parse(line))
      } catch {
        /* 非 JSON 行忽略 */
      }
    }
    index = stdinBuffer.indexOf('\n')
  }
})

// 入口 2：主通道 —— 127.0.0.1 上的小 HTTP 服务，端口通过 stdout 上报宿主
const http = require('node:http')
const receiver = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/msg') {
    res.writeHead(404)
    res.end()
    return
  }
  let body = ''
  req.setEncoding('utf8')
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', () => {
    res.writeHead(204)
    res.end()
    try {
      handleFromHost(JSON.parse(body))
    } catch {
      /* 忽略坏包 */
    }
  })
})
receiver.listen(0, '127.0.0.1', () => {
  const port = receiver.address().port
  toHost({ type: 'ready', port })
  log(`宿主通道就绪 127.0.0.1:${port}`)
})

// ---------- 窗口 ----------

function listGifs() {
  try {
    return fs
      .readdirSync(GIF_DIR)
      .filter((file) => /\.gif$/i.test(file))
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  } catch (error) {
    log(`素材目录读不了：${GIF_DIR} (${error?.message ?? error})`)
    return []
  }
}

/** 放在光标所在那块屏的右下角（多屏机器上比 primary 靠谱）。 */
function defaultPosition(width, height) {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const { workArea } = display
  return [
    Math.round(workArea.x + workArea.width - width - MARGIN_X),
    Math.round(workArea.y + workArea.height - height - MARGIN_Y)
  ]
}

const IDLE_FILE = path.join(STATE_DIR, 'idle-gifs.json')

/** 待机白名单：每次右键现读，改文件即生效；没配置就退化为"全部"。 */
function readJsonArray(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    return Array.isArray(parsed) ? parsed : Array.isArray(parsed?.gifs) ? parsed.gifs : []
  } catch {
    return []
  }
}

/** 用户配置优先；没有就用包内默认清单（新装用户开箱即用）。 */
function poolEntries(userFile, defaultFile) {
  const user = readJsonArray(userFile)
  return user.length > 0 ? user : readJsonArray(defaultFile)
}

/** 只返回适合待机的 GIF；名单里的名字允许不带扩展名，按包含关系兜底匹配。 */
function idleGifs() {
  const all = listGifs()
  const wanted = poolEntries(IDLE_FILE, path.join(PACKAGE_ROOT, 'assets', 'idle-gifs.json'))
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim())
  if (wanted.length === 0) return all
  const picked = []
  for (const name of wanted) {
    const exact = all.find((file) => file === name || file.toLowerCase() === name.toLowerCase())
    const loose = exact ?? all.find((file) => file.includes(name.replace(/\.gif$/i, '')))
    if (loose && !picked.includes(loose)) picked.push(loose)
  }
  return picked
}

const CLICK_FILE = path.join(STATE_DIR, 'click-gifs.json')

/**
 * 动作池：单击时临时播的活泼 GIF。
 * 条目可以是文件名，也可以是 { file, ms }：ms 用于把短动作补长（原速循环，播到 ms 为止）。
 */
function clickGifs() {
  const list = poolEntries(CLICK_FILE, path.join(PACKAGE_ROOT, 'assets', 'click-gifs.json'))
  const out = []
  for (const item of list) {
    const name = typeof item === 'string' ? item : typeof item?.file === 'string' ? item.file : ''
    if (!name.trim()) continue
    const file = path.join(GIF_DIR, name.trim())
    if (!fs.existsSync(file)) continue
    const ms = item && typeof item === 'object' && Number.isFinite(Number(item.ms)) ? Number(item.ms) : null
    out.push({ file, ms })
  }
  return out
}

/** 读 GIF 的帧延时总和 = 播完一轮要多久；解析失败就给 3 秒兜底。 */
function gifDurationMs(filePath) {
  try {
    const buf = fs.readFileSync(filePath)
    if (buf.length < 13 || buf.toString('ascii', 0, 3) !== 'GIF') return 3000
    const skipSubBlocks = (start) => {
      let p = start
      while (p < buf.length) {
        const size = buf[p]
        p += 1
        if (size === 0) break
        p += size
      }
      return p
    }
    let pos = 13
    const screenFlags = buf[10]
    if (screenFlags & 0x80) pos += 3 * (1 << ((screenFlags & 0x07) + 1))
    let total = 0
    while (pos < buf.length) {
      const marker = buf[pos]
      pos += 1
      if (marker === 0x3b) break
      if (marker === 0x21) {
        const label = buf[pos]
        pos += 1
        if (label === 0xf9) {
          const size = buf[pos]
          const delay = buf.readUInt16LE(pos + 2) * 10
          total += delay > 0 ? delay : 100
          pos += 1 + size
          pos = skipSubBlocks(pos)
        } else {
          pos = skipSubBlocks(pos)
        }
      } else if (marker === 0x2c) {
        const localFlags = buf[pos + 8]
        pos += 9
        if (localFlags & 0x80) pos += 3 * (1 << ((localFlags & 0x07) + 1))
        pos += 1
        pos = skipSubBlocks(pos)
      } else {
        break
      }
    }
    return Math.min(8000, Math.max(800, total || 3000))
  } catch {
    return 3000
  }
}

/** 单击宠物：从动作池随机抽一张，播一轮；池子空就返回 false 让调用方去开聊天。 */
function playClickAnimation(picked) {
  const pool = clickGifs()
  if (pool.length === 0 || !mainWindow) return false
  const entry = picked ?? pool[Math.floor(Math.random() * pool.length)]
  const duration = entry.ms ?? gifDurationMs(entry.file)
  log(`单击动作：${path.basename(entry.file)}（${duration}ms${entry.ms ? '，按配置' : ''}）`)
  mainWindow.webContents.send('firefly:play', { src: entry.file, duration })
  return true
}

const POSITION_FILE = path.join(STATE_DIR, 'position.json')

/** 上次拖到哪就回哪；坐标已经不在任何屏幕上（改过分辨率）就退回默认角落。 */
function loadPosition(width, height) {
  try {
    const saved = JSON.parse(fs.readFileSync(POSITION_FILE, 'utf8'))
    const x = Number(saved.x)
    const y = Number(saved.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return defaultPosition(width, height)
    const visible = screen.getAllDisplays().some(({ workArea }) => (
      x + width > workArea.x &&
      y + height > workArea.y &&
      x < workArea.x + workArea.width &&
      y < workArea.y + workArea.height
    ))
    return visible ? [Math.round(x), Math.round(y)] : defaultPosition(width, height)
  } catch {
    return defaultPosition(width, height)
  }
}

function savePosition() {
  if (!mainWindow) return
  try {
    const [x, y] = mainWindow.getPosition()
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(POSITION_FILE, JSON.stringify({ x, y }), 'utf8')
  } catch (error) {
    log(`位置保存失败：${error?.message ?? error}`)
  }
}
function createWindow() {
  const width = SIZE + PADDING
  const height = SIZE + PADDING
  const [x, y] = loadPosition(width, height)

  mainWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    title: 'dsh-firefly-pet',
    webPreferences: {
      // 关键：Electron 20+ 默认 sandbox: true，sandbox 里 nodeIntegration 是无效的，
      // 渲染端的 require('electron') 会直接抛错 —— 表现就是窗口全透明、GIF 不出现。
      sandbox: false,
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false
    }
  })

  // screen-saver 级别：盖在普通窗口上面，但不像全屏窗那样抢焦点
  mainWindow.setAlwaysOnTop(true, 'screen-saver')
  mainWindow.setMenuBarVisibility(false)
  // 默认整窗点击穿透：只有光标压在宠物/气泡上时才由渲染端翻成可交互
  mainWindow.setIgnoreMouseEvents(true, { forward: true })

  const initialGif = CONFIG.gif || idleGifs()[0] || ''
  const gifPath = initialGif ? path.join(GIF_DIR, initialGif) : ''
  log(`窗口 ${width}x${height} @ (${x},${y})，GIF=${gifPath}，存在=${fs.existsSync(gifPath)}，待机清单 ${idleGifs().length} 项，动作池 ${clickGifs().length} 项`)

  mainWindow.webContents.on('console-message', (_event, level, message) => {
    log(`renderer[${level}] ${message}`)
  })
  mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
    log(`did-fail-load ${code} ${description}`)
  })

  mainWindow.loadFile(path.join(__dirname, 'pet.html'), {
    query: { gif: gifPath, size: String(SIZE) }
  })


  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// ---------- 菜单与交互 ----------

function buildMenu() {
  const gifs = idleGifs()
  return Menu.buildFromTemplate([
    { label: '聊天', click: () => mainWindow?.webContents.send('firefly:open-chat') },
    { label: '说句话', click: () => toHost({ type: 'whisper' }) },
    { label: '看余额', click: () => toHost({ type: 'balance' }) },
    {
      label: '换一只',
      enabled: gifs.length > 0,
      submenu: gifs.map((file) => ({
        // 菜单里只显示「狐狸躺」这种名字，去掉「流萤_」前缀和扩展名
        label: file.replace(/\.gif$/i, '').replace(/^流萤_/, ''),
        click: () => mainWindow?.webContents.send('firefly:set-gif', path.join(GIF_DIR, file))
      }))
    },
    {
      label: '动作',
      enabled: clickGifs().length > 0,
      submenu: [
        { label: '随机一个', click: () => playClickAnimation() },
        { type: 'separator' },
        ...clickGifs().map((entry) => {
          const base = path.basename(entry.file, path.extname(entry.file)).replace(/^流萤_/, '')
          const secs = Math.round((entry.ms ?? gifDurationMs(entry.file)) / 1000)
          return {
            label: base.includes(secs + 's') ? base : base + ' · ' + secs + 's',
            click: () => playClickAnimation(entry)
          }
        })
      ]
    },
    { type: 'separator' },
    {
      label: '回到右下角',
      click: () => {
        if (!mainWindow) return
        const [nx, ny] = defaultPosition(SIZE + PADDING, SIZE + PADDING)
        mainWindow.setPosition(nx, ny)
        savePosition()
      }
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ])
}

/**
 * 拖动：不用 -webkit-app-region: drag（它会吞掉右键和点击事件），
 * 改成主进程按 OS 光标位置逐帧 setPosition —— 光标移出窗口也不会断。
 */
let dragState = null

ipcMain.on('firefly:drag-start', () => {
  if (!mainWindow || dragState) return
  const start = {
    cursor: screen.getCursorScreenPoint(),
    origin: mainWindow.getPosition(),
    timer: null
  }
  start.timer = setInterval(() => {
    if (!dragState || !mainWindow) return
    const point = screen.getCursorScreenPoint()
    mainWindow.setPosition(
      start.origin[0] + (point.x - start.cursor.x),
      start.origin[1] + (point.y - start.cursor.y)
    )
  }, 16)
  dragState = start
})

ipcMain.on('firefly:drag-end', () => {
  if (!dragState) return
  clearInterval(dragState.timer)
  const origin = dragState.origin
  dragState = null
  savePosition()
  if (!mainWindow) return
  // 位移不到 4px 当作"点了一下"：有动作池就播一轮动画，否则交给渲染端开聊天
  const [x, y] = mainWindow.getPosition()
  if (Math.abs(x - origin[0]) + Math.abs(y - origin[1]) <= 4) {
    if (!playClickAnimation()) mainWindow.webContents.send('firefly:clicked')
  }
})

/** 渲染端按"光标是否压在宠物/气泡上"翻这个开关；穿透状态下靠 forward 拿到 mousemove。 */
ipcMain.on('firefly:interactive', (_event, interactive) => {
  mainWindow?.setIgnoreMouseEvents(interactive !== true, { forward: true })
})

ipcMain.on('firefly:menu', () => {
  buildMenu().popup({ window: mainWindow })
})

ipcMain.on('firefly:focus', () => {
  if (!mainWindow) return
  mainWindow.setAlwaysOnTop(true, 'screen-saver')
  mainWindow.show()
  mainWindow.focus()
})

ipcMain.on('firefly:quit', () => app.quit())

/** 渲染端发出去的一句话：转给宿主，宿主走 ctx.llm.stream 回吐。 */
ipcMain.on('firefly:chat', (_event, payload) => {
  const text = String(payload?.text ?? '').trim()
  if (!text) return
  const id = ++chatSeq
  toHost({ type: 'chat', id, text })
})

/** 宿主没了就自己退，避免留下孤儿窗口。 */
const HOST_PID = Number(process.env.FIREFLY_HOST_PID)
if (HOST_PID > 0) {
  setInterval(() => {
    try {
      process.kill(HOST_PID, 0)
    } catch {
      app.exit(0)
    }
  }, 5000).unref?.()
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => app.quit())

process.on('uncaughtException', (error) => {
  log(`uncaught: ${error?.stack ?? error}`)
})
