/**
 * Joplin Web Clipper 数据 API 的最小客户端。
 *
 * 为什么不用全局 fetch：本机环境设置了 NODE_USE_ENV_PROXY=1 与 http_proxy，
 * 走 fetch 时请求会被环境代理接管（localhost 虽在 NO_PROXY 里，但不同 Node
 * 版本对通配符的匹配行为不一致）。用 node:http/node:https 直连可以彻底绕开
 * 代理，并且能拿到 ECONNREFUSED 这类精确错误码，把它翻译成「Joplin 没启动」
 * 这种模型和人都看得懂的提示。
 *
 * API 参考：https://joplinapp.org/help/api/references/rest_api/
 *
 * @module dsh-joplin/joplin-client
 */
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_BASE_URL = 'http://127.0.0.1:41184'

const TOKEN_HINT =
  '在 Joplin「工具 → 选项 → Web Clipper」启用服务并复制 API token，写入 ~/.dsh/joplin.json（{"token":"..."}），或在插件设置里填 token。'

const CONNECTION_HINT =
  '确认 Joplin 桌面端正在运行，且「工具 → 选项 → Web Clipper」里启用了 Web Clipper 服务；默认端口 41184。'

/** Joplin 相关错误：带机器可读的 code 与一句可以直接展示给用户的 hint。 */
export class JoplinError extends Error {
  /**
   * @param {string} message 面向用户的错误描述
   * @param {{ code?: string, status?: number, hint?: string }} [options]
   */
  constructor(message, options = {}) {
    super(message)
    this.name = 'JoplinError'
    this.code = options.code ?? 'JOPLIN_ERROR'
    this.status = options.status
    this.hint = options.hint
  }
}

/**
 * 把任意异常渲染成给模型看的一行/两行文本。
 * @param {unknown} error
 * @returns {string}
 */
export function formatError(error) {
  if (error instanceof JoplinError) {
    return error.hint ? `${error.message}\n提示：${error.hint}` : error.message
  }
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 把 JSON 里的非 ASCII 字符转成 \uXXXX 转义，得到纯 ASCII 的请求体。
 *
 * 为什么必须这么做：Joplin 3.7.18 的 clipper 在解析「含原始 UTF-8 多字节字符的较大请求体」
 * 时会损坏内容——实测同一篇 111KB 中文正文，直接发原始 UTF-8 会在大约每 16KB 处出现一处
 * U+FFFD（原字符被吃掉），而同内容改成 ASCII 转义后逐字节一致。这个问题与客户端无关：
 * Python urllib 也复现（ensure_ascii=False 坏、True 好），所以属于服务端解析缺陷。
 *
 * JSON 的字符串字面量里所有非 ASCII 字符都可以安全写成 \uXXXX，语义完全等价。
 */
export function asciiSafeJson(value) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (character) => {
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  })
}

