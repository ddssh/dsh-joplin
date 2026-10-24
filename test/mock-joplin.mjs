/**
 * 一个最小的 Joplin Web Clipper 数据 API 假服务，仅用于本插件的自动化验证。
 *
 * 覆盖插件实际会打的端点：/ping、/folders、/folders/:id/notes、/notes、
 * /notes/:id、/notes/:id/tags、/search，以及笔记/笔记本的增改删与分页、
 * fields 过滤。数据在内存里，进程退出即消失。
 *
 * 用法：`const server = await startMockJoplin(); server.url / server.token / server.stop()`。
 */
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'

const hex32 = () => randomBytes(16).toString('hex')

/**
 * @param {{ port?: number, token?: string }} [options]
 * @returns {Promise<{ url: string, token: string, port: number, state: any, stop: () => Promise<void> }>}
 */
export async function startMockJoplin(options = {}) {
  const token = options.token ?? 'test-token'
  const now = () => Date.now()

  /** @type {{ folders: any[], notes: any[], searchFails: boolean }} */
  const state = { folders: [], notes: [], searchFails: false }

  // --- 种子数据：两个根笔记本 + 一个子笔记本，三篇笔记（其中一篇带内部链接） ---
  const inbox = { id: hex32(), title: '收件箱', parent_id: '', created_time: now() - 3000, updated_time: now() - 3000 }
  const work = { id: hex32(), title: '工作', parent_id: '', created_time: now() - 2000, updated_time: now() - 2000 }
  const project = { id: hex32(), title: '项目A', parent_id: work.id, created_time: now() - 1000, updated_time: now() - 1000 }
  state.folders.push(inbox, work, project)

  const meeting = {
    id: hex32(),
    title: '今天的会议',
    body: '参加周会，确认本周排期。\n\n- 需求评审\n- 排期',
    parent_id: inbox.id,
    created_time: now() - 900,
    updated_time: now() - 900,
    is_todo: 0,
    todo_due: 0,
    todo_completed: 0,
    is_conflict: 0,
  }
  const plan = {
    id: hex32(),
    title: '项目计划',
    body: `# 项目计划\n\n先看一下会议记录：[今天的会议](:/${meeting.id})。\n\n然后拆任务。`,
    parent_id: project.id,
    created_time: now() - 800,
    updated_time: now() - 800,
    is_todo: 1,
    todo_due: 0,
    todo_completed: 0,
    is_conflict: 0,
  }
  const reading = {
    id: hex32(),
    title: '读书笔记',
    body: '《深度工作》：把注意力当成稀缺资源。',
    parent_id: work.id,
    created_time: now() - 700,
    updated_time: now() - 700,
    is_todo: 0,
    todo_due: 0,
    todo_completed: 0,
    is_conflict: 0,
  }
  state.notes.push(meeting, plan, reading)

  // --- helpers ---
  const send = (res, status, payload, headers = {}) => {
    const body = payload === undefined ? '' : JSON.stringify(payload)
    res.writeHead(status, {
      'Content-Type': payload === undefined ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      ...headers,
    })
    res.end(body)
  }

  const shape = (item, fields) => {
    if (!fields) return { ...item }
    const out = {}
    for (const field of String(fields).split(',')) {
      const key = field.trim()
      if (key && Object.hasOwn(item, key)) out[key] = item[key]
    }
    return out
  }

  const folderTree = (fields) => {
    const nodes = new Map(
      state.folders.map((folder) => [folder.id, { ...shape(folder, fields ?? 'id,title,parent_id'), children: [] }]),
    )
    const roots = []
    for (const folder of state.folders) {
      const node = nodes.get(folder.id)
      const parent = folder.parent_id ? nodes.get(folder.parent_id) : undefined
      if (parent) parent.children.push(node)
      else roots.push(node)
    }
    return roots
  }

  const visibleNotes = (url) => {
    const includeDeleted = url.searchParams.get('include_deleted') === '1'
    return state.notes.filter((note) => includeDeleted || !note.deleted_time)
  }

  const paginate = (items, url) => {
    const page = Number(url.searchParams.get('page') ?? 1) || 1
    const limit = Math.min(100, Number(url.searchParams.get('limit') ?? 100) || 100)
    const start = (page - 1) * limit
    return { items: items.slice(start, start + limit), has_more: start + limit < items.length }
  }

  const normalizeQuery = (query) => String(query ?? '').trim().toLowerCase()

  const readBody = async (req) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (!chunks.length) return {}
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return {}
    }
  }

  const authorized = (url, req) => {
    const fromQuery = url.searchParams.get('token')
    const fromHeader = req.headers.authorization
    return fromQuery === token || fromHeader === token
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const segments = url.pathname.split('/').filter(Boolean)

    try {
      if (segments[0] === 'ping') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('JoplinClipperServer')
        return
      }
      if (!authorized(url, req)) {
        send(res, 401, { error: 'Invalid token' })
        return
      }

      const method = req.method ?? 'GET'

      // GET /folders
      if (method === 'GET' && segments.length === 1 && segments[0] === 'folders') {
        send(res, 200, folderTree(url.searchParams.get('fields')))
        return
      }

      // POST /folders
      if (method === 'POST' && segments.length === 1 && segments[0] === 'folders') {
        const body = await readBody(req)
        const folder = {
          id: hex32(),
          title: String(body.title ?? '未命名笔记本'),
          parent_id: String(body.parent_id ?? ''),
          created_time: now(),
          updated_time: now(),
        }
        state.folders.push(folder)
        send(res, 200, folder)
        return
      }

      // GET /folders/:id/notes
      if (method === 'GET' && segments.length === 3 && segments[0] === 'folders' && segments[2] === 'notes') {
        const folderId = segments[1]
        const items = visibleNotes(url).filter((note) => note.parent_id === folderId)
        const page = paginate(items, url)
        send(res, 200, {
          items: page.items.map((note) => shape(note, url.searchParams.get('fields'))),
          has_more: page.has_more,
        })
        return
      }

      // GET /search
      if (method === 'GET' && segments.length === 1 && segments[0] === 'search') {
        // 模拟「Joplin 全文搜索接口卡死/报错」：插件应回退到本地扫描
        if (state.searchFails && url.searchParams.get('type') !== 'folder') {
          send(res, 500, { error: 'Search engine unavailable (simulated)' })
          return
        }
        const query = normalizeQuery(url.searchParams.get('query'))
        if (url.searchParams.get('type') === 'folder') {
          const items = state.folders.filter((folder) => String(folder.title).toLowerCase().includes(query.replace(/\*/g, '')))
          const page = paginate(items, url)
          send(res, 200, { items: page.items.map((item) => shape(item, url.searchParams.get('fields'))), has_more: page.has_more })
          return
        }
        const items = visibleNotes(url).filter((note) =>
          `${note.title}\n${note.body}`.toLowerCase().includes(query.replace(/\*/g, '')),
        )
        const page = paginate(items, url)
        send(res, 200, { items: page.items.map((note) => shape(note, url.searchParams.get('fields'))), has_more: page.has_more })
        return
      }

      // GET /notes
      if (method === 'GET' && segments.length === 1 && segments[0] === 'notes') {
        const orderBy = url.searchParams.get('order_by') ?? 'updated_time'
        const descending = (url.searchParams.get('order_dir') ?? 'DESC').toUpperCase() === 'DESC'
        const items = visibleNotes(url).sort((left, right) => {
          const a = left[orderBy] ?? 0
          const b = right[orderBy] ?? 0
          return descending ? b - a : a - b
        })
        const page = paginate(items, url)
        send(res, 200, {
          items: page.items.map((note) => shape(note, url.searchParams.get('fields'))),
          has_more: page.has_more,
        })
        return
      }

      // POST /notes
      if (method === 'POST' && segments.length === 1 && segments[0] === 'notes') {
        const body = await readBody(req)
        if (!String(body.title ?? '').trim()) {
          send(res, 400, { error: 'title is required' })
          return
        }
        const note = {
          id: hex32(),
          title: String(body.title),
          body: String(body.body ?? ''),
          parent_id: String(body.parent_id ?? ''),
          created_time: now(),
          updated_time: now(),
          is_todo: Number(body.is_todo ?? 0),
          todo_due: 0,
          todo_completed: 0,
          is_conflict: 0,
        }
        state.notes.push(note)
        send(res, 200, note)
        return
      }

      // /notes/:id (+/tags)
      if (segments[0] === 'notes' && segments.length >= 2) {
        const note = state.notes.find((item) => item.id === segments[1])
        if (!note) {
          send(res, 404, { error: 'Note not found' })
          return
        }
        if (segments.length === 3 && segments[2] === 'tags' && method === 'GET') {
          send(res, 200, { items: [], has_more: false })
          return
        }
        if (method === 'GET') {
          send(res, 200, shape(note, url.searchParams.get('fields')))
          return
        }
        if (method === 'PUT') {
          const body = await readBody(req)
          for (const [key, value] of Object.entries(body)) {
            if (['title', 'body', 'parent_id'].includes(key)) note[key] = String(value)
            if (key === 'is_todo') note.is_todo = Number(value)
          }
          note.updated_time = now()
          send(res, 200, note)
          return
        }
        if (method === 'DELETE') {
          if (url.searchParams.get('permanent') === '1') {
            state.notes = state.notes.filter((item) => item.id !== note.id)
          } else {
            note.deleted_time = now()
          }
          send(res, 200, undefined)
          return
        }
      }

      send(res, 404, { error: `No route for ${method} ${url.pathname}` })
    } catch (error) {
      send(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  })

  const port = options.port ?? 0
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  const actualPort = /** @type {any} */ (server.address()).port

  return {
    url: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    token,
    state,
    seed: { inbox, work, project, meeting, plan, reading },
    stop: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  }
}
