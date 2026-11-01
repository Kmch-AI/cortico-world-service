# @kmchai/cortico-world-service

Kmch AI · 服务:托管本机推理服务，并把它们收在一条 OpenAI 形状的语音接口后面。audiocpp 只是其中一种后端。

0.2.0 有通用进程托管与多条目编排，也有统一网关：`/health`、`/v1/models`、`/v1/audio/voices`、`/v1/audio/speech`、`/v1/audio/sing` 都接在同一组服务条目上。条目只填名称与端点，协议、主机端口与健康路径由类型推导；模型差异用数据 profile 表达，新增模型多数只加配置。

## 为什么是 World，不是 provider

Cortico 的 provider 契约是「LLM 端点方言」：`respond()` 产出 Responses 流。audiocpp 等音频推理服务没有 chat/responses 端点，套不进这个契约；进程托管在框架里本来就是 World 的职责。服务 World 不合成、不播放、不排队，也不给模型工具。

## 安装

```bash
# 在部署的 extensions/ 目录里
corepack pnpm add "D:/path/to/cortico-world-service" --ignore-workspace
```

或在控制台「扩展」页选「从本机目录安装」，装完重启进程。启用 `worlds.service.enabled`。

## 配置

```jsonc
{
  "worlds": {
    "service": {
      "enabled": true,
      "host": "127.0.0.1",
      "port": 9883,
      "tokenSecret": "",
      "allowQueryToken": false,
      "requestTimeoutSec": 180,
      "defaultSpeechModel": "",
      "services": [
        {
          "id": "audiocpp",
          "name": "audiocpp",
          "type": "audiocpp",
          "enabled": true,
          "endpoint": "http://127.0.0.1:8000",
          "manage": true,
          "autoStart": true,
          "restartOnExit": true,
          "serverDir": "D:/AI/audio-v0.9.3-bin-windows-x64-cuda13.3",
          "options": { "backend": "cuda", "device": 0, "ui": true }
        },
        {
          "id": "qwen-tts",
          "name": "Qwen TTS",
          "type": "openai",
          "enabled": true,
          "endpoint": "http://127.0.0.1:9010",
          "manage": true,
          "autoStart": false,
          "restartOnExit": true,
          "binary": "C:/tools/tts-server.exe",
          "args": "--port 9010 --model qwen"
        }
      ]
    }
  }
}
```

`services` 是数组，标准配置表单渲染不了，也不在 ConfigGroup 里；它由服务面板整体写回 `worlds.service.services`。

### 标量配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 启用这个 World |
| `host` | `127.0.0.1` | 服务网关监听地址；只在配置文件里改，非回环地址需要令牌 |
| `port` | `9883` | 服务网关端口 |
| `tokenSecret` | 空 | 部署 `.env` 里的令牌变量名；空 = 本机免认证 |
| `allowQueryToken` | `false` | 也接受 `?token=`；默认只认 Authorization 头 |
| `requestTimeoutSec` | `180` | 上游请求超时 |
| `defaultSpeechModel` | 空 | 请求不带 `model` 时用；空 = 按服务顺序取第一个可用模型 |

`host` 不在标准表单里；要改就编辑配置文件。

### 服务条目

用户只填 `name` 与 `endpoint`；`id`、协议、主机端口、健康路径都由服务端推导。