/** Joplin Web Clipper 服务客户端。 */
export class JoplinClient {
  /**
   * @param {{ baseUrl?: string, token?: string, timeoutMs?: number }} [options]
   */
  constructor(options = {}) {
    const baseUrl = String(options.baseUrl ?? DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL
    let parsed
    try {
      parsed = new URL(baseUrl)
    } catch {
      throw new JoplinError(`baseUrl 不合法：${baseUrl}`, {
        code: 'BAD_BASE_URL',
        hint: '示例：http://127.0.0.1:41184',
      })
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new JoplinError(`baseUrl 只支持 http/https：${baseUrl}`, { code: 'BAD_BASE_URL' })
    }
    this.baseUrl = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`
    this.token = String(options.token ?? '').trim()
    const timeout = Number(options.timeoutMs)
    this.timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS
    this.secure = parsed.protocol === 'https:'
  }

  /**
   * 拼出带 token 的请求地址。token 同时放进查询参数（API 文档要求）和
   * Authorization 头（对开启 clipper_auth 的新版本更稳）。
   * @param {string} path
   * @param {Record<string, string | number | boolean | undefined | null>} [query]
   * @returns {URL}
   */
  #buildUrl(path, query = {}) {
    const url = new URL(`${this.baseUrl}/${String(path).replace(/^\/+/, '')}`)
    if (this.token) url.searchParams.set('token', this.token)
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(key, String(value))
    }
    return url
  }

  /**
   * 发一个请求并把 HTTP 层错误翻译成 JoplinError。
   * @returns {Promise<{ status: number, headers: Record<string, string | string[] | undefined>, body: string }>}
   */
  async #send(method, path, { query, body, signal, timeoutMs } = {}) {
    const url = this.#buildUrl(path, query)
    const payload = body === undefined || body === null ? undefined : Buffer.from(asciiSafeJson(body), 'utf8')
    /** @type {Record<string, string | number>} */
    const headers = { Accept: 'application/json' }
    if (this.token) headers.Authorization = this.token
    if (payload) {
      headers['Content-Type'] = 'application/json; charset=utf-8'
      headers['Content-Length'] = payload.length
    }

    const effectiveTimeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : this.timeoutMs
    const timeoutSignal = AbortSignal.timeout(effectiveTimeoutMs)
    const combinedSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal
    const transport = this.secure ? httpsRequest : httpRequest

    let response
    try {
      response = await new Promise((resolve, reject) => {
        const request = transport(url, { method, headers, signal: combinedSignal, agent: false }, (res) => {
          res.setEncoding('utf8')
          let data = ''
          res.on('data', (chunk) => {
            data += chunk
          })
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }))
          res.on('error', reject)
        })
        request.on('error', reject)
        if (payload) request.write(payload)
        request.end()
      })
    } catch (error) {
      throw this.#transportError(error, method, path, signal, effectiveTimeoutMs)
    }

    if (response.status >= 400) throw this.#statusError(response.status, response.body, path)
    return response
  }

  /**
   * 网络层错误 → 可读提示。
   */
  #transportError(error, method, path, signal, timeoutMs = this.timeoutMs) {
    const code = /** @type {any} */ (error)?.code
    const name = /** @type {any} */ (error)?.name
    if (name === 'AbortError' || name === 'TimeoutError' || code === 'ABORT_ERR') {
      if (signal?.aborted) return new JoplinError('Joplin 请求已取消', { code: 'ABORTED' })
      return new JoplinError(
        `Joplin 请求超时（${timeoutMs}ms）：${method} ${path}`,
        { code: 'TIMEOUT', hint: 'Joplin 可能正在同步或锁库；稍后重试，或在插件设置里调大 timeoutMs。' },
      )
    }
    if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENOTFOUND' || code === 'ECONNRESET') {
      return new JoplinError(
        `连不上 Joplin 服务：${this.baseUrl}（${code}）`,
        { code: 'CONNECTION_REFUSED', hint: CONNECTION_HINT },
      )
    }
    const message = error instanceof Error ? error.message : String(error)
    return new JoplinError(`访问 Joplin 失败：${method} ${path} — ${message}`, {
      code: 'TRANSPORT_ERROR',
      hint: CONNECTION_HINT,
    })
  }

  /**
   * HTTP 状态码 → 可读错误。
   */
  #statusError(status, rawBody, path) {
    let detail = String(rawBody ?? '').trim()
    try {
      const parsed = JSON.parse(detail)
      if (parsed && typeof parsed === 'object') {
        detail = String(parsed.error ?? parsed.message ?? detail)
      }
    } catch {
      // 非 JSON 错误体（例如纯文本）直接用原文
    }
    if (status === 401 || status === 403) {
      return new JoplinError(`Joplin 拒绝访问（HTTP ${status}，${path}）：token 无效或缺失`, {
        code: 'UNAUTHORIZED',
        status,
        hint: TOKEN_HINT,
      })
    }
    if (status === 404) {
      return new JoplinError(`Joplin 中找不到对象（HTTP 404，${path}）${detail ? `：${detail}` : ''}`, {
        code: 'NOT_FOUND',
        status,
        hint: '确认 ID 是否正确；可以用 joplin_search_notes 或 joplin_list_notebooks 重新查。',
      })
    }
    return new JoplinError(`Joplin API 返回 HTTP ${status}（${path}）：${detail || '无错误详情'}`, {
      code: 'HTTP_ERROR',
      status,
    })
  }

  /** 解析响应体：JSON 优先，空体返回 null。 */
  #decode(response) {
    const text = String(response.body ?? '').trim()
    if (!text) return null
    const contentType = String(response.headers['content-type'] ?? '')
    if (contentType.includes('json') || /^[[{"]/.test(text)) {
      try {
        return JSON.parse(text)
      } catch {
        return text
      }
    }
    return text
  }

  /** GET /ping：不校验 token，返回文本 JoplinClipperServer。 */
  async ping(signal) {
    const response = await this.#send('GET', 'ping', { signal })
    return this.#decode(response)
  }

  /** GET /folders：笔记本是树形（子笔记本在 children 下）。 */
  async listFolders(signal) {
    const response = await this.#send('GET', 'folders', {
      query: { fields: 'id,title,parent_id,created_time,updated_time' },
      signal,
    })
    return this.#decode(response)
  }

  /** GET /folders/:id/notes */
  async getFolderNotes(folderId, { page = 1, limit = 100, fields } = {}, signal) {
    const response = await this.#send('GET', `folders/${encodeURIComponent(folderId)}/notes`, {
      query: { page, limit, fields },
      signal,
    })
    return this.#decode(response)
  }

  /** GET /notes */
  async listNotes({ page = 1, limit = 100, fields, orderBy, orderDir } = {}, signal) {
    const response = await this.#send('GET', 'notes', {
      query: { page, limit, fields, order_by: orderBy, order_dir: orderDir },
      signal,
    })
    return this.#decode(response)
  }

  /** GET /notes/:id */
  async getNote(noteId, { fields } = {}, signal) {
    const response = await this.#send('GET', `notes/${encodeURIComponent(noteId)}`, {
      query: { fields },
      signal,
    })
    return this.#decode(response)
  }

  /** GET /notes/:id/tags */
  async getNoteTags(noteId, signal) {
    const response = await this.#send('GET', `notes/${encodeURIComponent(noteId)}/tags`, {
      query: { fields: 'id,title' },
      signal,
    })
    return this.#decode(response)
  }

  /**
   * GET /search
   * @param {{ query?: string, limit?: number, fields?: string, type?: string, page?: number, timeoutMs?: number }} [options]
   * @param {AbortSignal} [signal]
   */
  async search({ query, limit = 100, fields, type, page, timeoutMs } = {}, signal) {
    const response = await this.#send('GET', 'search', {
      query: { query, limit, fields, type, page },
      signal,
      timeoutMs,
    })
    return this.#decode(response)
  }

  /** POST /notes */
  async createNote(payload, signal) {
    const response = await this.#send('POST', 'notes', { body: payload, signal })
    return this.#decode(response)
  }

  /** PUT /notes/:id */
  async updateNote(noteId, payload, signal) {
    const response = await this.#send('PUT', `notes/${encodeURIComponent(noteId)}`, { body: payload, signal })
    return this.#decode(response)
  }

  /** DELETE /notes/:id（默认进回收站，permanent=true 永久删除） */
  async deleteNote(noteId, { permanent = false } = {}, signal) {
    const response = await this.#send('DELETE', `notes/${encodeURIComponent(noteId)}`, {
      query: permanent ? { permanent: 1 } : undefined,
      signal,
    })
    return this.#decode(response)
  }

  /** POST /folders */
  async createFolder(payload, signal) {
    const response = await this.#send('POST', 'folders', { body: payload, signal })
    return this.#decode(response)
  }
}
