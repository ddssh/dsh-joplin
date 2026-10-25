# dsh-joplin

**Joplin 笔记插件 for [DeepSeek Harness](https://github.com/deepseek-ai)** — 让 Agent 直接读写你本机的 Joplin 笔记：搜索、读全文、新建、笔记本管理、反向链接，默认只读、零运行时依赖。

[English](./README.md) · **简体中文** · [日本語](./README.ja.md) · [한국어](./README.ko.md)

[![npm version](https://img.shields.io/npm/v/dsh-joplin.svg)](https://www.npmjs.com/package/dsh-joplin)
[![npm downloads](https://img.shields.io/npm/dm/dsh-joplin.svg)](https://www.npmjs.com/package/dsh-joplin)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

---

## 特性

- **零依赖**：只用 Node 内置模块（`node:http` / `node:fs`），不需要 Python、uv、常驻子进程或构建步骤。
- **10 个工具**：搜索、读全文、新建笔记/笔记本、导入 Markdown、出链/反向链接、状态诊断。
- **默认最小权限**：新建默认开，**修改与删除默认关**；关闭时直接在发请求前拒绝，连 Joplin 都碰不到。
- **隐私优先**：只连你配置的本机地址，不上传、不埋点；并注册常驻提示词规则，禁止把笔记内容外发。
- **笔记本路径**：`工作/项目A` 这样的完整路径，也接受 id 或唯一标题，歧义时明确报错。
- **搜索兜底**：Joplin 全文搜索接口卡死时自动回退本地扫描，结果里标注 `engine`。
- **写入校验**：写完回读比对，正文被写坏时立即报错，而不是静默损坏。

## 环境要求

1. **Joplin 桌面端**已安装并在运行；
2. 「工具 → 选项 → Web Clipper」中启用 **Web Clipper 服务**（默认端口 `41184`）；
3. 在同一页面复制 **API token**；
4. DSH（DeepSeek Harness）Host 侧，Node.js **>= 20**。

> 仅支持 Joplin 桌面端的 Web Clipper 数据 API。Joplin Cloud / 移动端的接口不同，不适用。

## 安装

### 方式一：npm 官方源（[dsh-joplin](https://www.npmjs.com/package/dsh-joplin)）

```text
plugin_manager(action: "install_bundle", target: "dsh-joplin")
```

或者：

```bash
dsh plugin --profile <profile> add dsh-joplin
```

### 方式二：从 GitHub 安装

让 DSH 把仓库直接装进 profile：

```text
plugin_manager(action: "install_bundle", target: "github:ddssh/dsh-joplin")
```

### 方式三：本地目录安装

```bash
git clone https://github.com/ddssh/dsh-joplin.git
```

然后把该目录作为 `install_bundle` 的 `target` 传给 `plugin_manager`，或：

```bash
dsh plugin --profile <profile> add /absolute/path/to/dsh-joplin
```

安装后会注册 `joplin_*` 工具。纯 Host 插件无 Client 半部，通常无需重启 Harness；**修改插件 JS 后需要重启**（Node 会缓存已导入模块）。

## 配置

按优先级从三处解析，命中第一个非空值：

| 优先级 | 来源 | 说明 |
| --- | --- | --- |
| 1 | `~/.dsh/joplin.json` | **推荐**：改完立即生效，不必把 token 写进 profile YAML |
| 2 | 环境变量 `JOPLIN_TOKEN`、`JOPLIN_BASE_URL`、`JOPLIN_TIMEOUT_MS`、`JOPLIN_DEFAULT_NOTEBOOK`、`JOPLIN_ALLOW_CREATE` / `JOPLIN_ALLOW_UPDATE` / `JOPLIN_ALLOW_DELETE` | 需要重启 Harness 生效 |
| 3 | 插件配置（Settings / profile 的 `cordis.patch.yml`） | `baseUrl`、`token`、`timeoutMs`、`defaultNotebook`、`allowCreate`、`allowUpdate`、`allowDelete` |

最小配置：

```bash
cat > ~/.dsh/joplin.json <<'JSON'
{
  "token": "your-web-clipper-token",
  "baseUrl": "http://127.0.0.1:41184"
}
JSON
chmod 600 ~/.dsh/joplin.json
```

可选字段：`defaultNotebook`（新建笔记默认落点，如 `工作/项目A`）、`timeoutMs`、`allowCreate` / `allowUpdate` / `allowDelete`。

配好后先调用 `joplin_status`：它会告诉你 token 来自哪一层、服务是否可达、有几个笔记本。

## 工具

| 工具 | 作用 | 默认权限 |
| --- | --- | --- |
| `joplin_status` | 诊断：token 来源、连通性、笔记本数、最近更新 | 只读 |
| `joplin_list_notebooks` | 笔记本树 + 完整路径 + id | 只读 |
| `joplin_search_notes` | 关键词搜索（带摘要）；`query` 留空 + `notebook` 则列出该笔记本的笔记 | 只读 |
| `joplin_get_note` | 读全文：正文、笔记本、标签、内部链接 | 只读 |
| `joplin_find_linked_notes` | 按内部链接 `:/<id>` 查**出链 / 反向链接** | 只读 |
| `joplin_create_note` | 新建笔记（可指定笔记本 / 待办） | `allowCreate`（开） |
| `joplin_create_notebook` | 新建笔记本或子笔记本 | `allowCreate`（开） |
| `joplin_import_markdown` | 把本地 `.md` 文件导入成笔记 | `allowCreate`（开） |
| `joplin_update_note` | 改标题/正文/笔记本/待办，只改传入字段 | `allowUpdate`（**关**）+ `user_confirmed` |
| `joplin_delete_note` | 删除；默认进回收站，`permanent: true` 永久删除 | `allowDelete`（**关**）+ `user_confirmed` |

笔记本参数既接受 32 位 id，也接受唯一标题或完整路径（`工作/项目A`）；有歧义时报错并列出候选。

## 权限与隐私

### 三层写权限（默认最小权限）

| 能力 | 配置项 | 默认 |
| --- | --- | --- |
| 新建笔记 / 笔记本 / 导入 Markdown | `allowCreate` | **开** |
| 修改已有笔记（标题/正文/笔记本/待办） | `allowUpdate` | **关** |
| 删除笔记 | `allowDelete` | **关** |

- 关闭时工具**直接抛错，不发任何写请求**。
- 开启修改/删除后，调用方还必须传 `user_confirmed: true`（代表用户本轮明确要求过这条笔记）。
- 权限解析顺序为「配置文件 > 环境变量 > 插件配置 > 默认值」，收紧权限时不会被旧配置挡住。

```json
{ "token": "…", "allowUpdate": true }
```

### 隐私

- 只连接配置的 `baseUrl`（默认本机 `http://127.0.0.1:41184`），**不上传、无遥测**。
- 注册常驻提示词规则（`JOPLIN_NOTES`），要求笔记正文/摘要不得发往 web 搜索、浏览器、子代理或其它工具。
- 导入 Markdown 时文件内容只发往本机 Joplin。

## 已知问题（Joplin 侧）

在 Joplin 桌面端 **3.7.18** 上实测到两个服务端问题，插件均已规避：

1. **全文搜索会卡死**：`GET /search?query=…` 可能长时间不返回，而 `title:` 搜索、`/folders`、`/notes` 都正常。
   插件会在 8 秒后回退到本地扫描（260 篇笔记约 13ms），并在 10 分钟内跳过卡住的接口；也可用 `mode: "local"` 强制本地扫描。
2. **大正文写入会被写坏**：请求体含原始 UTF-8 多字节字符且较大时，正文里约每 16KB 出现一处 `U+FFFD`（与客户端无关，Python 也能复现）。
   插件统一把出站 JSON 做 ASCII 转义（`\uXXXX`），并**写入后回读比对**；不一致会抛 `WRITE_VERIFY_FAILED` 而不是静默损坏。

## 开发与测试

```bash
npm test          # 起一个内存版 mock Joplin，跑完 10 个工具
```

冒烟测试覆盖：笔记本树/路径解析、关键词搜索、按笔记本列笔记、读全文、出链/反链、增改删、建子笔记本、Markdown 导入、token 三层配置、权限闸门（修改/删除默认拒绝且不落盘、`user_confirmed` 校验）、搜索故障回退、ASCII 转义。

### 目录结构

```
dsh-joplin/
├── package.json          # bundle 清单：dsh.bundle.patch / icon / locale
├── cordis.patch.yml      # 插入 Host 插件行（id: dsh-joplin）
├── index.js              # Config（schemastery）+ apply：注册工具与提示词规则
├── joplin-tools.js       # 配置解析、笔记本解析、搜索/链接图谱、工具定义与渲染
├── joplin-client.js      # node:http 客户端（超时、错误翻译、ASCII 转义）
├── icon.svg / locale/    # 插件卡片展示
└── test/                 # mock Joplin 服务 + 冒烟测试
```

## 致谢

能力面参考了 [dweigend/joplin-mcp-server](https://github.com/dweigend/joplin-mcp-server)（Python + FastMCP 实现），本插件是面向 DSH 的原生 Node 重写：保留 CRUD、笔记本树、Markdown 导入与反向链接，补上权限闸门、搜索兜底与写入校验，并修正了原实现里笔记本路径在扁平返回时会退化的问题。

## License

[MIT](./LICENSE)
