/**
 * dsh-firefly-pet —— Little Firefly 的 DSH 本地插件（宿主半侧）
 *
 * 两条职责：
 *   1. 拉起桌面 helper（透明置顶窗），宿主退出时收尸；
 *   2. 收 helper 的对话请求，走 DSH 自己的 ctx.llm.stream 生成回复，
 *      按块回吐（stdin/stdout 的 JSON 行协议），不需要任何 API Key。
 *
 * 协议（逐行 JSON）：
 *   helper → host: {"type":"chat","id":1,"text":"..."} / {"type":"log","text":"..."}
 *   host → helper: {"type":"chunk"|"done"|"error","id":1,...}
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-firefly-pet'
/** 必须声明才能读 ctx.llm / ctx.agentDefaultModel；这两个是宿主必有的服务。 */
export const inject = ['llm', 'agentDefaultModel']

const HERE = dirname(fileURLToPath(import.meta.url))
const HELPER_MAIN = join(HERE, '..', 'runtime', 'helper', 'main.cjs')
const CALL_IDENTITY = 'dsh-firefly-pet'
const HISTORY_ROUNDS = 8
const MEMORY_CAP = 40

const DEFAULT_CONFIG = {
  gifDir: join(HERE, '..', 'assets', 'gifs'),
  gif: '流萤_狐狸_躺.gif',
  size: 220,
  marginX: 24,
  marginY: 16,
  /** 人设原文（35 KB 左右），null 表示不加载 */
  roleplayPath: join(HERE, '..', 'assets', 'roleplay.md'),
  /** 塞进 system 的人设上限，防止一轮请求太贵 */
  roleplayMaxChars: 20000,
  /** 碎碎念：定时自己说一句（默认开，5 分钟一次） */
  whisperEnabled: true,
  whisperIntervalSec: 300,
  /** true = 用模型把预置台词润色成流萤的口吻；false = 直接说原句（0 成本） */
  whisperPolish: true,
  /** 碎碎念气泡停留时长 */
  whisperBubbleMs: 9000,
  /** 留空 = 跟随 DSH 当前会话的默认模型 */
  chatModel: { provider: '', model: '' }
}

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function stateDir() {
  return join(dshHome(), 'dsh-firefly-pet')
}

