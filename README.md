# @kmchai/cortico-world-service

Kmch AI · 服务:托管本机推理服务，并把它们收在一条 OpenAI 形状的语音接口后面。audiocpp 只是其中一种后端。

0.1.0 有通用进程托管与多条目编排，也有统一网关：`/health`、`/v1/models`、`/v1/audio/voices`、`/v1/audio/speech`、`/v1/audio/sing` 都接在同一组服务条目上。模型差异用数据 profile 表达，新增模型多数只加配置。

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
          "label": "audiocpp",
          "kind": "audiocpp",
          "protocol": "audiocpp",
          "enabled": true,
          "manage": true,
          "autoStart": true,
          "restartOnExit": true,
          "host": "127.0.0.1",
          "port": 8000,
          "serverDir": "D:/AI/audio-v0.9.3-bin-windows-x64-cuda13.3",
          "options": { "backend": "cuda", "device": 0, "ui": true }
        },
        {
          "id": "qwen-tts",
          "kind": "custom",
          "protocol": "openai",
          "enabled": true,
          "manage": true,
          "autoStart": false,
          "restartOnExit": true,
          "host": "127.0.0.1",
          "port": 9010,
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
| `host` | `127.0.0.1` | 服务网关监听地址；非回环地址需要令牌 |
| `port` | `9883` | 服务网关端口 |
| `tokenSecret` | 空 | 部署 `.env` 里的令牌变量名；空 = 本机免认证 |
| `allowQueryToken` | `false` | 也接受 `?token=`；默认只认 Authorization 头 |
| `requestTimeoutSec` | `180` | 上游请求超时 |
| `defaultSpeechModel` | 空 | 请求不带 `model` 时用；空 = 按服务顺序取第一个可用模型 |

### 服务条目

| 字段 | 说明 |
|---|---|
| `id` | 条目唯一 id；日志文件按它命名 |
| `label` | 显示名 |
| `kind` | `audiocpp` / `llamacpp` / `systemone` / `svc` / `custom`；决定启动预设 |
| `protocol` | `audiocpp` / `openai` / `custom` / `sing` / `none`；决定 HTTP 方言，`none` 只托管进程 |
| `enabled` | 参与启动与探活 |
| `manage` | `false` 只探活，不拉起进程 |
| `autoStart` | World 启动时一并拉起 |
| `restartOnExit` | 非预期退出后按 5s / 15s / 60s 退避重启，最多 3 次 |
| `host` / `port` | 服务地址；audiocpp 端口默认 8000 |
| `baseUrl` | 远程端点；非空时优先于 host:port |
| `healthPath` | 探活路径；默认 `/health` |
| `serverDir` | 可执行文件目录，也是进程工作目录 |
| `binary` | 可执行文件；相对路径按 serverDir 解析 |
| `configPath` | audiocpp 的 `server.json` 路径 |
| `args` | 追加参数，按空白分隔（支持引号） |
| `secretName` | 上游 Bearer token 的 `.env` 变量名 |
| `modelProfile` | `auto` 或模型 profile id |
| `modelProfiles` | 模型 profile 覆盖，按 profile id 键；只存覆盖字段 |
| `models` | 空 = 从 `/v1/models` 现取 |
| `options` | 该服务的默认 options；audiocpp 预设读取 `backend`、`device`、`threads`、`idleUnloadMs`、`ui`、`pollMs`、`startTimeoutSec` |

### 启动预设

- `audiocpp`：默认 `audiocpp_server(.exe)`，参数 `--config --host --port --backend --device --threads --idle-unload-ms --no-ui` 加 `args`。
- `llamacpp`：默认 `llama-server(.exe)`，只用条目自己的 `args`。只想跑 LLM 时用框架内建的 llamacpp provider，不要在这里重复托管。
- `systemone` / `svc` / `custom`：操作者给 `binary` 与 `args`；`custom` 不要求任何 audiocpp 字段。

启动前先探 `healthPath`：已经活着就接管，不重复拉起。停止时结束子进程。服务输出写到 `dataDir/service-<id>.log`。

## HTTP 网关

默认 `http://127.0.0.1:9883`，由 World 启停。只认这五条路由，不代理 LLM 的 chat/responses。

| 路由 | 说明 |
|---|---|
| `GET /health` | `{status, ready, version, uptimeSec, services[], models}`；模型数是发现到的目录条数 |
| `GET /v1/models` | OpenAI 形状；每项带 `service`、`tasks` 与已知音色 |
| `GET /v1/audio/voices?model=&service=` | 返回 `{object, model, voices[], data[]}` |
| `POST /v1/audio/speech` | `{model?, input, voice?, response_format?, speed?, instructions?, emotion?, language?, options?}` |
| `POST /v1/audio/sing` | `{model?, lyrics}`；路由到 `protocol: 'sing'` 的条目 |

- 令牌：配置只存 `tokenSecret` 名字，值从部署 `.env` 读。非回环地址没有令牌、或变量名为空值，网关拒绝启动。`allowQueryToken: true` 时才接受 `?token=`。
- 限额：请求体 1 MiB，`input` 8000 字，`instructions` 2000 字，`options` 16 KiB。
- 错误：JSON `{error:{message,type,code,param}}`；400/401/404/413/429/502/503/504，503 带 `Retry-After: 2`。
- 不接收 `play`，不排队、不重试上游；重复请求由客户端决定。
- 音频回应带 `content-type`、`content-length`，WAV 可算时长时带 `x-voice-seconds`。

## 模型 profile

内置 `openai`、`audiocpp-ming3`、`custom`、`sing`。解析顺序：条目 `modelProfile` → 模型 id 前缀/通配匹配 → `openai` 兜底。面板的「模型 profile 覆盖」写进条目的 `modelProfiles`，只存覆盖字段。

- `audiocpp-ming3`：有 `instructions` → `options.template_name='freeform'` 并带上指令；否则有 `emotion` → `emotion`；否则有 `speed` → `basic`，按 `speedLevels` 取慢速/中速/快速，pitch 与 volume 为中。
- profile 的 `fields` 把语义字段映射到上游 JSON 字段；`variants` 用 `when.has` / `when.not` 选第一个匹配项，`set` 里的 `{{field}}` 用请求值替换；`options` 声明类型、枚举与默认值；`defaults` 是请求体默认字段。
- 条目 `options` 里只有 profile 声明过的名字会进请求体；启动参数与协议设置不会混进去。

### 发现

- `GET /v1/models` 取模型；audiocpp 另读 `server.json` 与 `model_specs/*.json`（单文件 ≤ 2 MiB，`schema_version=1`，`category='tts'`）。
- `GET /v1/audio/voices?model=` 覆盖静态音色。
- 读不到时保留上次目录并标 stale；不会让服务本身失败。

### 协议设置

`custom` 条目读 `options.url`、`path`、`method`、`headers`、`body`、`response`（`audio`/`base64`/`url`）、`audioPath`；`headers` 里的 `${KEY}` 换成 `secretName` 的值。`sing` 条目读 `options.path`，默认 `/sing`。

## 状态

World 页有三只灯：网关、服务在线数 / 总数、模型总数；徽标显示网关端口与服务条目数。状态变化推只归档的事件：

- `service.started`、`service.stopped`、`service.failed`，都带 `deliver: false`，不占模型上下文。

## 服务面板

World 页的「服务」面板分「服务列表」与「网关」两段：

- 服务列表：条目状态灯、启动 / 停止 / 重启 / 探活、增删改与排序、模型发现、日志尾部、条目令牌。
- 网关：状态、地址、端口、在线数、令牌与默认模型；令牌只显示「已设置 / 未设置」。

`services` 数组由面板经 `WorldContext.persist` 整体写回；写入前校验 id、端口与重复端口。命令与参数只按 argv 交给 `spawn`，不经过 shell。`setToken` 只回 `{ tokenSet }`，值写部署 `.env`，从不出现在响应里。

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