| 字段 | 说明 |
|---|---|
| `id` | 服务端生成的稳定键；日志、状态与 API 路径用它，不可手填、不可修改 |
| `name` | 用户填写的显示名，也是唯一身份；面板与状态事件都用它 |
| `type` | `audiocpp` / `openai` / `sing` / `llamacpp` / `systemone` / `svc` / `custom`；决定协议与启动预设 |
| `enabled` | 参与启动与探活 |
| `endpoint` | 一个 URL，例如 `http://127.0.0.1:8000`、`https://host/v1`；无协议按 http |
| `manage` | `false` 只探活，不拉起进程；`true` 时没有预设的类型必须给 `binary` |
| `autoStart` | World 启动时一并拉起 |
| `restartOnExit` | 非预期退出后按 5s / 15s / 60s 退避重启，最多 3 次 |
| `serverDir` | 可执行文件目录，也是进程工作目录 |
| `binary` | 可执行文件；相对路径按 serverDir 解析 |
| `args` | 追加参数，按空白分隔（支持引号） |
| `secretName` | 上游 Bearer token 的 `.env` 变量名 |
| `modelProfile` | `auto` 或模型 profile id |
| `models` | 空 = 从 `/v1/models` 现取 |
| `options` | 该服务的默认 options；audiocpp 预设读取 `backend`、`device`、`threads`、`idleUnloadMs`、`ui`、`pollMs`、`startTimeoutSec` |

### 类型推导

| `type` | 协议 | 默认端口 |
|---|---|---|
| `audiocpp` | `audiocpp` | 8000 |
| `openai` | `openai` | https 443，否则 80 |
| `sing` | `sing` | 9882 |
| `svc` | `sing` | 9882 |
| `systemone` | `openai` | https 443，否则 80 |
| `llamacpp` | `none`（只托管进程） | 按协议 |
| `custom` | `custom` | 按协议 |

- 端点缺主机时按 `127.0.0.1`；缺端口时按上表补。
- 健康路径固定 `/health`，只有 `llamacpp` 不探活；`openai` / `custom` 的 `/health` 回 404 时改探 `/v1/models`。
- audiocpp 的配置文件固定读 `<serverDir>/server.json`。

### id 生成

面板新增服务时由服务端生成 `id`：ASCII 名字取 slug（`My TTS` → `my-tts`），中文或空名字取 `<type>-<序号>`（`custom-1`）；与已有 id 冲突时追加序号。创建时传入的 `id` 会被忽略，更新时不允许修改。

### 启动预设

- `audiocpp`：默认 `audiocpp_server(.exe)`，参数 `--config --host --port --backend --device --threads --idle-unload-ms --no-ui` 加 `args`；`--host` / `--port` 来自 `endpoint`。
- `llamacpp`：默认 `llama-server(.exe)`，只用条目自己的 `args`。只想跑 LLM 时用框架内建的 llamacpp provider，不要在这里重复托管。
- `systemone` / `svc` / `custom` / `openai` / `sing`：操作者给 `binary` 与 `args`。

启动前先探活：已经活着就接管，不重复拉起。停止时结束子进程。服务输出写到 `dataDir/service-<id>.log`。

## HTTP 网关

默认 `http://127.0.0.1:9883`，由 World 启停。只认这五条路由，不代理 LLM 的 chat/responses。

| 路由 | 说明 |
|---|---|
| `GET /health` | `{status, ready, version, uptimeSec, services[], models}`；模型数是发现到的目录条数 |
| `GET /v1/models` | OpenAI 形状；每项带 `service`、`display_name`、`tasks`、`voices` 与请求参数元数据 `parameters` |
| `GET /v1/audio/voices?model=&service=` | 返回 `{object, model, voices[], data[]}` |
| `POST /v1/audio/speech` | `{model?, input, voice?, response_format?, speed?, instructions?, emotion?, language?, options?}` |
| `POST /v1/audio/sing` | `{model?, lyrics}`；路由到 `type: 'sing'` / `'svc'` 的条目 |

- 令牌：配置只存 `tokenSecret` 名字，值从部署 `.env` 读。非回环地址没有令牌、或变量名为空值，网关拒绝启动。`allowQueryToken: true` 时才接受 `?token=`。
- 限额：请求体 1 MiB，`input` 8000 字，`instructions` 2000 字，`options` 16 KiB。
- 错误：JSON `{error:{message,type,code,param}}`；400/401/404/413/429/502/503/504，503 带 `Retry-After: 2`。
- 不接收 `play`，不排队、不重试上游；重复请求由客户端决定。
- 音频回应带 `content-type`、`content-length`，WAV 可算时长时带 `x-voice-seconds`。

## 模型 profile

