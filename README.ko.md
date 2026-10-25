# dsh-joplin

**[DeepSeek Harness](https://github.com/deepseek-ai)용 Joplin 노트 플러그인** — 에이전트가 로컬 Joplin 노트를 직접 읽고 쓸 수 있게 합니다. 검색, 전문 읽기, 생성, 노트북 관리, 백링크를 지원하며 기본 설정은 읽기 전용이고 런타임 의존성은 없습니다.

[English](./README.md) · [简体中文](./README.zh-CN.md) · [日本語](./README.ja.md) · **한국어**

[![npm version](https://img.shields.io/npm/v/dsh-joplin.svg)](https://www.npmjs.com/package/dsh-joplin)
[![npm downloads](https://img.shields.io/npm/dm/dsh-joplin.svg)](https://www.npmjs.com/package/dsh-joplin)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

---

## 기능

- **의존성 없음**: Node 내장 모듈(`node:http` / `node:fs`)만 사용합니다. Python도, uv도, 상시 실행되는 사이드카도, 빌드 단계도 필요 없습니다.
- **도구 10개**: 검색, 전문 읽기, 노트/노트북 생성, Markdown 가져오기, 나가는 링크/백링크, 상태 진단.
- **기본 최소 권한**: 생성은 켜져 있고 **수정과 삭제는 꺼져 있습니다**. 권한이 꺼져 있으면 요청을 보내기 *전에* 오류를 던지므로 Joplin은 전혀 건드려지지 않습니다.
- **프라이버시 우선**: 설정한 로컬 주소에만 접속하며 업로드도 텔레메트리도 없습니다. 노트 내용을 외부로 보내지 못하게 하는 상시 프롬프트 규칙도 함께 등록합니다.
- **노트북 경로**: `Work/ProjectA` 같은 전체 경로, id, 고유 제목을 모두 받아들이고, 모호한 경우 추측하지 않고 오류로 알립니다.
- **검색 폴백**: Joplin의 전문 검색 엔드포인트가 멈추면 로컬 스캔으로 폴백하고 결과에 `engine`을 표시합니다.
- **쓰기 검증**: 모든 쓰기는 다시 읽어 비교하므로 본문이 손상되면 조용히 넘어가지 않고 즉시 오류를 냅니다.

## 요구 사항

1. **Joplin 데스크톱**이 설치되어 실행 중이어야 합니다.
2. "도구 → 옵션 → Web Clipper"에서 **Web Clipper 서비스**가 활성화되어 있어야 합니다(기본 포트 `41184`).
3. 같은 페이지에서 복사한 **API token**이 필요합니다.
4. Node.js **>= 20**이 DSH(DeepSeek Harness) 호스트 측에 있어야 합니다.

> Joplin 데스크톱의 Web Clipper 데이터 API만 지원합니다. Joplin Cloud와 모바일 앱은 다른 API를 제공하므로 동작하지 않습니다.

## 설치

### 방법 1: npm 레지스트리([dsh-joplin](https://www.npmjs.com/package/dsh-joplin))

```text
plugin_manager(action: "install_bundle", target: "dsh-joplin")
```

또는:

```bash
dsh plugin --profile <profile> add dsh-joplin
```

### 방법 2: GitHub에서 설치

DSH가 저장소를 프로필에 직접 설치하도록 합니다:

```text
plugin_manager(action: "install_bundle", target: "github:ddssh/dsh-joplin")
```

### 방법 3: 로컬 디렉터리에서 설치

```bash
git clone https://github.com/ddssh/dsh-joplin.git
```

그런 다음 해당 디렉터리를 `install_bundle`의 `target`으로 전달하거나:

```bash
dsh plugin --profile <profile> add /absolute/path/to/dsh-joplin
```

설치가 끝나면 `joplin_*` 도구가 등록됩니다. 클라이언트 쪽이 없는 순수 Host 플러그인이므로 보통은 재시작이 필요 없지만, **플러그인의 JS를 수정한 뒤에는 재시작이 필요합니다**(Node가 가져온 모듈을 캐시하기 때문입니다).

## 설정

설정은 우선순위가 높은 순서대로 세 계층에서 해석하며, 비어 있지 않은 첫 값이 적용됩니다.

| 우선순위 | 출처 | 비고 |
| --- | --- | --- |
| 1 | `~/.dsh/joplin.json` | **권장**: 즉시 적용되고 token을 profile YAML에 남기지 않아도 됩니다 |
| 2 | 환경 변수 `JOPLIN_TOKEN`, `JOPLIN_BASE_URL`, `JOPLIN_TIMEOUT_MS`, `JOPLIN_DEFAULT_NOTEBOOK`, `JOPLIN_ALLOW_CREATE` / `JOPLIN_ALLOW_UPDATE` / `JOPLIN_ALLOW_DELETE` | Harness 재시작이 필요합니다 |
| 3 | 플러그인 설정(Settings / profile의 `cordis.patch.yml`) | `baseUrl`, `token`, `timeoutMs`, `defaultNotebook`, `allowCreate`, `allowUpdate`, `allowDelete` |

최소 설정:

```bash
cat > ~/.dsh/joplin.json <<'JSON'
{
  "token": "your-web-clipper-token",
  "baseUrl": "http://127.0.0.1:41184"
}
JSON
chmod 600 ~/.dsh/joplin.json
```

선택 필드: `defaultNotebook`(새 노트가 저장될 위치, 예: `Work/ProjectA`), `timeoutMs`, `allowCreate` / `allowUpdate` / `allowDelete`.

설정을 마쳤으면 먼저 `joplin_status`를 호출하세요. token이 어느 계층에서 왔는지, 서비스에 접속할 수 있는지, 노트북이 몇 개인지 알려줍니다.

## 도구

| 도구 | 하는 일 | 기본 권한 |
| --- | --- | --- |
| `joplin_status` | 진단: token 출처, 연결 상태, 노트북 수, 최근 업데이트 | 읽기 전용 |
| `joplin_list_notebooks` | 전체 경로와 id가 포함된 노트북 트리 | 읽기 전용 |
| `joplin_search_notes` | 요약이 포함된 키워드 검색. `query`가 비어 있고 `notebook`이 주어지면 해당 노트북의 노트를 나열 | 읽기 전용 |
| `joplin_get_note` | 노트 전체: 본문, 노트북, 태그, 내부 링크 | 읽기 전용 |
| `joplin_find_linked_notes` | 내부 링크 `:/<id>`를 통한 **나가는 링크와 백링크** | 읽기 전용 |
| `joplin_create_note` | 노트 생성(노트북과 할 일 여부를 선택적으로 지정) | `allowCreate`(켜짐) |
| `joplin_create_notebook` | 노트북 또는 하위 노트북 생성 | `allowCreate`(켜짐) |
| `joplin_import_markdown` | 로컬 `.md` 파일을 노트로 가져오기 | `allowCreate`(켜짐) |
| `joplin_update_note` | 제목/본문/노트북/할 일 변경, 전달한 필드만 수정 | `allowUpdate`(**꺼짐**) + `user_confirmed` |
| `joplin_delete_note` | 삭제. 기본은 휴지통으로 이동, `permanent: true`이면 영구 삭제 | `allowDelete`(**꺼짐**) + `user_confirmed` |

노트북 인수는 32자 id, 고유 제목, 전체 경로(`Work/ProjectA`)를 받아들이며, 모호한 입력은 후보 목록을 담은 오류를 발생시킵니다.

## 권한과 프라이버시

### 세 가지 쓰기 권한(기본 최소 권한)

| 기능 | 설정 | 기본값 |
| --- | --- | --- |
| 노트 / 노트북 생성, Markdown 가져오기 | `allowCreate` | **켜짐** |
| 기존 노트 수정(제목/본문/노트북/할 일) | `allowUpdate` | **꺼짐** |
| 노트 삭제 | `allowDelete` | **꺼짐** |

- 기능이 꺼져 있으면 도구는 **쓰기 요청을 전혀 보내지 않고 오류를 던집니다**.
- 수정/삭제를 켠 경우에도 호출 측은 `user_confirmed: true`를 추가로 전달해야 하며, 이는 사용자가 이번 턴에 해당 노트를 명시적으로 요청했다는 뜻입니다.
- 해석 순서가 "설정 파일 > 환경 변수 > 플러그인 설정 > 기본값"이므로, 권한을 좁히는 설정이 낡은 값 때문에 막히는 일은 없습니다.

```json
{ "token": "…", "allowUpdate": true }
```

### 프라이버시

- 설정된 `baseUrl`(기본값 `http://127.0.0.1:41184`)에만 접속하며 **업로드도 텔레메트리도 없습니다**.
- 노트 본문과 요약이 웹 검색, 브라우저, 서브에이전트, 다른 도구로 나가지 않도록 요구하는 상시 프롬프트 규칙(`JOPLIN_NOTES`)을 등록합니다.
- Markdown 가져오기는 파일 내용을 로컬 Joplin 인스턴스로만 전송합니다.

## 알려진 문제(Joplin 측)

두 문제 모두 Joplin 데스크톱 **3.7.18**에서 재현되었으며, 플러그인이 이를 우회합니다.

1. **전문 검색이 멈출 수 있습니다**: `GET /search?query=…`가 끝내 반환되지 않는 경우가 있는 반면, `title:` 검색과 `/folders`, `/notes`는 계속 빠르게 동작합니다.
   플러그인은 8초 뒤 로컬 스캔으로 폴백하고(노트 260개 기준 약 13ms), 멈춘 엔드포인트는 10분 동안 건너뜁니다. `mode: "local"`은 로컬 스캔을 강제합니다.
2. **큰 본문은 쓰기 과정에서 손상됩니다**: 요청 본문에 원시 멀티바이트 UTF-8이 포함되어 있고 크기가 충분히 크면, 본문 텍스트 16KB당 대략 하나의 `U+FFFD`가 나타납니다(클라이언트와 무관하며 Python으로도 재현됩니다).
   플러그인은 나가는 모든 JSON 페이로드를 ASCII 이스케이프(`\uXXXX`)로 변환하고 **쓰기 후에 노트를 다시 읽어** 비교합니다. 일치하지 않으면 노트를 조용히 손상시키는 대신 `WRITE_VERIFY_FAILED`를 발생시킵니다.

## 개발 및 테스트

```bash
npm test          # starts an in-memory mock Joplin and exercises all 10 tools
```

스모크 테스트는 노트북 트리/경로 해석, 키워드 검색, 노트북별 노트 나열, 전문 읽기, 나가는 링크/백링크, 생성/수정/삭제, 하위 노트북 생성, Markdown 가져오기, 세 가지 설정 계층, 권한 게이트(수정/삭제가 기본적으로 디스크를 건드리지 않고 거부되는지, `user_confirmed` 검증), 검색 실패 시 폴백, ASCII 이스케이프를 다룹니다.

### 디렉터리 구조

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

## 크레딧

이 플러그인의 기능 구성은 [dweigend/joplin-mcp-server](https://github.com/dweigend/joplin-mcp-server)(Python + FastMCP)를 따릅니다. 이 플러그인은 DSH를 위한 네이티브 Node 재작성으로, CRUD, 노트북 트리, Markdown 가져오기, 백링크를 유지하면서 권한 게이트, 검색 폴백, 쓰기 검증을 추가했고, API가 평면 목록을 반환할 때 원본의 노트북 경로가 무너지던 문제도 수정했습니다.

## 라이선스

[MIT](./LICENSE)
