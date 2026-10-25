# dsh-joplin

**Joplin notes plugin for [DeepSeek Harness](https://github.com/deepseek-ai)** — let the agent read and write your local Joplin notes: search, full-text read, create, notebook management, backlinks. Read-only by default, zero runtime dependencies.

**English** · [简体中文](./README.zh-CN.md) · [日本語](./README.ja.md) · [한국어](./README.ko.md)

[![npm version](https://img.shields.io/npm/v/dsh-joplin.svg)](https://www.npmjs.com/package/dsh-joplin)
[![npm downloads](https://img.shields.io/npm/dm/dsh-joplin.svg)](https://www.npmjs.com/package/dsh-joplin)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

---

## Features

- **Zero dependencies**: Node built-ins only (`node:http` / `node:fs`) — no Python, no uv, no long-running sidecar, no build step.
- **10 tools**: search, read full text, create notes/notebooks, import Markdown, outgoing/back links, diagnostics.
- **Least privilege by default**: create on, **update and delete off**; when a capability is off the tool throws *before* any request is sent, so Joplin is never touched.
- **Privacy first**: connects only to the local address you configure, no uploads, no telemetry; it also installs a standing prompt rule that forbids sending note content anywhere else.
- **Notebook paths**: accept full paths such as `Work/ProjectA`, ids, or unique titles; ambiguity is reported instead of guessed.
- **Search fallback**: when Joplin's full-text endpoint hangs, the plugin falls back to a local scan and marks the result with `engine`.
- **Write verification**: every write is read back and compared, so a corrupted body fails loudly instead of silently.

## Requirements

1. **Joplin desktop** installed and running;
2. The **Web Clipper service** enabled under "Tools → Options → Web Clipper" (default port `41184`);
3. The **API token** copied from that same page;
4. Node.js **>= 20** on the DSH (DeepSeek Harness) host side.

> Only Joplin desktop's Web Clipper data API is supported. Joplin Cloud and the mobile apps expose different APIs and do not work.

## Install

### Option 1: npm registry ([dsh-joplin](https://www.npmjs.com/package/dsh-joplin))

```text
plugin_manager(action: "install_bundle", target: "dsh-joplin")
```

or:

```bash
dsh plugin --profile <profile> add dsh-joplin
```

### Option 2: from GitHub

Have DSH install the repository into your profile directly:

```text
plugin_manager(action: "install_bundle", target: "github:ddssh/dsh-joplin")
```

### Option 3: local directory

```bash
git clone https://github.com/ddssh/dsh-joplin.git
```

Then pass that directory as `target` to `install_bundle`, or:

```bash
dsh plugin --profile <profile> add /absolute/path/to/dsh-joplin
```

The `joplin_*` tools are registered after install. This is a pure Host plugin with no client half, so a restart is usually unnecessary — but **restarting is required after editing the plugin's JS** (Node caches imported modules).

## Configuration

Settings are resolved from three layers, highest priority first, and the first non-empty value wins:

| Priority | Source | Notes |
| --- | --- | --- |
| 1 | `~/.dsh/joplin.json` | **Recommended**: takes effect immediately, keeps the token out of your profile YAML |
| 2 | Env vars `JOPLIN_TOKEN`, `JOPLIN_BASE_URL`, `JOPLIN_TIMEOUT_MS`, `JOPLIN_DEFAULT_NOTEBOOK`, `JOPLIN_ALLOW_CREATE` / `JOPLIN_ALLOW_UPDATE` / `JOPLIN_ALLOW_DELETE` | Requires a Harness restart |
| 3 | Plugin config (Settings / `cordis.patch.yml` in the profile) | `baseUrl`, `token`, `timeoutMs`, `defaultNotebook`, `allowCreate`, `allowUpdate`, `allowDelete` |

Minimal setup:

```bash
cat > ~/.dsh/joplin.json <<'JSON'
{
  "token": "your-web-clipper-token",
  "baseUrl": "http://127.0.0.1:41184"
}
JSON
chmod 600 ~/.dsh/joplin.json
```

Optional fields: `defaultNotebook` (where new notes go, e.g. `Work/ProjectA`), `timeoutMs`, and `allowCreate` / `allowUpdate` / `allowDelete`.

Once configured, call `joplin_status` first: it reports which layer the token came from, whether the service is reachable, and how many notebooks exist.

## Tools

| Tool | What it does | Default permission |
| --- | --- | --- |
| `joplin_status` | Diagnostics: token source, connectivity, notebook count, recent updates | read-only |
| `joplin_list_notebooks` | Notebook tree with full paths and ids | read-only |
| `joplin_search_notes` | Keyword search with snippets; empty `query` + `notebook` lists that notebook | read-only |
| `joplin_get_note` | Full note: body, notebook, tags, internal links | read-only |
| `joplin_find_linked_notes` | **Outgoing and back links** via internal links `:/<id>` | read-only |
| `joplin_create_note` | Create a note (optionally in a notebook, optionally a todo) | `allowCreate` (on) |
| `joplin_create_notebook` | Create a notebook or sub-notebook | `allowCreate` (on) |
| `joplin_import_markdown` | Import a local `.md` file as a note | `allowCreate` (on) |
| `joplin_update_note` | Change title/body/notebook/todo, only the fields you pass | `allowUpdate` (**off**) + `user_confirmed` |
| `joplin_delete_note` | Delete; to trash by default, permanent with `permanent: true` | `allowDelete` (**off**) + `user_confirmed` |

Notebook arguments accept a 32-character id, a unique title, or a full path (`Work/ProjectA`); ambiguous input raises an error listing the candidates.

## Permissions and privacy

### Three write permissions (least privilege by default)

| Capability | Setting | Default |
| --- | --- | --- |
| Create notes / notebooks / import Markdown | `allowCreate` | **on** |
| Modify existing notes (title/body/notebook/todo) | `allowUpdate` | **off** |
| Delete notes | `allowDelete` | **off** |

- When a capability is off, the tool **throws without sending any write request**.
- With update/delete enabled, the caller must additionally pass `user_confirmed: true`, meaning the user explicitly asked for that note in this turn.
- Resolution order is "config file > env vars > plugin config > defaults", so tightening a permission is never blocked by a stale setting.

```json
{ "token": "…", "allowUpdate": true }
```

### Privacy

- Connects only to the configured `baseUrl` (default `http://127.0.0.1:41184`), **no uploads, no telemetry**.
- Installs a standing prompt rule (`JOPLIN_NOTES`) requiring note bodies and snippets to stay away from web search, the browser, subagents, and other tools.
- Markdown imports send file contents only to the local Joplin instance.

## Known issues (Joplin side)

Both were reproduced on Joplin desktop **3.7.18**; the plugin works around them:

1. **Full-text search can hang**: `GET /search?query=…` may never return, while `title:` search, `/folders`, and `/notes` stay fast.
   The plugin falls back to a local scan after 8 seconds (about 13 ms for 260 notes) and skips the stuck endpoint for 10 minutes; `mode: "local"` forces the local scan.
2. **Large bodies get corrupted on write**: when the request body contains raw multi-byte UTF-8 and is large enough, roughly one `U+FFFD` appears per 16 KB of body text (client-independent; reproducible with Python as well).
   The plugin ASCII-escapes every outbound JSON payload (`\uXXXX`) and **reads the note back after writing**; a mismatch raises `WRITE_VERIFY_FAILED` instead of silently corrupting the note.

## Development and testing

```bash
npm test          # starts an in-memory mock Joplin and exercises all 10 tools
```

The smoke test covers notebook tree/path resolution, keyword search, listing notes by notebook, full-text read, outgoing/back links, create/update/delete, sub-notebook creation, Markdown import, the three configuration layers, the permission gates (update/delete refused by default without touching disk, `user_confirmed` validation), search failure fallback, and ASCII escaping.

### Layout

```
dsh-joplin/
├── package.json          # bundle manifest: dsh.bundle.patch / icon / locale
├── cordis.patch.yml      # inserts the Host plugin row (id: dsh-joplin)
├── index.js              # Config (schemastery) + apply: tools and prompt rules
├── joplin-tools.js       # settings resolution, notebook resolution, search/link graph, tool definitions
├── joplin-client.js      # node:http client (timeouts, error translation, ASCII escaping)
├── icon.svg / locale/    # plugin card presentation
└── test/                 # mock Joplin server + smoke test
```

## Credits

The capability set follows [dweigend/joplin-mcp-server](https://github.com/dweigend/joplin-mcp-server) (Python + FastMCP). This plugin is a native Node rewrite for DSH: it keeps CRUD, the notebook tree, Markdown import, and backlinks, and adds permission gates, search fallback, and write verification, while fixing the original's notebook-path degradation when the API returns a flat list.

## License

[MIT](./LICENSE)
