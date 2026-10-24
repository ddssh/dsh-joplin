/**
 * dsh-joplin 冒烟测试：不需要真实 Joplin，直接对着 mock 服务把每个工具跑一遍。
 *
 * 运行：node test/smoke.mjs
 *
 * 覆盖：配置解析（环境变量 / ~/.dsh/joplin.json / 缺 token / 端口不通）、
 * 笔记本树与路径解析、搜索（关键词 + 按笔记本列）、读写笔记、建笔记本、
 * Markdown 导入、链接图谱（出链 / 反链）、以及每个工具的 render 输出。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockJoplin } from './mock-joplin.mjs'
import { createJoplinTools } from '../joplin-tools.js'
import { asciiSafeJson } from '../joplin-client.js'

/** 每个工具只用到 exec.signal，这里给个等价的最小上下文。 */
const makeExec = (name, args) => ({ name, arguments: args, signal: new AbortController().signal })

const results = []
const check = (label, fn) => {
  try {
    fn()
    results.push(`  ✓ ${label}`)
  } catch (error) {
    results.push(`  ✗ ${label}: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
}

const main = async () => {
  const server = await startMockJoplin()
  const { seed } = server
  // 隔离真实用户的 ~/.dsh/joplin.json：测试不能受它的权限开关影响
  const isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-home-isolated-'))

  try {
    // --- 1. 环境变量层：token/baseUrl 都来自 env ---
    process.env.JOPLIN_BASE_URL = server.url
    process.env.JOPLIN_TOKEN = server.token
    process.env.DSH_HOME = isolatedHome

    const makeCaller = (toolList) => {
      const byName = new Map(toolList.map((tool) => [tool.name, tool]))
      return async (name, args = {}) => {
        const tool = byName.get(name)
        assert.ok(tool, `工具 ${name} 未注册`)
        const value = await tool.execute(args, makeExec(name, args))
        // render 必须能消化自己返回的值，否则 UI 侧会炸
        const blocks = tool.output.render(args, value)
        assert.ok(Array.isArray(blocks) && blocks.length > 0 && blocks[0].type === 'text', `${name} render 输出异常`)
        assert.ok(String(blocks[0].text ?? '').length > 0, `${name} render 文本为空`)
        return value
      }
    }

    let tools = createJoplinTools({})
    const call = makeCaller(tools)
    // 写权限默认关闭；要跑写操作测试必须显式开启
    const writeTools = createJoplinTools({ allowUpdate: true, allowDelete: true })
    const callWrite = makeCaller(writeTools)

    check('请求体做 ASCII 转义（规避 Joplin 大正文损坏 bug）', () => {
      const sample = { body: '中文“引号”与 emoji 😀 以及 \t 制表符', n: 1 }
      const encoded = asciiSafeJson(sample)
      assert.match(encoded, /^[\x00-\x7f]*$/, '出站 JSON 不是纯 ASCII')
      assert.deepEqual(JSON.parse(encoded), sample, 'ASCII 转义破坏了语义')
    })

    check('注册了 10 个工具', () => assert.equal(tools.length, 10))
    check('工具名唯一且带 joplin_ 前缀', () => {
      assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length)
      assert.ok(tools.every((tool) => tool.name.startsWith('joplin_')))
    })

    const status = await call('joplin_status')
    check('status: 连接正常', () => {
      assert.equal(status.ok, true)
      assert.equal(status.configured, true)
      assert.equal(status.notebooks, 3)
      assert.equal(status.recentNote.id, seed.reading.id)
    })
    check('status: token 来源是环境变量', () => assert.match(status.tokenSource, /环境变量 JOPLIN_TOKEN/))
    check('status: 默认权限为 新建开 / 修改关 / 删除关', () => {
      assert.equal(status.capabilities.create.allowed, true)
      assert.equal(status.capabilities.update.allowed, false)
      assert.equal(status.capabilities.delete.allowed, false)
      assert.equal(status.capabilities.delete.source, '默认值')
    })

    const notebookList = await call('joplin_list_notebooks')
    check('list_notebooks: 3 个笔记本且含子树', () => {
      assert.equal(notebookList.count, 3)
      const workNode = notebookList.tree.find((node) => node.title === '工作')
      assert.ok(workNode, '缺少「工作」根节点')
      assert.equal(workNode.children[0].title, '项目A')
      assert.equal(workNode.children[0].path, '工作/项目A')
    })

    const searchByKeyword = await call('joplin_search_notes', { query: '会议' })
    check('search: 关键词命中并带摘要', () => {
      assert.ok(searchByKeyword.count >= 1)
      const hit = searchByKeyword.results.find((item) => item.id === seed.meeting.id)
      assert.ok(hit, '没搜到「今天的会议」')
      assert.equal(hit.notebook, '收件箱')
      assert.ok(hit.title.includes('会议'))
      assert.ok(hit.snippet.length > 0, '摘要为空')
      assert.equal(searchByKeyword.engine, 'api')
    })

    const searchByNotebook = await call('joplin_search_notes', { notebook: '工作/项目A' })
    check('search: 按笔记本路径列出笔记', () => {
      assert.equal(searchByNotebook.count, 1)
      assert.equal(searchByNotebook.results[0].id, seed.plan.id)
    })

    const searchByTitleRef = await call('joplin_search_notes', { notebook: '收件箱' })
    check('search: 按标题解析笔记本', () => assert.equal(searchByTitleRef.results[0].id, seed.meeting.id))

    const note = await call('joplin_get_note', { note_id: seed.plan.id })
    check('get_note: 正文/笔记本/待办/出链', () => {
      assert.equal(note.title, '项目计划')
      assert.equal(note.notebook, '工作/项目A')
      assert.equal(note.isTodo, true)
      assert.ok(note.body.includes('先看一下会议记录'))
      assert.deepEqual(note.links.map((link) => link.id), [seed.meeting.id])
      assert.equal(note.links[0].notebook, '收件箱')
    })

    const linkedOut = await call('joplin_find_linked_notes', { note_id: seed.plan.id, direction: 'out' })
    check('find_linked_notes: 出链', () => {
      assert.equal(linkedOut.outgoing.length, 1)
      assert.equal(linkedOut.outgoing[0].id, seed.meeting.id)
      assert.equal(linkedOut.incoming.length, 0)
    })
    const linkedIn = await call('joplin_find_linked_notes', { note_id: seed.meeting.id, direction: 'in' })
    check('find_linked_notes: 反向链接', () => {
      assert.equal(linkedIn.incoming.length, 1)
      assert.equal(linkedIn.incoming[0].id, seed.plan.id)
      assert.equal(linkedIn.scanned.notes, 3)
    })

    const created = await call('joplin_create_note', {
      title: '来自 DSH 的笔记',
      body: '**hi**',
      notebook: '工作/项目A',
    })
    check('create_note: 落到指定笔记本', () => {
      assert.ok(created.id)
      assert.equal(created.notebook, '工作/项目A')
    })

    // 默认（allowUpdate/allowDelete=false）必须直接拒绝，且一个写请求都不发
    await assert.rejects(
      () => call('joplin_update_note', { note_id: created.id, title: '不该发生', user_confirmed: true }),
      /修改笔记的权限已关闭/,
    )
    check('权限: 修改默认被拒绝', () => {})
    await assert.rejects(
      () => call('joplin_delete_note', { note_id: created.id, user_confirmed: true }),
      /删除笔记的权限已关闭/,
    )
    check('权限: 删除默认被拒绝', () => {})
    check('权限: 被拒绝时笔记原样保留', () => {
      const stored = server.state.notes.find((note) => note.id === created.id)
      assert.equal(stored.title, '来自 DSH 的笔记')
      assert.equal(stored.deleted_time, undefined)
    })
    await assert.rejects(
      () => callWrite('joplin_update_note', { note_id: created.id, title: '没有确认' }),
      /需要用户明确确认/,
    )
    check('权限: 修改需 user_confirmed=true', () => {})

    const updated = await callWrite('joplin_update_note', {
      note_id: created.id,
      title: '改名后的笔记',
      is_todo: true,
      user_confirmed: true,
    })
    check('update_note: 只改传入的字段', () => {
      assert.equal(updated.updated, true)
      assert.deepEqual(updated.changed, ['title', 'is_todo'])
      assert.equal(updated.title, '改名后的笔记')
    })

    const moved = await callWrite('joplin_update_note', { note_id: created.id, notebook: '收件箱', user_confirmed: true })
    check('update_note: 移动笔记本', () => {
      assert.deepEqual(moved.changed, ['notebook'])
      assert.equal(moved.notebook, '收件箱')
    })

    const newNotebook = await call('joplin_create_notebook', { title: '临时', parent: '工作' })
    check('create_notebook: 子笔记本路径正确', () => {
      assert.equal(newNotebook.path, '工作/临时')
      assert.ok(newNotebook.id)
    })

    const importDir = mkdtempSync(join(tmpdir(), 'joplin-import-'))
    const importFile = join(importDir, 'note.md')
    writeFileSync(importFile, '# 导入的标题\n\n正文内容。\n', 'utf8')
    try {
      const imported = await call('joplin_import_markdown', { file_path: importFile, notebook: '临时' })
      check('import_markdown: 标题取首行一级标题', () => {
        assert.equal(imported.title, '导入的标题')
        assert.equal(imported.notebook, '工作/临时')
        assert.ok(imported.bytes > 0)
      })
    } finally {
      rmSync(importDir, { recursive: true, force: true })
    }

    await callWrite('joplin_delete_note', { note_id: created.id, user_confirmed: true })
    const afterTrash = await call('joplin_search_notes', { query: '改名后的笔记' })
    check('delete_note: 默认进回收站（搜索不到）', () => assert.equal(afterTrash.count, 0))

    const permanentTarget = await call('joplin_create_note', { title: '待永久删除', notebook: '收件箱' })
    const deleted = await callWrite('joplin_delete_note', {
      note_id: permanentTarget.id,
      permanent: true,
      user_confirmed: true,
    })
    check('delete_note: permanent 真删', () => {
      assert.equal(deleted.permanent, true)
      assert.equal(server.state.notes.some((note) => note.id === permanentTarget.id), false)
    })

    await assert.rejects(() => call('joplin_get_note', { note_id: 'not-an-id' }), /note_id 不合法/)
    check('参数校验: 非法 note_id 被拦下', () => {})
    await assert.rejects(() => call('joplin_search_notes', {}), /query 与 notebook 至少要给一个/)
    check('参数校验: search 空参数被拦下', () => {})

    // --- 1b. 搜索接口故障时回退本地扫描 ---
    const localOnly = await call('joplin_search_notes', { query: '读书', mode: 'local' })
    check('search: mode=local 直接本地扫描', () => {
      assert.equal(localOnly.engine, 'local-scan')
      assert.equal(localOnly.results[0].id, seed.reading.id)
      assert.ok(localOnly.scanned >= 3, `scanned=${localOnly.scanned}`)
    })

    server.state.searchFails = true
    const fallbackSearch = await call('joplin_search_notes', { query: '会议' })
    check('search: 接口 500 时回退本地扫描', () => {
      assert.equal(fallbackSearch.engine, 'local-scan')
      assert.ok(fallbackSearch.fallback.includes('HTTP_ERROR'), `fallback=${fallbackSearch.fallback}`)
      assert.ok(fallbackSearch.results.some((item) => item.id === seed.meeting.id))
    })

    const afterFallback = await call('joplin_search_notes', { query: '排期' })
    check('search: 回退后 10 分钟内跳过故障接口', () => {
      assert.equal(afterFallback.engine, 'local-scan')
      assert.ok(afterFallback.results.some((item) => item.id === seed.meeting.id))
    })

    server.state.searchFails = false
    const forcedApi = await call('joplin_search_notes', { query: '会议', mode: 'api' })
    check('search: mode=api 忽略回退状态', () => {
      assert.equal(forcedApi.engine, 'api')
      assert.ok(forcedApi.results.some((item) => item.id === seed.meeting.id))
    })

    // --- 2. 配置文件层：env 清空后读 ~/.dsh/joplin.json ---
    const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-home-'))
    writeFileSync(
      join(fakeHome, 'joplin.json'),
      JSON.stringify({
        baseUrl: server.url,
        token: server.token,
        defaultNotebook: '收件箱',
        allowUpdate: true,
      }),
      'utf8',
    )
    try {
      delete process.env.JOPLIN_BASE_URL
      delete process.env.JOPLIN_TOKEN
      process.env.DSH_HOME = fakeHome
      tools = createJoplinTools({ baseUrl: '', token: '' })
      const fileStatus = await tools.find((tool) => tool.name === 'joplin_status').execute({}, makeExec('joplin_status', {}))
      check('配置层: 读取 ~/.dsh/joplin.json', () => {
        assert.equal(fileStatus.ok, true)
        assert.match(fileStatus.tokenSource, /配置文件/)
      })
      const defaultFolderNote = await tools
        .find((tool) => tool.name === 'joplin_create_note')
        .execute({ title: '默认笔记本笔记' }, makeExec('joplin_create_note', {}))
      check('配置层: defaultNotebook 生效', () => assert.equal(defaultFolderNote.notebook, '收件箱'))

      const fileTools = createJoplinTools({ allowUpdate: false })
      const fileStatus2 = await fileTools
        .find((tool) => tool.name === 'joplin_status')
        .execute({}, makeExec('joplin_status', {}))
      check('配置层: allowUpdate 由配置文件覆盖插件配置', () => {
        assert.equal(fileStatus2.capabilities.update.allowed, true)
        assert.match(fileStatus2.capabilities.update.source, /配置文件/)
        assert.equal(fileStatus2.capabilities.delete.allowed, false)
      })
      const fileUpdated = await fileTools
        .find((tool) => tool.name === 'joplin_update_note')
        .execute(
          { note_id: defaultFolderNote.id, title: '文件授权后可改', user_confirmed: true },
          makeExec('joplin_update_note', {}),
        )
      check('配置层: 文件授权后修改可用', () => assert.equal(fileUpdated.updated, true))
    } finally {
      rmSync(fakeHome, { recursive: true, force: true })
    }

    // --- 3. 缺 token 与端口不通：给出可操作提示而不是崩溃 ---
    process.env.DSH_HOME = join(tmpdir(), 'dsh-home-missing')
    delete process.env.JOPLIN_TOKEN
    delete process.env.JOPLIN_BASE_URL
    const missingTools = createJoplinTools({})
    const missingStatus = await missingTools.find((tool) => tool.name === 'joplin_status').execute({}, makeExec('joplin_status', {}))
    check('缺 token: status 明确提示', () => {
      assert.equal(missingStatus.ok, false)
      assert.equal(missingStatus.configured, false)
      assert.ok(missingStatus.hints.some((hint) => hint.includes('Web Clipper')))
    })
    await assert.rejects(
      () => missingTools.find((tool) => tool.name === 'joplin_list_notebooks').execute({}, makeExec('joplin_list_notebooks', {})),
      /尚未配置 Joplin API token/,
    )
    check('缺 token: 业务工具给出可操作错误', () => {})

    process.env.JOPLIN_BASE_URL = 'http://127.0.0.1:9'
    process.env.JOPLIN_TOKEN = 'whatever'
    const offlineTools = createJoplinTools({})
    const offlineStatus = await offlineTools.find((tool) => tool.name === 'joplin_status').execute({}, makeExec('joplin_status', {}))
    check('端口不通: status 给出连接提示', () => {
      assert.equal(offlineStatus.ok, false)
      assert.match(offlineStatus.error, /连不上 Joplin/)
    })

    console.log(results.join('\n'))
    console.log(`\n全部通过：${results.length} 项检查`)
  } finally {
    delete process.env.JOPLIN_BASE_URL
    delete process.env.JOPLIN_TOKEN
    delete process.env.DSH_HOME
    rmSync(isolatedHome, { recursive: true, force: true })
    await server.stop()
  }
}

main().catch((error) => {
  console.error(results.join('\n'))
  console.error('\n冒烟测试失败：', error)
  process.exitCode = 1
})