/** 宿主侧文件日志：ctx.logger 落在应用控制台里看不到，本地排查只能自己落盘。 */
function hostLog(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`
  try {
    mkdirSync(stateDir(), { recursive: true })
    writeFileSync(join(stateDir(), 'host.log'), line, { encoding: 'utf8', flag: 'a' })
  } catch {
    /* 写不进去就算了 */
  }
}

function readUserConfig(logger) {
  const file = join(stateDir(), 'config.json')
  if (!existsSync(file)) return { ...DEFAULT_CONFIG }
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(file, 'utf8')) }
  } catch (error) {
    logger?.warn?.(`[firefly] 配置解析失败，使用默认值：${file} (${error?.message ?? error})`)
    return { ...DEFAULT_CONFIG }
  }
}

/** 找 Electron：环境变量 → DSH 共享运行时（dsh-pet 也落在这一份）→ 放弃。 */
function resolveElectron() {
  const override = process.env.FIREFLY_ELECTRON_PATH
  if (override && existsSync(override)) return override
  const base = join(dshHome(), 'electron')
  const candidates = process.platform === 'win32'
    ? [join(base, 'electron.exe')]
    : process.platform === 'darwin'
      ? [join(base, 'Electron.app', 'Contents', 'MacOS', 'Electron')]
      : [join(base, 'electron')]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return null
}

/** 子进程必须清掉 ELECTRON_RUN_AS_NODE，否则 Electron 会以纯 Node 模式起来。 */
function helperEnv(config) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  env.FIREFLY_HOST_PID = String(process.pid)
  env.FIREFLY_CONFIG = JSON.stringify(config)
  return env
}

/** 人设：一段硬约束 + 原文；原文过长时截断，避免每轮都烧掉两万 token。 */
function readRoleplay(config, logger) {
  const path = config.roleplayPath
  if (!path || !existsSync(path)) {
    logger?.warn?.(`[firefly] 找不到人设文件：${path}，对话只用人设摘要`)
    return ''
  }
  try {
    const raw = readFileSync(path, 'utf8')
    const max = Number(config.roleplayMaxChars) || 20000
    return raw.length > max ? `${raw.slice(0, max)}\n\n（设定后文过长，已截断）` : raw
  } catch (error) {
    logger?.warn?.(`[firefly] 人设读取失败：${error?.message ?? error}`)
    return ''
  }
}

function systemPrompt(roleplay) {
  const now = new Date()
  const stamp = now.toLocaleString('zh-CN', { hour12: false })
  const week = '日一二三四五六'[now.getDay()]
  const head = [
    '你现在是《崩坏：星穹铁道》里的流萤，作为桌宠住在开拓者（用户）的电脑桌面上。',
    '说话规则：',
    '- 用第一人称，1~3 句，口语化，符合下面的人设与语言习惯；',
    '- 不要使用 Markdown、列表、标题，不要用括号写动作描写；',
    '- 不要说自己是 AI、模型或程序，也不要跳出角色；',
    `- 当前时间：${stamp}（周${week}）。`
  ].join('\n')
  return roleplay ? `${head}\n\n==== 完整角色设定 ====\n${roleplay}` : head
}

function loadMemory() {
  const file = join(stateDir(), 'memory.json')
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed?.messages) ? parsed.messages : []
  } catch {
    return []
  }
}

function saveMemory(messages) {
  try {
    mkdirSync(stateDir(), { recursive: true })
    writeFileSync(join(stateDir(), 'memory.json'), JSON.stringify({ messages }, null, 2), 'utf8')
  } catch {
    /* 记忆写不进去不影响说话 */
  }
}

function textOf(assembler) {
  try {
    return assembler
      .blocks()
      .filter((block) => block && block.type === 'text')
      .map((block) => block.text ?? '')
      .join('')
  } catch {
    return ''
  }
}

/** @deepseek-ai/dsh-llm 由宿主注入解析；拿不到就让对话优雅失败，宠物照常显示。 */
async function loadLlmApi() {
  try {
    return await import('@deepseek-ai/dsh-llm')
  } catch (error) {
    hostLog(`import @deepseek-ai/dsh-llm 失败：${error?.code ?? ''} ${error?.message ?? error}`)
    return null
  }
}

function resolveModel(ctx, config) {
  const conf = config.chatModel
  if (conf && typeof conf.provider === 'string' && conf.provider.trim() && typeof conf.model === 'string' && conf.model.trim()) {
    return { provider: conf.provider.trim(), model: conf.model.trim() }
  }
  try {
    const selection = ctx.agentDefaultModel?.currentSelection?.()
    if (selection?.provider && selection?.model) {
      return { provider: selection.provider, model: selection.model }
    }
  } catch {
    /* 没有默认模型服务就落空 */
  }
  return null
}

export function apply(ctx) {
  const logger = ctx.logger ?? console
  const config = readUserConfig(logger)
  const electron = resolveElectron()
  if (electron === null) {
    logger.error?.('[firefly] 找不到 Electron：设置 FIREFLY_ELECTRON_PATH，或先让 dsh-pet 落一份到 ~/.dsh/electron')
    return
  }

  const roleplay = readRoleplay(config, logger)
  logger.info?.(`[firefly] 启动 helper：${electron}（人设 ${roleplay.length} 字）`)
  hostLog(`apply：electron=${electron} 人设=${roleplay.length} 字 pid=${process.pid}`)

  const child = spawn(electron, [HELPER_MAIN], {
    env: helperEnv(config),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  hostLog(`helper 拉起 pid=${child.pid}`)

  let stdoutBuffer = ''
  let busy = false
  const history = loadMemory()

  // ---- 宿主 → helper 的回吐通道：helper 上报端口后走 127.0.0.1 HTTP ----
  let helperPort = null
  const outbox = []

  function deliver(payload) {
    if (helperPort === null) {
      outbox.push(payload)
      return
    }
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    const req = httpRequest({
      host: '127.0.0.1',
      port: helperPort,
      path: '/msg',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': body.length }
    }, (res) => res.resume())
    req.on('error', (error) => hostLog(`HTTP 投递失败：${error?.message ?? error}`))
    req.end(body)
  }

  const toHelper = (payload) => deliver(payload)

  // ---------- 任务进度播报（session/event → 气泡） ----------
  const turnTools = []
  let activeSession = null
  let lastNotifyAt = 0
  let lastTone = null
  const NOTIFY_GAP_MS = 6000
  const sessionLabels = new Map()
  let currentTag = null

  /** 会话标签：优先取会话缓存里的标题，退化为工作目录名，再退化到 id 尾号。 */
  function sessionLabel(session) {
    const id = String(session?.header?.id ?? '')
    if (!id) return null
    const hit = sessionLabels.get(id)
    if (hit && Date.now() - hit.at < 60000) return hit.label
    let label = ''
    try {
      const file = join(dshHome(), 'storages', 'session_projcache', 'sessions', id + '.json')
      const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
      label = String(parsed?.record?.rows?.title?.val ?? '').trim()
    } catch {
      /* 没有会话缓存就算了 */
    }
    if (!label) {
      const cwd = String(session?.header?.cwd ?? '')
      const parts = cwd.split(/[\\\\/]/).filter(Boolean)
      label = parts.length > 0 ? parts[parts.length - 1] : id.slice(-6)
    }
    label = Array.from(label).slice(0, 12).join('')
    sessionLabels.set(id, { label, at: Date.now() })
    return label || null
  }

  const pickOne = (list) => list[Math.floor(Math.random() * list.length)]

  function notify(text, tone, force = false, duration = 0) {
    if (!text) return
    const now = Date.now()
    if (!force && now - lastNotifyAt < NOTIFY_GAP_MS) return
    if (!force && tone === lastTone && now - lastNotifyAt < 20000) return
    lastNotifyAt = now
    lastTone = tone
    hostLog(`播报[${tone}] ${text}`)
    toHelper({ type: 'notify', text, tone, tag: (tone === 'whisper' || tone === 'balance') ? null : currentTag, duration })
  }

  function toolPhrase(name) {
    const n = String(name ?? '').toLowerCase()
    if (/todo/.test(n)) return null
    if (/read|grep|glob/.test(n)) return pickOne(['在翻文件呢…', '找一下在哪儿…'])
    if (/write|edit|apply|patch/.test(n)) return pickOne(['在改东西，稍等～', '马上就好…'])
    if (/pwsh|bash|shell|terminal|exec/.test(n)) return pickOne(['跑个命令看看…', '在执行，稍等～'])
    if (/web_search|web_fetch|fetch|http/.test(n)) return pickOne(['上网查一下～'])
    return pickOne(['在忙呢…'])
  }

  /** 一轮结束后用模型润色一句；失败就退回预置。 */
  async function polishedNotify() {
    const fallback = () => notify(pickOne(['搞定啦～', '做完咯。', '这一轮结束了哦。']), 'done', true)
    try {
      const api = await loadLlmApi()
      const llm = ctx.llm
      const model = resolveModel(ctx, config)
      if (!api || !llm || typeof llm.stream !== 'function' || !model) {
        fallback()
        return
      }
      const did = turnTools.length > 0 ? turnTools.join('、') : '陪开拓者聊了几句'
      const messages = [api.createUserMessage({
        content: [{ type: 'text', text: `这一轮你做的事：${did}。用一句话（20 字以内）向开拓者播报完成情况，不要解释、不要 Markdown。` }],
        source: { kind: 'user' }
      })]
      const assembler = new api.BlockAssembler()
      const options = {
        provider: model.provider,
        model: model.model,
        sessionId: CALL_IDENTITY,
        messages,
        system: '你是《崩坏：星穹铁道》里的流萤，现在是开拓者桌面上的桌宠。说话简短、口语化、不用 Markdown、不解释自己。',
        temperature: 0.9,
        signal: AbortSignal.timeout(15000)
      }
      for await (const chunk of llm.stream(options)) assembler.push(chunk)
      const text = textOf(assembler).trim()
      if (text) notify(text, 'done', true)
      else fallback()
    } catch (error) {
      hostLog(`润色失败：${error?.message ?? error}`)
      fallback()
    }
  }

  // ---------- 碎碎念（定时自说自话） ----------
  let whisperLines = []
  try {
    const file = join(HERE, '..', 'assets', 'whisper-lines.json')
    const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    if (Array.isArray(parsed)) whisperLines = parsed.filter((line) => typeof line === 'string' && line.trim())
  } catch (error) {
    hostLog('台词库读取失败：' + (error?.message ?? error))
  }
  let whisperBag = []
  let lastChatAt = 0

  /** 洗牌袋：一轮之内不重复，抽完再重洗。 */
  function nextWhisperLine() {
    if (whisperLines.length === 0) return null
    if (whisperBag.length === 0) whisperBag = [...whisperLines].sort(() => Math.random() - 0.5)
    return whisperBag.pop() ?? null
  }

  /** 把预置台词润色成流萤的口吻（带当前时间，早晚语气不同）。 */
  async function polishLine(raw) {
    const api = await loadLlmApi()
    const llm = ctx.llm
    const model = resolveModel(ctx, config)
    if (!api || !llm || typeof llm.stream !== 'function' || !model) return raw
    const now = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
    const messages = [api.createUserMessage({
      content: [{ type: 'text', text: '[旁白指令，不计入对话] 当前时间是 ' + now + '。你正在主动找开拓者搭话。请以下面这句话为灵感，用流萤的语气说一句完整自然的话，可以结合时间调整语气：「' + raw + '」。只输出这句话。' }],
      source: { kind: 'user' }
    })]
    const assembler = new api.BlockAssembler()
    const options = {
      provider: model.provider,
      model: model.model,
      sessionId: CALL_IDENTITY,
      messages,
      system: '你是《崩坏：星穹铁道》里的流萤，现在是开拓者桌面上的桌宠。说话简短、口语化、不用 Markdown、不解释自己。',
      temperature: 0.95,
      signal: AbortSignal.timeout(20000)
    }
    for await (const chunk of llm.stream(options)) assembler.push(chunk)
    const text = textOf(assembler).trim()
    return text || raw
  }

  /** force = 右键「说句话」，绕过间隔与避让限制（但仍然躲开正在进行的对话）。 */
  async function whisperNow(force = false) {
    if (!force && config.whisperEnabled === false) return
    if (busy) return
    if (Date.now() - lastChatAt < 60000) return
    if (!force && Date.now() - lastNotifyAt < 15000) return
    const raw = nextWhisperLine()
    if (!raw) return
    let text = raw
    if (config.whisperPolish !== false) {
      try {
        text = await polishLine(raw)
      } catch (error) {
        hostLog('碎碎念润色失败：' + (error?.message ?? error))
      }
    }
    notify(text, 'whisper', true, Number(config.whisperBubbleMs) || 9000)
    hostLog('碎碎念：' + text)
  }

  const whisperIntervalMs = Math.max(60, Number(config.whisperIntervalSec) || 300) * 1000
  const whisperTimer = setInterval(() => { void whisperNow() }, whisperIntervalMs)
  ctx.effect(() => () => clearInterval(whisperTimer))
  hostLog('碎碎念：台词 ' + whisperLines.length + ' 条，间隔 ' + Math.round(whisperIntervalMs / 1000) + 's，润色=' + (config.whisperPolish !== false))
  // ---------- 余额查询 ----------
  const BALANCE_TIMEOUT_MS = 15000

  /** deepseek-account 走 DSH 账号服务；其它服务商暂时不支持（需要各家的 key 与接口）。 */
  async function queryBalance() {
    const selection = ctx.agentDefaultModel?.currentSelection?.()
    const provider = String(selection?.provider ?? '')
    if (!provider) throw new Error('没有选中的模型服务商')
    if (provider !== 'deepseek-account') throw new Error('暂时只支持 deepseek-account（当前是 ' + provider + '）')
    const account = ctx.get('deepseekAccount', false)
    if (!account || typeof account.getBalance !== 'function') throw new Error('账号服务不可用')
    const metadata = {
      version: '0.0.1',
      locale: 'zh-CN',
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60
    }
    const snapshot = await Promise.race([
      account.getBalance(metadata),
      new Promise((_, reject) => setTimeout(() => reject(new Error('查询超时')), BALANCE_TIMEOUT_MS))
    ])
    if (!snapshot || snapshot.status !== 'ready') throw new Error('账号余额查询失败')
    const wallets = Array.isArray(snapshot.value) ? snapshot.value : []
    const bonuses = Array.isArray(snapshot.bonusWallets) ? snapshot.bonusWallets : []
    if (wallets.length === 0 && bonuses.length === 0) throw new Error('账号没有钱包余额')
    const sum = (list) => list.reduce((acc, wallet) => acc + (Number(wallet?.balance) || 0), 0)
    const currency = wallets[0]?.currency ?? bonuses[0]?.currency ?? 'CNY'
    const paid = sum(wallets)
    const bonus = sum(bonuses)
    return { currency, paid, bonus, total: paid + bonus }
  }

  async function showBalance() {
    try {
      const balance = await queryBalance()
      const money = (n) => Number(n).toFixed(2)
      const symbol = ({ CNY: '¥', USD: '$' })[balance.currency] ?? (balance.currency + ' ')
      const text = '余额 ' + symbol + money(balance.total) +
        (balance.bonus > 0 ? '（充值 ' + money(balance.paid) + ' + 赠送 ' + money(balance.bonus) + '）' : '')
      notify(text, 'balance', true, 12000)
      hostLog('余额：' + text)
    } catch (error) {
      const message = error?.message ?? String(error)
      notify('查不到余额：' + message, 'error', true, 8000)
      hostLog('余额查询失败：' + message)
    }
  }
  function onSessionEvent(session, event) {
    const type = event?.type
    if (!type) return
    const sessionId = String(session?.header?.id ?? session?.id ?? 'unknown')
    currentTag = sessionLabel(session) ?? currentTag
    if (type === 'user/message') {
      activeSession = sessionId
      turnTools.length = 0
      return
    }
    if (activeSession !== null && sessionId !== activeSession) return

    if (type === 'todo/write') {
      const todos = Array.isArray(event?.data?.todos) ? event.data.todos : []
      const current = todos.find((item) => item?.status === 'in_progress') ?? todos.find((item) => item?.status === 'pending')
      const content = String(current?.content ?? '').trim()
      if (content) {
        const chars = Array.from(content)
        notify(`正在做：${chars.slice(0, 22).join('')}${chars.length > 22 ? '…' : ''}`, 'work')
      }
      return
    }
    if (type === 'turn/start') {
      turnTools.length = 0
      notify(pickOne(['唔…我想想。', '让我看看…', '嗯，交给我。']), 'think')
      return
    }
    if (type === 'tool/call') {
      const name = String(event?.data?.name ?? '')
      if (name && !/todo/i.test(name)) turnTools.push(name)
      const phrase = toolPhrase(name)
      if (phrase) notify(phrase, 'work')
      return
    }
    if (type === 'approval/asked') {
      notify('在等你确认哦～', 'wait', true)
      return
    }
    if (type === 'turn/end') {
      const reason = String(event?.data?.reason?.kind ?? '')
      hostLog('turn/end reason=' + reason + ' tools=' + turnTools.length)
      // 纯聊天（没有工具调用）不播报，避免每轮都冒一句"做完咯"
      if (reason === 'completed' || reason === 'success') {
        if (turnTools.length > 0) void polishedNotify()
      }
      else if (reason === 'error' || reason === 'max-tokens' || reason === 'timeout') notify('唔…好像出问题了。', 'error', true)
      else if (reason === 'blocked') notify('唔…卡住了，等你处理。', 'wait', true)
    }
  }
  ctx.effect(() => ctx.on('session/event', onSessionEvent))


  async function handleChat(id, text) {
    if (busy) {
      toHelper({ type: 'error', id, message: '上一句还没说完' })
      return
    }
    busy = true
    hostLog(`chat 开始 id=${id} text=${text.slice(0, 40)}`)
    try {
      const api = await loadLlmApi()
      hostLog(`dsh-llm 加载：${api ? 'ok' : '失败'}`)
      if (!api) throw new Error('加载 @deepseek-ai/dsh-llm 失败')
      const llm = ctx.llm
      hostLog(`ctx.llm.stream：${typeof llm?.stream}`)
      if (!llm || typeof llm.stream !== 'function') throw new Error('DSH 的 llm 服务不可用')
      const model = resolveModel(ctx, config)
      hostLog(`模型：${model ? `${model.provider}/${model.model}` : '无'}`)
      if (!model) throw new Error('没有可用的模型：先在 DSH 里选一个默认模型')

      const messages = history
        .slice(-HISTORY_ROUNDS * 2)
        .map((entry) => entry.role === 'user'
          ? api.createUserMessage({ content: [{ type: 'text', text: entry.text }], source: { kind: 'user' } })
          : api.createAssistantMessage({ content: [{ type: 'text', text: entry.text }] }))
      messages.push(api.createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' }
      }))

      const assembler = new api.BlockAssembler()
      let sent = ''
      const options = {
        provider: model.provider,
        model: model.model,
        sessionId: CALL_IDENTITY,
        messages,
        system: systemPrompt(roleplay),
        temperature: 0.9,
        signal: AbortSignal.timeout(90000)
      }

      for await (const chunk of llm.stream(options)) {
        assembler.push(chunk)
        const current = textOf(assembler)
        // 发全文快照而不是增量切片：BlockAssembler 的文本不保证是前缀追加，切片会串行
        if (current !== sent) {
          if (!sent) hostLog('收到首个 update')
          toHelper({ type: 'update', id, text: current })
          sent = current
        }
      }

      if (!sent.trim()) throw new Error('模型没有返回内容')
      toHelper({ type: 'done', id })
      hostLog(`chat 完成 id=${id} 长度=${sent.length}`)

      history.push({ role: 'user', text, at: Date.now() })
      history.push({ role: 'assistant', text: sent.trim(), at: Date.now() })
      while (history.length > MEMORY_CAP) history.shift()
      saveMemory(history)
      lastChatAt = Date.now()
    } catch (error) {
      logger.warn?.(`[firefly] 对话失败：${error?.message ?? error}`)
      hostLog(`chat 失败：${error?.stack ?? error}`)
      toHelper({ type: 'error', id, message: error?.message ?? String(error) })
    } finally {
      busy = false
    }
  }

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk
    let index = stdoutBuffer.indexOf('\n')
    while (index >= 0) {
      const line = stdoutBuffer.slice(0, index).trim()
      stdoutBuffer = stdoutBuffer.slice(index + 1)
      if (line) {
        try {
          const message = JSON.parse(line)
          if (message?.type === 'balance') {
            void showBalance()
          } else if (message?.type === 'whisper') {
            void whisperNow(true)
          } else if (message?.type === 'chat' && typeof message.text === 'string') {
            void handleChat(message.id, message.text)
          } else if (message?.type === 'ready' && Number.isFinite(Number(message.port))) {
            helperPort = Number(message.port)
            hostLog(`helper 通道就绪 port=${helperPort}`)
            while (outbox.length > 0) deliver(outbox.shift())
          } else if (message?.type === 'log') {
            logger.info?.(`[firefly] ${message.text}`)
          }
        } catch {
          /* 非 JSON 行忽略 */
        }
      }
      index = stdoutBuffer.indexOf('\n')
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => logger.warn?.(`[firefly] ${String(chunk).trim()}`))
  child.on('error', (error) => logger.error?.(`[firefly] helper 启动失败：${error.message}`))
  child.on('exit', (code, signal) => logger.warn?.(`[firefly] helper 退出 code=${code} signal=${signal ?? 'none'}`))

  ctx.effect(() => () => {
    try {
      child.kill()
    } catch {
      /* 已经退了 */
    }
  })
}
