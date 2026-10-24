/**
 * dsh-joplin：把 Joplin 笔记接进 DSH 的 Host 插件。
 *
 * 只有 Host 半部：在 `apply` 里往 `ctx.tools` 注册 joplin_* 工具。没有 Client
 * 代码、没有构建步骤；业务代码只用 Node 内置模块（node:http / node:fs），不依赖
 * 任何第三方运行时包。
 *
 * 唯一要借的是 DSH 自带的配置 schema 库（schemastery）：`Config` 必须是一个
 * Standard Schema，Loader 才能校验配置、Settings 才能渲染表单。用 workspace
 * 里的目录 `install_bundle` 时 pnpm 会做成 symlink，模块的真实路径在 workspace
 * 下，裸导入解析不到 profile 的 node_modules——所以这里按「本包 → profile」两级
 * 去找，找不到就退化成无 Config（插件照常工作，配置仍可从 patch 行/env/JSON 文件读）。
 *
 * @module dsh-joplin
 */
import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createJoplinTools } from './joplin-tools.js'

const SCHEMA_PACKAGES = ['@deepseek-ai/schemastery', 'schemastery']
const requireFromHere = createRequire(import.meta.url)

/** Node 解析第三方包时可能的落点：当前安装位置，以及 DSH 各 profile 的 node_modules。 */
function schemaSearchRoots() {
  const roots = []
  const profileDir = String(process.env.DSH_PROFILE_DIR ?? '').trim()
  if (profileDir) roots.push(join(profileDir, 'node_modules'))
  const home = String(process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
  try {
    for (const entry of readdirSync(join(home, 'profiles'), { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(join(home, 'profiles', entry.name, 'node_modules'))
    }
  } catch {
    // 没有 profiles 目录（非 profile 启动）：保持空列表
  }
  return roots
}

/**
 * 找到 DSH 使用的 schemastery；解析不到返回 undefined（不是错误）。
 *
 * 先按普通裸导入解析（npm 安装、或真实拷贝进 profile 的包都能命中）；都不行时，
 * 用 createRequire 指定 profile 的 node_modules 作为查找根——这正是 workspace
 * 目录被 pnpm 做成 symlink 时的情形：模块真实路径在 workspace，裸导入找不到 profile
 * 里的包，但包本身就在 profile/node_modules 下。
 */
async function loadSchemaLibrary() {
  for (const specifier of SCHEMA_PACKAGES) {
    try {
      return await import(specifier)
    } catch {
      // 继续尝试下一级解析路径
    }
  }
  for (const specifier of SCHEMA_PACKAGES) {
    for (const root of schemaSearchRoots()) {
      try {
        const resolved = requireFromHere.resolve(specifier, { paths: [root] })
        return await import(pathToFileURL(resolved).href)
      } catch {
        // 换下一个查找根
      }
    }
  }
  return undefined
}

const schemaModule = await loadSchemaLibrary()
const Schema = schemaModule?.default ?? schemaModule

/** @type {string} */
export const name = 'dsh-joplin'

/** 注册工具需要 tools 服务；服务缺失时 Cordis 会等它就绪再激活。 */
export const inject = ['tools']

/**
 * 插件配置。token 在这层留空时，工具会依次退到环境变量与 ~/.dsh/joplin.json。
 * 没有解析到 schemastery 时为 undefined，Loader 视为「无 Config」，patch/config 原样透传。
 */
export const Config = Schema
  ? Schema.object({
      baseUrl: Schema.string()
        .default('http://127.0.0.1:41184')
        .description('Joplin Web Clipper 服务地址；桌面端默认 http://127.0.0.1:41184。'),
      token: Schema.string()
        .role('secret')
        .default('')
        .description(
          'Joplin API token（Joplin：工具 → 选项 → Web Clipper）。留空则依次读取环境变量 JOPLIN_TOKEN 与 ~/.dsh/joplin.json。',
        ),
      timeoutMs: Schema.number().default(20_000).description('单次 Joplin 请求超时（毫秒），默认 20000。'),
      defaultNotebook: Schema.string()
        .default('')
        .description('新建笔记未指定笔记本时使用的默认笔记本（标题或完整路径，如 工作/项目A）。'),
      allowCreate: Schema.boolean()
        .default(true)
        .description('允许新建笔记/笔记本与导入 Markdown。默认开启（不会改动已有笔记）。'),
      allowUpdate: Schema.boolean()
        .default(false)
        .description(
          '允许修改已有笔记（标题/正文/所在笔记本/待办状态）。默认关闭；开启后调用方仍必须声明用户已明确要求。',
        ),
      allowDelete: Schema.boolean()
        .default(false)
        .description('允许删除笔记。默认关闭，只能在配置文件或此处显式开启；开启后调用方仍必须声明用户已明确要求。'),
    })
  : undefined

/** 写给模型的常驻规则：隐私边界 + 写操作门槛。 */
const GUIDANCE_SECTION = {
  name: 'JOPLIN_NOTES',
  order: 2600,
  text: [
    'Joplin 笔记属于用户隐私：正文、摘要、标题都只能用于完成当前任务，禁止发往 web 搜索/抓取、浏览器、子代理、外部 API 或任何第三方服务；回复里也只引用完成任务所需的最小片段。',
    'Joplin 的写操作默认收紧：joplin_update_note 需要 allowUpdate=true 且 user_confirmed=true，joplin_delete_note 需要 allowDelete=true 且 user_confirmed=true；两者都只在用户本轮明确点名笔记与内容时才调用，不得自作主张。',
  ].join(' '),
}

/**
 * 注册常驻提示词段落（可选服务；缺失时静默跳过，不影响工具）。
 * @param {any} ctx
 */
function registerNotesGuidance(ctx) {
  try {
    const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
    if (systemPrompt && typeof systemPrompt.section === 'function') systemPrompt.section(GUIDANCE_SECTION)
  } catch {
    // 没有 systemPrompt 服务时退化为纯工具约束
  }
}

/**
 * 注册全部 Joplin 工具。
 * @param {unknown} ctx Cordis 插件上下文
 * @param {{ baseUrl?: string, token?: string, timeoutMs?: number, defaultNotebook?: string }} [config]
 */
export function apply(ctx, config) {
  const settings = config ?? {}
  for (const definition of createJoplinTools(settings)) {
    ctx.tools.register(definition)
  }
  registerNotesGuidance(ctx)
}