内置 `openai`、`audiocpp-ming3`、`audiocpp-indextts2`、`custom`、`sing`。解析顺序：条目 `modelProfile` → 模型 id 前缀/通配匹配 → `openai` 兜底（`custom` 类型兜底到 `custom`）。

- `audiocpp-ming3`：有 `instructions` → `options.template_name='freeform'` 并带上指令；否则有 `emotion` → `emotion`；否则有 `speed` → `basic`，按 `speedLevels` 取慢速/中速/快速，pitch 与 volume 为中。
- `audiocpp-indextts2`：`index-tts2` / `index_tts2` / 2.5 走这个 profile；有 `instructions` → `options.use_emotion_text=true` 且 `emotion_text` 取指令，否则有 `emotion` → 同样写入 `emotion_text`。`speed` 不映射到 `duration_scale`。
- profile 的 `fields` 把语义字段映射到上游 JSON 字段；`variants` 用 `when.has` / `when.not` 选第一个匹配项，`set` 里的 `{{field}}` 用请求值替换；`options` 声明类型、枚举与默认值；`defaults` 是请求体默认字段。
- 条目 `options` 里只有 profile 声明过的名字会进请求体；启动参数与协议设置不会混进去。

### 发现

- `GET /v1/models` 取模型；audiocpp 另读 `server.json` 声明的模型（没有 `server.json` 时只用 `/v1/models`）。
- `model_specs/*.json` 只按模型 family/id 补元数据（显示名、任务、音色、`options.request` 参数），不会新增模型；单文件 ≤ 2 MiB，只认 `category='tts'`，带 `schema_version` 时必须是 1。
- `GET /v1/audio/voices?model=` 覆盖静态音色。
- 读不到时保留上次目录并标 stale；不会让服务本身失败。

### 协议设置

`custom` 条目读 `options.url`（优先于 `endpoint`）、`path`（追加到 `endpoint` 后）、`method`、`headers`、`body`、`response`（`audio`/`base64`/`url`）、`audioPath`；`headers` 里的 `${KEY}` 换成 `secretName` 的值。`sing` 条目读 `options.path`，默认 `/sing`。

## 状态

World 页有三只灯：网关、服务在线数 / 总数、模型总数；徽标显示网关端口与服务条目数。状态变化推只归档的事件：

- `service.started`、`service.stopped`、`service.failed`，都带 `deliver: false`，不占模型上下文。

## 服务面板

World 页只有「服务」一个面板，也不再声明配置组。面板是主从视图：

- 顶部选单列出「网关」与每个服务名，旁边是「添加」。
- 网关：只读状态与端口、令牌变量名 / 令牌值、查询参数令牌、超时、默认语音模型；一次「保存」经 `saveGateway` 写回标量。端口、主机与令牌变量改动只标「需要重启」，不在这里重启 World。
- 服务：只读状态与名称、类型、地址、四个开关；托管时出现服务目录、可执行文件与参数；密钥变量名、模型 profile、模型表与 Options JSON 收在默认折叠的「高级」里。动作有启动 / 停止 / 重启 / 探活 / 日志 / 删除与上移 / 下移。

`id` 不在任何表单里，新增时由服务端生成；`type` 决定协议、默认端口与健康路径，面板不再显示协议或健康路径。`services` 数组由面板经 `WorldContext.persist` 整体写回；写入前校验名称、类型、端点与重复 id。命令与参数只按 argv 交给 `spawn`，不经过 shell。`setToken` 只回 `{ tokenSet }`，值写部署 `.env`，从不出现在响应里。

面板 bundle 由 `pnpm build:webui` 生成：

```bash
pnpm build:webui   # dist/webui.js + dist/webui.css
```

## 验证

```bash
pnpm typecheck
pnpm test
pnpm build:webui
pnpm smoke:host "D:/AI/audio-v0.9.3-bin-windows-x64-cuda13.3" 8018
```

`smoke:host` 用真的 `audiocpp_server` 拉起、探活、停止一次，打印三个阶段的 status。

## 许可

MIT。
