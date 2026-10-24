/**
 * Joplin 工具层：配置解析、笔记本路径解析、搜索摘要、内部链接图谱，以及
 * 注册到 `ctx.tools` 的模型可见工具定义。
 *
 * 设计取舍（对应 https://github.com/dweigend/joplin-mcp-server 的能力面）：
 * - 保留：搜索、读笔记、写/改/删笔记、笔记本树、建笔记本、Markdown 导入、
 *   内部链接（反向链接）追踪。
 * - 不移植：语义检索（onnxruntime + MiniLM 模型，几十 MB，需要 Python 侧依赖）。
 *   关键词搜索 + 链接图谱是零依赖能覆盖的部分。
 * - 额外补上：joplin_status（诊断 token/端口/连接），以及把「按笔记本列笔记」
 *   折叠进 joplin_search_notes，避免再堆一个工具。
 *
 * @module dsh-joplin/joplin-tools
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { JoplinClient, JoplinError, formatError } from './joplin-client.js'

const DEFAULT_BASE_URL = 'http://127.0.0.1:41184'
const DEFAULT_TIMEOUT_MS = 20_000
const NOTE_FIELDS =
  'id,title,body,parent_id,created_time,updated_time,user_created_time,user_updated_time,is_todo,todo_due,todo_completed,is_conflict'
const LIST_FIELDS = 'id,title,parent_id,updated_time,is_todo,body'
const SEARCH_FIELDS = 'id,title,body,parent_id,updated_time,is_todo'
const QUERY_MAX_PAGES = 5
const FOLDER_CACHE_MS = 5 * 60 * 1000
const GRAPH_CACHE_MS = 5 * 60 * 1000
const GRAPH_MAX_PAGES = 30
const GRAPH_MAX_BODY_CHARS = 200_000
const MAX_IMPORT_BYTES = 2 * 1024 * 1024
const NOTE_ID_PATTERN = /^[0-9a-fA-F]{32}$/
const INTERNAL_LINK_PATTERN = /\]\(:\/([0-9a-fA-F]{32})\)/g
const SEARCH_PAGE_SIZE = 100
const OBJECT_OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }
// Joplin 的 /search 偶尔会卡住（FTS 索引状态异常时实测可挂几分钟不返回），而
// 标题搜索、按笔记本列笔记、正文读取都正常。这里给搜索一个较短的探测超时，
// 超时后回退到本地扫描（复用链接图谱已经拉下来的正文），并在 10 分钟内不再
// 重试卡住的接口，避免每次搜索都先干等。
const API_SEARCH_TIMEOUT_MS = 8_000
const SEARCH_FALLBACK_TTL_MS = 10 * 60 * 1000
const searchState = { apiFailingUntil: 0 }

// 写权限默认全关：保护用户笔记不被顺手改动。权限只看「明确开启」，不猜默认值。
const CAPABILITY_HELP = {
  create:
    '新建/导入笔记的权限已关闭。需要时在 ~/.dsh/joplin.json 写 "allowCreate": true（插件设置里同名开关也行），立即生效。',
  update:
    '修改笔记的权限默认关闭。用户明确要求修改某篇笔记的具体内容时，在 ~/.dsh/joplin.json 写 "allowUpdate": true 后重试（用完可以删掉这一行）。',
  delete:
    '删除笔记的权限默认关闭。只能由用户在 ~/.dsh/joplin.json 或插件设置里显式写 "allowDelete": true 才会生效。',
}

const TOKEN_HELP =
  '在 Joplin「工具 → 选项 → Web Clipper」启用服务并复制 API token，写入 ~/.dsh/joplin.json（{"token":"..."}），或在插件设置里填 token。'
const CONNECTION_HELP =
  '确认 Joplin 桌面端正在运行，且「工具 → 选项 → Web Clipper」里启用了 Web Clipper 服务；默认端口 41184。'

// ---------------------------------------------------------------------------
// 配置解析：插件配置 → 环境变量 → ~/.dsh/joplin.json
// ---------------------------------------------------------------------------

/** 配置文件路径（DSH_HOME/joplin.json），token 可以只放这里，不必写进 profile YAML。 */
export function settingsFilePath() {
  const home = String(process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
  return join(home, 'joplin.json')
}

/** 读取配置文件；不存在或损坏时返回空对象（配置是可选层，不该让插件起不来）。 */
export function readSettingsFile() {
  try {
    const parsed = JSON.parse(readFileSync(settingsFilePath(), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** 只接受明确的布尔语义（true/false、1/0、on/off、yes/no）；其余返回 undefined。 */
function explicitBoolean(value) {
  if (typeof value === 'boolean') return value
  if (value === undefined || value === null) return undefined
  const text = String(value).trim().toLowerCase()
  if (!text) return undefined
  if (['true', '1', 'yes', 'on'].includes(text)) return true
  if (['false', '0', 'no', 'off'].includes(text)) return false
  return undefined
}

/**
 * 权限开关的解析顺序：配置文件 > 环境变量 > 插件配置 > 默认值。
 * 文件排在插件配置之前，是因为「改一个文件立刻生效」比「重装/重启让设置生效」更安全：
 * 收紧权限时永远不会被旧配置挡住。
 */
function resolveFlag({ name, envName, file, config, fallback }) {
  const fromFile = explicitBoolean(file?.[name])
  if (fromFile !== undefined) return { value: fromFile, source: `配置文件 ${settingsFilePath()}` }
  const fromEnv = envName ? explicitBoolean(process.env[envName]) : undefined
  if (fromEnv !== undefined) return { value: fromEnv, source: `环境变量 ${envName}` }
  const fromConfig = explicitBoolean(config?.[name])
  if (fromConfig !== undefined) return { value: fromConfig, source: '插件配置' }
  return { value: fallback, source: '默认值' }
}

/**
 * 逐字段解析配置来源，并记录每项来自哪里，供 joplin_status 展示。
 * @param {Record<string, unknown>} [config] 插件配置（schemastery 已填默认值）
 */
export function resolveSettings(config = {}) {
  const file = readSettingsFile()
  /** @param {string} field @param {string} [envName] */
  const pick = (field, envName) => {
    const configured = config?.[field]
    if (configured !== undefined && configured !== null && String(configured).trim() !== '') {
      return { value: String(configured).trim(), source: '插件配置' }
    }
    const fromEnv = envName ? String(process.env[envName] ?? '').trim() : ''
    if (fromEnv) return { value: fromEnv, source: `环境变量 ${envName}` }
    const fromFile = file?.[field]
    if (fromFile !== undefined && fromFile !== null && String(fromFile).trim() !== '') {
      return { value: String(fromFile).trim(), source: `配置文件 ${settingsFilePath()}` }
    }
    return { value: '', source: '未设置' }
  }

  const allowCreate = resolveFlag({ name: 'allowCreate', envName: 'JOPLIN_ALLOW_CREATE', file, config, fallback: true })
  const allowUpdate = resolveFlag({ name: 'allowUpdate', envName: 'JOPLIN_ALLOW_UPDATE', file, config, fallback: false })
  const allowDelete = resolveFlag({ name: 'allowDelete', envName: 'JOPLIN_ALLOW_DELETE', file, config, fallback: false })

  const baseUrl = pick('baseUrl', 'JOPLIN_BASE_URL')
  const token = pick('token', 'JOPLIN_TOKEN')
  const timeout = pick('timeoutMs', 'JOPLIN_TIMEOUT_MS')
  const defaultNotebook = pick('defaultNotebook', 'JOPLIN_DEFAULT_NOTEBOOK')
  const parsedTimeout = Number(timeout.value)

  return {
    baseUrl: baseUrl.value || DEFAULT_BASE_URL,
    baseUrlSource: baseUrl.value ? baseUrl.source : '默认值',
    token: token.value,
    tokenSource: token.source,
    timeoutMs: Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_TIMEOUT_MS,
    defaultNotebook: defaultNotebook.value,
    configFile: settingsFilePath(),
    allowCreate: allowCreate.value,
    allowCreateSource: allowCreate.source,
    allowUpdate: allowUpdate.value,
    allowUpdateSource: allowUpdate.source,
    allowDelete: allowDelete.value,
    allowDeleteSource: allowDelete.source,
  }
}

/** 构造客户端；缺 token 时直接给可操作的错误，而不是发一个注定 401 的请求。 */
function createClient(settings) {
  if (!settings.token) {
    throw new JoplinError('尚未配置 Joplin API token', { code: 'TOKEN_MISSING', hint: TOKEN_HELP })
  }
  return new JoplinClient({ baseUrl: settings.baseUrl, token: settings.token, timeoutMs: settings.timeoutMs })
}

/** 异常 → 工具失败结果（保留 code/hint 信息，但只把文本交给模型）。 */
function toToolError(error) {
  const wrapped = new Error(formatError(error))
  if (error instanceof JoplinError) {
    wrapped.name = 'JoplinError'
    // @ts-expect-error 附加机器可读 code，便于日志定位
    wrapped.code = error.code
  }
  return wrapped
}

/**
 * 权限闸门。关闭时直接抛错，**不发任何写请求**——所以即使模型误调用也碰不到用户数据。
 * @param {ReturnType<typeof resolveSettings>} settings
 * @param {'create' | 'update' | 'delete'} capability
 */
function requireCapability(settings, capability) {
  const allowed =
    capability === 'create' ? settings.allowCreate : capability === 'update' ? settings.allowUpdate : settings.allowDelete
  if (allowed) return
  const label = capability === 'create' ? '新建' : capability === 'update' ? '修改' : '删除'
  throw new JoplinError(`${label}笔记的权限已关闭（默认保护用户笔记）`, {
    code: 'WRITE_DISABLED',
    hint: CAPABILITY_HELP[capability],
  })
}

/** 修改/删除还要求调用方声明「用户在本轮对话里明确要求过」，避免模型自发写真数据。 */
function requireUserConsent(args, action) {
  if (args?.user_confirmed === true) return
  throw new JoplinError(`${action}笔记需要用户明确确认`, {
    code: 'USER_CONSENT_REQUIRED',
    hint: `只有用户在本轮对话中明确要求${action}这篇笔记时才传 user_confirmed: true；否则不要调用。`,
  })
}

/**
 * 写入后回读校验：Joplin 3.7.18 的 clipper 会损坏含原始 UTF-8 的大请求体，
 * 所以每次带正文的写入都回读比对一次，发现不一致就明确报错（而不是静默坏掉）。
 * @param {import('./joplin-client.js').JoplinClient} client
 * @param {string} noteId
 * @param {string} expectedBody
 * @param {AbortSignal} [signal]
 */
async function assertBodySaved(client, noteId, expectedBody, signal) {
  const saved = await client.getNote(noteId, { fields: 'id,body' }, signal)
  const body = String(saved?.body ?? '')
  if (body === expectedBody) return
  throw new JoplinError(
    `写入后读回的正文与发送内容不一致（期望 ${Buffer.byteLength(expectedBody)}B，实际 ${Buffer.byteLength(body)}B）`,
    {
      code: 'WRITE_VERIFY_FAILED',
      hint: '笔记可能已被写坏。插件的请求体已做 ASCII 转义；如果仍出现，请查 Joplin 的笔记历史（revisions）恢复这篇笔记。',
    },
  )
}

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

/** @param {unknown} value @param {number} min @param {number} max */
function clamp(value, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return min
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

/** Joplin 时间戳是毫秒整数；转成 ISO 字符串，坏值返回 null。 */
function toIso(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return null
  const date = new Date(number)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function isTodo(note) {
  return Number(note?.is_todo) === 1
}

function extractLinkIds(body) {
  const text = String(body ?? '')
  const ids = []
  const seen = new Set()
  INTERNAL_LINK_PATTERN.lastIndex = 0
  for (let match = INTERNAL_LINK_PATTERN.exec(text); match; match = INTERNAL_LINK_PATTERN.exec(text)) {
    const id = match[1].toLowerCase()
    if (!seen.has(id)) {
      seen.add(id)
      ids.push(id)
    }
  }
  return ids
}

/**
 * 在正文里截一段命中 query 的摘要；query 为空时取开头。
 */
function buildSnippet(body, query, length) {
  const chars = clamp(length, 0, 2000)
  const text = String(body ?? '').replace(/\s+/g, ' ').trim()
  if (!chars || !text) return ''
  const terms = String(query ?? '')
    .split(/\s+/)
    .map((term) => term.replace(/^[^0-9A-Za-z\u4e00-\u9fa5]+|[^0-9A-Za-z\u4e00-\u9fa5]+$/g, '').toLowerCase())
    .filter((term) => term.length > 1)
  let hit = -1
  for (const term of terms) {
    const index = text.toLowerCase().indexOf(term)
    if (index >= 0 && (hit < 0 || index < hit)) hit = index
  }
  if (hit < 0) return text.length > chars ? `${text.slice(0, chars)}…` : text
  const start = Math.max(0, hit - Math.floor(chars / 3))
  const end = Math.min(text.length, start + chars)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

function requireNoteId(value, field = 'note_id') {
  const id = String(value ?? '').trim()
  if (!NOTE_ID_PATTERN.test(id)) {
    throw new JoplinError(`${field} 不合法：${id || '(空)'}`, {
      code: 'BAD_NOTE_ID',
      hint: 'note_id 是 32 位十六进制字符串；可以先用 joplin_search_notes 找到它。',
    })
  }
  return id.toLowerCase()
}

// ---------------------------------------------------------------------------
// 笔记本：树、路径、按标题/路径解析（带 5 分钟缓存）
// ---------------------------------------------------------------------------

const folderCache = { at: 0, map: /** @type {Map<string, {id: string, title: string, parentId: string | null}> | null} */ (null) }

function invalidateFolderCache() {
  folderCache.at = 0
  folderCache.map = null
}

/** @param {Array<Record<string, unknown>>} rawNodes */
function buildFolderMap(rawNodes) {
  /** @type {Map<string, {id: string, title: string, parentId: string | null}>} */
  const map = new Map()
  /** @param {Array<Record<string, unknown>>} nodes */
  const visit = (nodes) => {
    for (const node of nodes) {
      if (!node || typeof node.id !== 'string' || !node.id) continue
      const parentId = typeof node.parent_id === 'string' && node.parent_id ? node.parent_id : null
      map.set(node.id, { id: node.id, title: String(node.title ?? '(未命名笔记本)'), parentId })
      if (Array.isArray(node.children) && node.children.length) visit(node.children)
    }
  }
  visit(Array.isArray(rawNodes) ? rawNodes : [])
  return map
}

/** 笔记本 id → 完整路径（Work/Projects）。父链断开时返回已有部分。 */
function folderPath(map, id) {
  if (!id) return null
  const parts = []
  const seen = new Set()
  let current = map.get(id)
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    parts.unshift(current.title)
    current = current.parentId ? map.get(current.parentId) : undefined
  }
  return parts.length ? parts.join('/') : null
}

/** 用 parent_id 把扁平 map 组装成可读树（API 的 children 结构也兼容）。 */
function buildFolderTree(map) {
  /** @type {Map<string, {id: string, title: string, path: string | null, children: any[]}>} */
  const nodes = new Map()
  for (const folder of map.values()) {
    nodes.set(folder.id, { id: folder.id, title: folder.title, path: folderPath(map, folder.id), children: [] })
  }
  const roots = []
  for (const folder of map.values()) {
    const node = nodes.get(folder.id)
    const parent = folder.parentId ? nodes.get(folder.parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  /** @param {any[]} list */
  const sortRecursive = (list) => {
    list.sort((left, right) => String(left.title).localeCompare(String(right.title), 'zh-CN'))
    for (const item of list) sortRecursive(item.children)
  }
  sortRecursive(roots)
  return roots
}

async function loadFolderMap(client, { force = false, signal } = {}) {
  if (!force && folderCache.map && Date.now() - folderCache.at < FOLDER_CACHE_MS) return folderCache.map
  const raw = await client.listFolders(signal)
  const items = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : []
  const map = buildFolderMap(items)
  folderCache.map = map
  folderCache.at = Date.now()
  return map
}

/**
 * 笔记本引用 → 笔记本记录。支持 id、完整路径（Work/Projects）、唯一标题。
 * 歧义时抛错并列出候选，让模型用完整路径重试，而不是随便挑一个。
 */
function resolveFolder(map, reference) {
  const value = String(reference ?? '').trim()
  if (!value) return null
  if (NOTE_ID_PATTERN.test(value)) {
    return map.get(value.toLowerCase()) ?? { id: value.toLowerCase(), title: value, parentId: null }
  }
  const needle = value.toLowerCase()
  const byPath = [...map.values()].filter((folder) => (folderPath(map, folder.id) ?? '').toLowerCase() === needle)
  if (byPath.length === 1) return byPath[0]
  if (byPath.length > 1) {
    throw new JoplinError(`笔记本路径「${value}」不唯一：${byPath.map((folder) => folderPath(map, folder.id)).join('、')}`, {
      code: 'NOTEBOOK_AMBIGUOUS',
    })
  }
  const byTitle = [...map.values()].filter((folder) => folder.title.toLowerCase() === needle)
  if (byTitle.length === 1) return byTitle[0]
  if (byTitle.length > 1) {
    throw new JoplinError(
      `笔记本名「${value}」匹配到多个笔记本：${byTitle.map((folder) => folderPath(map, folder.id)).join('、')}`,
      { code: 'NOTEBOOK_AMBIGUOUS', hint: '改用完整路径（如 工作/项目A）重试。' },
    )
  }
  const similar = [...map.values()]
    .filter((folder) => (folderPath(map, folder.id) ?? '').toLowerCase().includes(needle))
    .slice(0, 8)
    .map((folder) => folderPath(map, folder.id))
  throw new JoplinError(`找不到笔记本「${value}」${similar.length ? `；相近的有：${similar.join('、')}` : ''}`, {
    code: 'NOTEBOOK_NOT_FOUND',
    hint: '先调用 joplin_list_notebooks 查看现有笔记本路径。',
  })
}

// ---------------------------------------------------------------------------
// 内部链接图谱（Joplin API 没有反链能力，只能扫正文里的 :/<id>）
// ---------------------------------------------------------------------------

const linkCache = {
  at: 0,
  fingerprint: '',
  graph: /** @type {{notes: Map<string, any>, outgoing: Map<string, Set<string>>, incoming: Map<string, Set<string>>, linkCount: number, truncated: boolean} | null} */ (
    null
  ),
}

function invalidateLinkCache() {
  linkCache.at = 0
  linkCache.fingerprint = ''
  linkCache.graph = null
}

async function loadLinkGraph(client, { force = false, signal } = {}) {
  const newest = await client.listNotes(
    { page: 1, limit: 1, fields: 'id,title,updated_time', orderBy: 'updated_time', orderDir: 'DESC' },
    signal,
  )
  const latest = Array.isArray(newest?.items) ? newest.items[0] : undefined
  const fingerprint = latest ? `${latest.id}:${latest.updated_time}` : 'empty'

  if (!force && linkCache.graph && linkCache.fingerprint === fingerprint && Date.now() - linkCache.at < GRAPH_CACHE_MS) {
    return linkCache.graph
  }

  /** @type {Map<string, {id: string, title: string, parentId: string | null, body: string}>} */
  const notes = new Map()
  let truncated = false
  for (let page = 1; page <= GRAPH_MAX_PAGES; page += 1) {
    const response = await client.listNotes(
      { page, limit: 100, fields: 'id,title,body,parent_id,updated_time,is_todo' },
      signal,
    )
    const items = Array.isArray(response?.items) ? response.items : []
    for (const note of items) {
      if (!note?.id) continue
      notes.set(note.id.toLowerCase(), {
        id: note.id.toLowerCase(),
        title: String(note.title ?? ''),
        parentId: typeof note.parent_id === 'string' && note.parent_id ? note.parent_id : null,
        body: String(note.body ?? ''),
        updatedTime: Number(note.updated_time) || 0,
        isTodo: Number(note.is_todo) === 1 ? 1 : 0,
      })
    }
    if (!response?.has_more) break
    if (page === GRAPH_MAX_PAGES) truncated = true
  }

  /** @type {Map<string, Set<string>>} */
  const outgoing = new Map()
  /** @type {Map<string, Set<string>>} */
  const incoming = new Map()
  let linkCount = 0
  for (const note of notes.values()) {
    const targets = new Set()
    for (const target of extractLinkIds(note.body.slice(0, GRAPH_MAX_BODY_CHARS))) {
      if (notes.has(target)) targets.add(target)
    }
    if (!targets.size) continue
    outgoing.set(note.id, targets)
    linkCount += targets.size
    for (const target of targets) {
      if (!incoming.has(target)) incoming.set(target, new Set())
      incoming.get(target).add(note.id)
    }
  }

  const graph = { notes, outgoing, incoming, linkCount, truncated }
  linkCache.graph = graph
  linkCache.fingerprint = fingerprint
  linkCache.at = Date.now()
  return graph
}

/** 沿指定方向走 depth 层，返回除起点外的所有 id。 */
function collectNeighbourIds(graph, startId, direction, depth) {
  const visited = new Set([startId])
  let frontier = new Set([startId])
  for (let level = 0; level < depth; level += 1) {
    const next = new Set()
    for (const id of frontier) {
      if (direction === 'out' || direction === 'both') for (const target of graph.outgoing.get(id) ?? []) next.add(target)
      if (direction === 'in' || direction === 'both') for (const source of graph.incoming.get(id) ?? []) next.add(source)
    }
    frontier = new Set()
    for (const id of next) {
      if (!visited.has(id)) {
        visited.add(id)
        frontier.add(id)
      }
    }
    if (!frontier.size) break
  }
  visited.delete(startId)
  return [...visited]
}

// ---------------------------------------------------------------------------
// 分页收集
// ---------------------------------------------------------------------------

async function collectNotes(client, { folderId, query, limit, signal, timeoutMs }) {
  const collected = []
  let page = 1
  let hasMore = false
  while (collected.length < limit && page <= QUERY_MAX_PAGES) {
    const response = query
      ? await client.search({ query, page, limit: SEARCH_PAGE_SIZE, fields: SEARCH_FIELDS, timeoutMs }, signal)
      : await client.getFolderNotes(folderId, { page, limit: SEARCH_PAGE_SIZE, fields: LIST_FIELDS }, signal)
    const batch = Array.isArray(response?.items) ? response.items : []
    for (const note of batch) {
      if (folderId && note.parent_id !== folderId) continue
      collected.push(note)
    }
    hasMore = Boolean(response?.has_more)
    if (!hasMore || batch.length === 0) break
    page += 1
  }
  return { items: collected.slice(0, limit), hasMore: hasMore || collected.length > limit }
}

// ---------------------------------------------------------------------------
// 本地扫描兜底：/search 卡住时直接在已拉取的正文里匹配
// ---------------------------------------------------------------------------

/**
 * 解析搜索词：支持 `title:` / `body:` 前缀与双引号短语，其余按空格切词。
 * @param {string} query
 */
function parseSearchTerms(query) {
  const raw = String(query ?? '').trim()
  if (!raw) return []
  /** @type {Array<{ field: 'title' | 'body' | null, value: string }>} */
  const terms = []
  for (const part of raw.match(/"[^"]*"|\S+/g) ?? []) {
    let text = part
    if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1)
    const fielded = /^(title|body):(.*)$/i.exec(text)
    const field = fielded ? /** @type {'title' | 'body'} */ (fielded[1].toLowerCase()) : null
    const value = (fielded ? fielded[2] : text).trim().toLowerCase()
    if (value) terms.push({ field, value })
  }
  return terms
}

/** 把图谱里的笔记按搜索词过滤打分；标题命中权重高于正文，同分按更新时间排。 */
async function localScanNotes(client, { query, folderId, limit, signal }) {
  const trimmed = String(query ?? '').trim()
  const matchAll = trimmed === '*'
  const terms = parseSearchTerms(trimmed)
  if (!matchAll && !terms.length) return { items: [], hasMore: false, truncated: false, scanned: 0 }

  const graph = await loadLinkGraph(client, { signal })
  /** @type {Array<{ note: any, score: number }>} */
  const scored = []
  for (const note of graph.notes.values()) {
    if (folderId && note.parentId !== folderId) continue
    const title = note.title.toLowerCase()
    const body = note.body.toLowerCase()
    let score = 0
    let matched = true
    if (!matchAll) {
      for (const term of terms) {
        let hit = false
        if (term.field !== 'body' && title.includes(term.value)) {
          score += 5
          hit = true
        }
        if (term.field !== 'title' && body.includes(term.value)) {
          score += 1
          hit = true
        }
        if (!hit) {
          matched = false
          break
        }
      }
    }
    if (matched) scored.push({ note, score })
  }

  scored.sort((left, right) => right.score - left.score || right.note.updatedTime - left.note.updatedTime)
  return {
    items: scored.slice(0, limit).map(({ note }) => ({
      id: note.id,
      title: note.title,
      body: note.body,
      parent_id: note.parentId ?? '',
      updated_time: note.updatedTime,
      is_todo: note.isTodo,
    })),
    hasMore: scored.length > limit,
    truncated: graph.truncated,
    scanned: graph.notes.size,
  }
}

/** 哪些搜索错误值得回退（接口卡住/5xx）；token、连不上这类要直接报给用户。 */
function isSearchFallbackCandidate(error) {
  return error instanceof JoplinError && (error.code === 'TIMEOUT' || error.code === 'HTTP_ERROR')
}

/** 记下「接口这段时间不可用」，后续搜索直接走本地扫描。 */
function markApiSearchFailing() {
  searchState.apiFailingUntil = Date.now() + SEARCH_FALLBACK_TTL_MS
}

// ---------------------------------------------------------------------------
// 渲染：把结构化结果写成便于阅读的文本（模型与 UI 共用）
// ---------------------------------------------------------------------------

/** @param {any} value */
function renderStatus(value) {
  const lines = [`Joplin: ${value.ok ? '连接正常' : '未就绪'}`, `服务地址: ${value.baseUrl}`]
  lines.push(`token 来源: ${value.tokenSource}`)
  if (value.configFile) lines.push(`配置文件: ${value.configFile}`)
  if (value.server) lines.push(`服务响应: ${value.server}`)
  if (value.capabilities) {
    const label = (entry) => (entry.allowed ? '开' : '关')
    lines.push(
      `写权限: 新建=${label(value.capabilities.create)} / 修改=${label(value.capabilities.update)} / 删除=${label(value.capabilities.delete)}`,
    )
  }
  if (typeof value.notebooks === 'number') lines.push(`笔记本数量: ${value.notebooks}`)
  if (value.recentNote) lines.push(`最近更新: ${value.recentNote.title}（${value.recentNote.updated ?? '未知时间'}）`)
  if (value.error) lines.push(`错误: ${value.error}`)
  for (const hint of value.hints ?? []) lines.push(`提示: ${hint}`)
  return lines.join('\n')
}

/** @param {any[]} nodes @param {number} depth */
function renderFolderTree(nodes, depth = 0) {
  const lines = []
  for (const node of nodes ?? []) {
    lines.push(`${'  '.repeat(depth)}- ${node.title}  [${node.path}]  id=${node.id}`)
    lines.push(...renderFolderTree(node.children ?? [], depth + 1))
  }
  return lines
}

/** @param {any} value */
function renderNotebooks(value) {
  return [`笔记本 ${value.count} 个（格式：标题 [完整路径] id）`, ...renderFolderTree(value.tree)].join('\n')
}

/** @param {any} value */
function renderSearch(value) {
  const header = value.query
    ? `搜索「${value.query}」：${value.count} 条${value.hasMore ? '（还有更多）' : ''}`
    : `笔记本「${value.notebook ?? ''}」中 ${value.count} 条笔记${value.hasMore ? '（还有更多）' : ''}`
  if (!value.count) return `${header}\n没有命中。可以换关键词，或先用 joplin_list_notebooks 看笔记本结构。`
  const lines = [header]
  if (value.engine === 'local-scan') {
    lines.push(`引擎: 本地扫描${value.fallback ? `（${value.fallback}）` : ''}`)
  }
  value.results.forEach((hit, index) => {
    const meta = [hit.notebook, hit.updated, hit.isTodo ? '待办' : null].filter(Boolean).join(' · ')
    lines.push(`${index + 1}. ${hit.title}${meta ? `  (${meta})` : ''}\n   id=${hit.id}`)
    if (hit.snippet) lines.push(`   ${hit.snippet}`)
  })
  return lines.join('\n')
}

/** @param {any} value */
function renderNote(value) {
  const meta = [
    value.notebook ? `笔记本: ${value.notebook}` : null,
    value.updated ? `更新: ${value.updated}` : null,
    value.tags?.length ? `标签: ${value.tags.join(', ')}` : null,
    value.isTodo ? '待办' : null,
  ].filter(Boolean)
  const lines = [`${value.title}  (id=${value.id})`, ...(meta.length ? [meta.join(' · ')] : [])]
  if (value.links?.length) {
    lines.push(`内部链接: ${value.links.map((link) => `${link.title}(${link.id})`).join('、')}`)
  }
  lines.push('', value.body || '(正文为空)')
  return lines.join('\n')
}

/** @param {any} value */
function renderLinked(value) {
  const lines = [`链接图谱：${value.noteTitle ?? value.noteId}（方向 ${value.direction}，深度 ${value.depth}）`]
  const section = (label, entries) => {
    lines.push(`${label} ${entries.length} 条`)
    for (const entry of entries) lines.push(`- ${entry.title}  ${entry.notebook ? `[${entry.notebook}]` : ''}  id=${entry.id}`)
  }
  section('出链', value.outgoing)
  section('入链（反向链接）', value.incoming)
  if (value.truncated) lines.push('注意：笔记数量超过扫描上限，图谱可能不完整。')
  return lines.join('\n')
}

/** @param {any} value */
function renderSimple(value) {
  const skip = new Set(['ok', 'created', 'updated', 'deleted', 'imported'])
  const fields = Object.entries(value)
    .filter(([key, entry]) => !skip.has(key) && entry !== null && entry !== undefined && entry !== '')
    .map(([key, entry]) => `${key}=${Array.isArray(entry) ? entry.join(',') : entry}`)
  return fields.join('  ')
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

/**
 * 构造全部 Joplin 工具定义。
 * @param {Record<string, unknown>} [config] 插件配置
 */
export function createJoplinTools(config = {}) {
  const settings = () => resolveSettings(config)

  /**
   * 统一的执行包装：解析配置 → 建客户端 → 跑业务 → 把异常翻译成工具失败。
   * @template T
   * @param {(client: JoplinClient, current: ReturnType<typeof resolveSettings>) => Promise<T>} run
   */
  const withClient = async (run) => {
    const current = settings()
    try {
      const client = createClient(current)
      return await run(client, current)
    } catch (error) {
      throw toToolError(error)
    }
  }

  /** @type {any[]} */
  const tools = []

  tools.push({
    name: 'joplin_status',
    description:
      '检查 Joplin 连接与配置：token 从哪来、服务是否可达、笔记本数量、最近更新的笔记。Joplin 相关工具报错时先调它定位问题（token 没配 / Joplin 没开 / 端口不对）。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: OBJECT_OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: renderStatus(value) }] },
    async execute(_args, exec) {
      const current = settings()
      const base = {
        baseUrl: current.baseUrl,
        tokenSource: current.tokenSource,
        configFile: current.configFile,
        capabilities: {
          create: { allowed: current.allowCreate, source: current.allowCreateSource },
          update: { allowed: current.allowUpdate, source: current.allowUpdateSource },
          delete: { allowed: current.allowDelete, source: current.allowDeleteSource },
        },
        hints: /** @type {string[]} */ ([]),
      }
      if (!current.token) {
        base.hints.push(TOKEN_HELP, CONNECTION_HELP)
        return { ok: false, configured: false, ...base }
      }
      try {
        const client = createClient(current)
        const server = await client.ping(exec.signal)
        const folders = await loadFolderMap(client, { force: true, signal: exec.signal })
        const recent = await client.listNotes(
          { page: 1, limit: 1, fields: 'id,title,updated_time', orderBy: 'updated_time', orderDir: 'DESC' },
          exec.signal,
        )
        const latest = Array.isArray(recent?.items) ? recent.items[0] : undefined
        return {
          ok: true,
          configured: true,
          ...base,
          server: typeof server === 'string' ? server : JSON.stringify(server),
          notebooks: folders.size,
          recentNote: latest
            ? { id: latest.id, title: String(latest.title ?? ''), updated: toIso(latest.updated_time) }
            : null,
        }
      } catch (error) {
        return {
          ok: false,
          configured: true,
          ...base,
          error: formatError(error),
          hints: [CONNECTION_HELP],
        }
      }
    },
  })

  tools.push({
    name: 'joplin_list_notebooks',
    description:
      '列出 Joplin 全部笔记本（菜单树 + 完整路径 + id）。新建/移动笔记前用它确认目标笔记本；notebook 参数既接受完整路径（如 工作/项目A），也接受唯一标题。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: OBJECT_OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: renderNotebooks(value) }] },
    async execute(_args, exec) {
      return withClient(async (client) => {
        const map = await loadFolderMap(client, { force: true, signal: exec.signal })
        return { count: map.size, tree: buildFolderTree(map) }
      })
    },
  })

  tools.push({
    name: 'joplin_search_notes',
    description:
      '在 Joplin 中搜索笔记（Joplin 搜索语法，支持 title:xxx / body:xxx / 引号短语），返回带摘要的结果与 note_id。query 留空时改为列出某个笔记本里的笔记（此时必须给 notebook）。结果只是摘要，读全文用 joplin_get_note。Joplin 的 /search 接口卡住时会自动回退到本地扫描（结果里 engine 会标注），不影响使用。隐私：笔记内容只在本机 Joplin 与会话之间流转，不要把正文或摘要发到 web 搜索、外部 API 或其它工具。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词；留空则按 notebook 列出笔记' },
        notebook: { type: 'string', description: '可选：笔记本 id / 标题 / 完整路径，限定搜索范围' },
        limit: { type: 'integer', default: 20, description: '返回条数，1-100，默认 20' },
        snippetChars: { type: 'integer', default: 200, description: '每条摘要字符数，0 表示不返回摘要' },
        mode: {
          type: 'string',
          enum: ['auto', 'api', 'local'],
          default: 'auto',
          description: 'auto=先调 Joplin 搜索接口，卡住/失败时本地扫描；api=只用接口；local=只本地扫描',
        },
      },
      additionalProperties: false,
    },
    output: { schema: OBJECT_OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: renderSearch(value) }] },
    async execute(args, exec) {
      const query = String(args.query ?? '').trim()
      const notebookRef = String(args.notebook ?? '').trim()
      const limit = clamp(args.limit ?? 20, 1, 100)
      const snippetChars = clamp(args.snippetChars ?? 200, 0, 2000)
      const mode = ['auto', 'api', 'local'].includes(String(args.mode)) ? String(args.mode) : 'auto'
      if (!query && !notebookRef) {
        throw new JoplinError('query 与 notebook 至少要给一个', {
          code: 'BAD_ARGUMENTS',
          hint: '列出某个笔记本的笔记时传 notebook；全文搜索时传 query。',
        })
      }
      return withClient(async (client) => {
        const map = await loadFolderMap(client, { signal: exec.signal })
        const folder = notebookRef ? resolveFolder(map, notebookRef) : null
        let items = []
        let hasMore = false
        /** @type {'api' | 'local-scan'} */
        let engine = 'api'
        let fallbackReason = null
        let scanned = null

        if (!query) {
          // 只是列笔记本：走 folders/:id/notes，不涉及搜索索引
          const listed = await collectNotes(client, { folderId: folder?.id, query: '', limit, signal: exec.signal })
          items = listed.items
          hasMore = listed.hasMore
        } else if (mode === 'auto' && Date.now() < searchState.apiFailingUntil) {
          engine = 'local-scan'
          fallbackReason = 'Joplin 搜索接口最近超时，暂时跳过'
        } else if (mode !== 'local') {
          try {
            const found = await collectNotes(client, {
              folderId: folder?.id,
              query,
              limit,
              signal: exec.signal,
              timeoutMs: API_SEARCH_TIMEOUT_MS,
            })
            items = found.items
            hasMore = found.hasMore
          } catch (error) {
            if (mode === 'api' || !isSearchFallbackCandidate(error)) throw error
            markApiSearchFailing()
            engine = 'local-scan'
            fallbackReason = `Joplin 搜索接口不可用（${/** @type {JoplinError} */ (error).code ?? 'ERROR'}）`
          }
        } else {
          engine = 'local-scan'
        }

        if (query && engine === 'local-scan') {
          const scannedResult = await localScanNotes(client, {
            query,
            folderId: folder?.id,
            limit,
            signal: exec.signal,
          })
          items = scannedResult.items
          hasMore = scannedResult.hasMore
          scanned = scannedResult.scanned
          if (scannedResult.truncated) fallbackReason = `${fallbackReason ?? ''}；笔记本量超过扫描上限，结果可能不全`.replace(/^；/, '')
        }

        return {
          query: query || null,
          notebook: folder ? folderPath(map, folder.id) : null,
          mode,
          engine,
          fallback: fallbackReason,
          scanned,
          count: items.length,
          hasMore,
          results: items.map((note) => ({
            id: note.id,
            title: String(note.title ?? '(无标题)'),
            notebook: note.parent_id ? folderPath(map, note.parent_id) : null,
            updated: toIso(note.updated_time),
            isTodo: isTodo(note),
            snippet: buildSnippet(note.body, query, snippetChars),
          })),
        }
      })
    },
  })

  tools.push({
    name: 'joplin_get_note',
    description:
      '按 note_id 读取一条 Joplin 笔记的完整正文、所属笔记本、标签与内部链接（链接到其他笔记）。需要正文全文时用它，不要靠搜索摘要猜测内容。隐私：读到的内容属于用户私人笔记，只能用于完成当前任务，禁止上传、外发或交给其他工具/服务。',
    parameters: {
      type: 'object',
      properties: { note_id: { type: 'string', description: '笔记 id，32 位十六进制' } },
      required: ['note_id'],
      additionalProperties: false,
    },
    output: { schema: OBJECT_OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: renderNote(value) }] },
    async execute(args, exec) {
      const noteId = requireNoteId(args.note_id)
      return withClient(async (client) => {
        const note = await client.getNote(noteId, { fields: NOTE_FIELDS }, exec.signal)
        if (!note || !note.id) {
          throw new JoplinError(`找不到笔记 ${noteId}`, {
            code: 'NOTE_NOT_FOUND',
            hint: '用 joplin_search_notes 重新确认 id。',
          })
        }
        const map = await loadFolderMap(client, { signal: exec.signal })
        const tagsResponse = await client.getNoteTags(noteId, exec.signal).catch(() => null)
        const tags = (Array.isArray(tagsResponse?.items) ? tagsResponse.items : [])
          .map((tag) => String(tag?.title ?? ''))
          .filter(Boolean)
        const linkIds = extractLinkIds(note.body).slice(0, 20)
        const resolvedLinks = await Promise.all(
          linkIds.map((id) =>
            client
              .getNote(id, { fields: 'id,title,parent_id' }, exec.signal)
              .catch(() => null)
              .then((target) =>
                target?.id
                  ? { id: target.id, title: String(target.title ?? '(无标题)'), notebook: folderPath(map, target.parent_id) }
                  : null,
              ),
          ),
        )
        return {
          id: note.id,
          title: String(note.title ?? '(无标题)'),
          notebook: note.parent_id ? folderPath(map, note.parent_id) : null,
          created: toIso(note.created_time ?? note.user_created_time),
          updated: toIso(note.updated_time ?? note.user_updated_time),
          isTodo: isTodo(note),
          todoDue: toIso(note.todo_due),
          tags,
          links: resolvedLinks.filter(Boolean),
          body: String(note.body ?? ''),
        }
      })
    },
  })

  tools.push({
    name: 'joplin_create_note',
    description:
      '在 Joplin 中新建笔记。notebook 用完整路径或唯一标题指定目标笔记本；都没给时落到插件配置的 defaultNotebook，仍没有则进根目录。is_todo=true 创建待办。受 allowCreate 权限控制（默认开）；不会改动任何已有笔记。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '笔记标题（必填）' },
        body: { type: 'string', description: 'Markdown 正文' },
        notebook: { type: 'string', description: '目标笔记本：id、标题或完整路径' },
        parent_id: { type: 'string', description: '目标笔记本 id（与 notebook 二选一，优先）' },
        is_todo: { type: 'boolean', default: false, description: '是否创建为待办' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    output: { schema: OBJECT_OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: `已创建：${renderSimple(value)}` }] },
    async execute(args, exec) {
      requireCapability(settings(), 'create')
      const title = String(args.title ?? '').trim()
      if (!title) throw new JoplinError('title 不能为空', { code: 'BAD_ARGUMENTS' })
      const body = typeof args.body === 'string' ? args.body : ''
      const parentId = String(args.parent_id ?? '').trim()
      const notebookRef = String(args.notebook ?? '').trim()
      return withClient(async (client, current) => {
        const reference = parentId || notebookRef || current.defaultNotebook
        const map = await loadFolderMap(client, { signal: exec.signal })
        const folder = reference ? resolveFolder(map, reference) : null
        const payload = { title }
        if (body) payload.body = body
        if (folder?.id) payload.parent_id = folder.id
        if (args.is_todo === true) payload.is_todo = 1
        const created = await client.createNote(payload, exec.signal)
        if (body && created?.id) await assertBodySaved(client, created.id, body, exec.signal)
        invalidateFolderCache()
        invalidateLinkCache()
        return {
          created: true,
          id: created?.id ?? null,
          title: String(created?.title ?? title),
          notebook: folder ? folderPath(map, folder.id) : null,
        }
      })
    },
  })

  tools.push({
    name: 'joplin_update_note',
    description:
      '修改已有 Joplin 笔记。只传需要改的字段（title/body/notebook/parent_id/is_todo），未给的保持原样。改正文是整段替换，不是追加；追加内容请自己拼好完整正文。权限：修改默认关闭（allowUpdate=false 时直接拒绝，不发请求）；开启后仍必须传 user_confirmed=true，且只有用户在本轮对话中明确要求修改这篇笔记的这部分内容时才允许调用。',
    parameters: {
      type: 'object',
      properties: {
        note_id: { type: 'string', description: '要修改的笔记 id' },
        title: { type: 'string', description: '新标题' },
        body: { type: 'string', description: '新的完整 Markdown 正文（整段替换）' },
        notebook: { type: 'string', description: '移动到的目标笔记本：id、标题或完整路径' },
        parent_id: { type: 'string', description: '移动到的笔记本 id（与 notebook 二选一，优先）' },
        is_todo: { type: 'boolean', description: '是否改为待办' },
        user_confirmed: {
          type: 'boolean',
          default: false,
          description: '仅当用户在本轮对话中明确要求修改这篇笔记的这部分内容时传 true；否则不要调用本工具',
        },
      },
      required: ['note_id'],
      additionalProperties: false,
    },
    output: {
      schema: OBJECT_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: `已更新：${renderSimple(value)}` }],
    },
    async execute(args, exec) {
      const current = settings()
      requireCapability(current, 'update')
      requireUserConsent(args, '修改')
      const noteId = requireNoteId(args.note_id)
      const payload = {}
      const changed = []
      if (typeof args.title === 'string' && args.title.trim()) {
        payload.title = args.title.trim()
        changed.push('title')
      }
      if (typeof args.body === 'string') {
        payload.body = args.body
        changed.push('body')
      }
      if (typeof args.is_todo === 'boolean') {
        payload.is_todo = args.is_todo ? 1 : 0
        changed.push('is_todo')
      }
      const parentIdRef = String(args.parent_id ?? '').trim()
      const notebookRef = String(args.notebook ?? '').trim()
      if (parentIdRef || notebookRef) {
        return withClient(async (client) => {
          const map = await loadFolderMap(client, { force: false, signal: exec.signal })
          const folder = resolveFolder(map, parentIdRef || notebookRef)
          payload.parent_id = folder.id
          changed.push('notebook')
          if (!changed.length) throw new JoplinError('没有要修改的字段', { code: 'BAD_ARGUMENTS' })
          const updated = await client.updateNote(noteId, payload, exec.signal)
          if (typeof payload.body === 'string') await assertBodySaved(client, noteId, payload.body, exec.signal)
          invalidateFolderCache()
          invalidateLinkCache()
          return {
            updated: true,
            id: updated?.id ?? noteId,
            title: String(updated?.title ?? payload.title ?? ''),
            changed,
            notebook: folderPath(map, folder.id),
          }
        })
      }
      if (!changed.length) {
        throw new JoplinError('没有要修改的字段', {
          code: 'BAD_ARGUMENTS',
          hint: '至少传 title / body / notebook / parent_id / is_todo 之一。',
        })
      }
      return withClient(async (client) => {
        const updated = await client.updateNote(noteId, payload, exec.signal)
        if (typeof payload.body === 'string') await assertBodySaved(client, noteId, payload.body, exec.signal)
        invalidateLinkCache()
        return { updated: true, id: updated?.id ?? noteId, title: String(updated?.title ?? ''), changed }
      })
    },
  })

  tools.push({
    name: 'joplin_delete_note',
    description:
      '删除 Joplin 笔记。默认只移到回收站（可恢复）；永久删除必须显式 permanent=true。权限：删除默认关闭（allowDelete=false 时直接拒绝），只能由用户在 ~/.dsh/joplin.json 或插件设置里显式开启；开启后仍必须传 user_confirmed=true，且只在用户明确要求删除该笔记时调用。用户没明确要求永久删除时不要传 permanent。',
    parameters: {
      type: 'object',
      properties: {
        note_id: { type: 'string', description: '要删除的笔记 id' },
        permanent: { type: 'boolean', default: false, description: 'true = 永久删除（不可恢复）' },
        user_confirmed: {
          type: 'boolean',
          default: false,
          description: '仅当用户在本轮对话中明确要求删除这篇笔记时传 true；否则不要调用本工具',
        },
      },
      required: ['note_id'],
      additionalProperties: false,
    },
    output: {
      schema: OBJECT_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.permanent ? `已永久删除 ${value.id}` : `已移入回收站 ${value.id}` }],
    },
    async execute(args, exec) {
      requireCapability(settings(), 'delete')
      requireUserConsent(args, '删除')
      const noteId = requireNoteId(args.note_id)
      const permanent = args.permanent === true
      return withClient(async (client) => {
        await client.deleteNote(noteId, { permanent }, exec.signal)
        invalidateLinkCache()
        return { deleted: true, id: noteId, permanent }
      })
    },
  })

  tools.push({
    name: 'joplin_create_notebook',
    description:
      '新建 Joplin 笔记本。parent 用于建子笔记本，接受 id、标题或完整路径；会在 Joplin 侧真实创建，重复标题不会被拦截，创建前先 joplin_list_notebooks 确认。受 allowCreate 权限控制（默认开）。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '笔记本标题（必填）' },
        parent: { type: 'string', description: '可选：父笔记本 id / 标题 / 完整路径' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    output: {
      schema: OBJECT_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: `已创建笔记本：${value.title}（${value.path}，id=${value.id}）` }],
    },
    async execute(args, exec) {
      requireCapability(settings(), 'create')
      const title = String(args.title ?? '').trim()
      if (!title) throw new JoplinError('title 不能为空', { code: 'BAD_ARGUMENTS' })
      const parentRef = String(args.parent ?? '').trim()
      return withClient(async (client) => {
        const map = await loadFolderMap(client, { signal: exec.signal })
        const parent = parentRef ? resolveFolder(map, parentRef) : null
        const payload = { title }
        if (parent?.id) payload.parent_id = parent.id
        const created = await client.createFolder(payload, exec.signal)
        invalidateFolderCache()
        const refreshed = await loadFolderMap(client, { force: true, signal: exec.signal })
        const folder = created?.id ? refreshed.get(created.id) : null
        return {
          created: true,
          id: created?.id ?? null,
          title: String(created?.title ?? title),
          path: folder ? folderPath(refreshed, folder.id) : parent ? `${folderPath(map, parent.id)}/${title}` : title,
        }
      })
    },
  })

  tools.push({
    name: 'joplin_import_markdown',
    description:
      '把一个本地 Markdown 文件导入成 Joplin 笔记。标题默认取正文第一个一级标题，没有则用文件名。适合批量/长文稿导入；短内容直接用 joplin_create_note 传 body 更省事。受 allowCreate 权限控制（默认开）；文件内容只发往本机 Joplin。',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '本地 Markdown 文件绝对路径' },
        notebook: { type: 'string', description: '目标笔记本：id、标题或完整路径' },
        title: { type: 'string', description: '可选：覆盖自动推断的标题' },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
    output: {
      schema: OBJECT_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: `已导入：${value.title} → ${value.notebook ?? '根目录'}（${value.bytes} 字节，id=${value.id}）` }],
    },
    async execute(args, exec) {
      requireCapability(settings(), 'create')
      const filePath = String(args.file_path ?? '').trim()
      if (!filePath) throw new JoplinError('file_path 不能为空', { code: 'BAD_ARGUMENTS' })
      let content
      let bytes = 0
      try {
        const stats = statSync(filePath)
        if (stats.size > MAX_IMPORT_BYTES) {
          throw new JoplinError(`文件太大：${filePath}（${stats.size} 字节，上限 ${MAX_IMPORT_BYTES}）`, {
            code: 'FILE_TOO_LARGE',
            hint: '超过 2MB 的文稿建议先拆分。',
          })
        }
        bytes = stats.size
        content = readFileSync(filePath, 'utf8')
      } catch (error) {
        if (error instanceof JoplinError) throw error
        throw new JoplinError(`读取文件失败：${filePath}`, {
          code: 'FILE_READ_FAILED',
          hint: '确认路径存在且可读（不要用 ~ 简写，用绝对路径）。',
        })
      }
      const heading = content.match(/^\s*#\s+(.+)$/m)
      const fallback = filePath.split(/[\\/]/).pop() ?? 'imported'
      const title =
        String(args.title ?? '').trim() ||
        (heading ? heading[1].trim().slice(0, 200) : fallback.replace(/\.(md|markdown|txt)$/i, ''))
      const notebookRef = String(args.notebook ?? '').trim()
      return withClient(async (client, current) => {
        const map = await loadFolderMap(client, { signal: exec.signal })
        const folder = notebookRef || current.defaultNotebook ? resolveFolder(map, notebookRef || current.defaultNotebook) : null
        const payload = { title, body: content }
        if (folder?.id) payload.parent_id = folder.id
        const created = await client.createNote(payload, exec.signal)
        if (created?.id) await assertBodySaved(client, created.id, content, exec.signal)
        invalidateFolderCache()
        invalidateLinkCache()
        return {
          imported: true,
          id: created?.id ?? null,
          title: String(created?.title ?? title),
          notebook: folder ? folderPath(map, folder.id) : null,
          bytes,
        }
      })
    },
  })

  tools.push({
    name: 'joplin_find_linked_notes',
    description:
      '按 Joplin 内部链接（:/<note_id>）查笔记的出链与反向链接。Joplin 自身没有反链功能，这里靠扫描全部笔记正文建图（首次会慢，之后按最近更新时间指纹缓存 5 分钟）。depth 控制扩展层数，最大 3；搜索只能找字面文本，找「谁引用了我」必须用这个。',
    parameters: {
      type: 'object',
      properties: {
        note_id: { type: 'string', description: '起点笔记 id' },
        direction: { type: 'string', enum: ['out', 'in', 'both'], default: 'both', description: 'out=出链，in=反向链接，both=双向' },
        depth: { type: 'integer', default: 1, description: '扩展层数 1-3，默认 1' },
        limit: { type: 'integer', default: 50, description: '每个方向最多返回多少条，默认 50' },
      },
      required: ['note_id'],
      additionalProperties: false,
    },
    output: {
      schema: OBJECT_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderLinked(value) }],
    },
    async execute(args, exec) {
      const noteId = requireNoteId(args.note_id)
      const direction = ['out', 'in', 'both'].includes(String(args.direction)) ? String(args.direction) : 'both'
      const depth = clamp(args.depth ?? 1, 1, 3)
      const limit = clamp(args.limit ?? 50, 1, 200)
      return withClient(async (client) => {
        const map = await loadFolderMap(client, { signal: exec.signal })
        const graph = await loadLinkGraph(client, { signal: exec.signal })
        const root = graph.notes.get(noteId)
        if (!root) {
          throw new JoplinError(`笔记 ${noteId} 不在链接图谱里`, {
            code: 'NOTE_NOT_FOUND',
            hint: '确认 id 正确；也可能是笔记太多、扫描被截断，可先 joplin_get_note 验证存在。',
          })
        }
        const toEntry = (id) => {
          const note = graph.notes.get(id)
          return {
            id,
            title: note?.title || '(无标题)',
            notebook: note?.parentId ? folderPath(map, note.parentId) : null,
          }
        }
        const outgoingIds = direction === 'out' || direction === 'both' ? collectNeighbourIds(graph, noteId, 'out', depth) : []
        const incomingIds = direction === 'in' || direction === 'both' ? collectNeighbourIds(graph, noteId, 'in', depth) : []
        return {
          noteId,
          noteTitle: root.title || '(无标题)',
          direction,
          depth,
          outgoing: outgoingIds.slice(0, limit).map(toEntry),
          incoming: incomingIds.slice(0, limit).map(toEntry),
          truncated: graph.truncated || outgoingIds.length > limit || incomingIds.length > limit,
          scanned: { notes: graph.notes.size, links: graph.linkCount },
        }
      })
    },
  })

  return tools
}
