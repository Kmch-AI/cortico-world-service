# @kmchai/cortico-world-service

Kmch AI · 服务：本机推理服务的进程托管与统一网关。托管 audiocpp、llama.cpp 与 StartLux Decision，提供语音合成、唱歌、嵌入、重排与 SystemOne 接口；模型、权重与运行环境由你准备。

0.9.0 有通用进程托管与多条目编排，也有统一网关：`/health`、`/v1/models`、`/v1/audio/voices`、`/v1/audio/speech`、`/v1/audio/sing`、`/v1/systemone`、`/v1/embeddings`、`/v1/rerank` 都接在同一组服务条目上。一个条目就是一个模型部署；`tasks` 决定 llama.cpp 条目接 `embeddings` / `rerank`。llama.cpp 只有两种启动方式：多模型扫描一个 GGUF 目录，单模型从目录里选一个文件。StartLux Decision 是独立服务类型：它启动 `startlux-decide`，把 typed systemone 请求代理到一条 llama.cpp 条目的 GGUF 上；条目地址就是 `/v1/systemone` 端口。外部 SystemOne 服务仍用 `type: systemone`。audiocpp 的默认端口是 8080。

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
          "endpoint": "http://127.0.0.1:8080",
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
        },
        {
          "id": "startlux-gguf",
          "name": "StartLux GGUF",
          "type": "llamacpp",
          "enabled": true,
          "endpoint": "http://127.0.0.1:8082",
          "manage": true,
          "autoStart": true,
          "restartOnExit": true,
          "serverDir": "D:/AI/llama-b12090-bin-win-cpu-x64",
          "args": "--ctx-checkpoints 0 -b 16384 -ub 16384",
          "tasks": ["chat"],
          "models": ["StartLux-Decision-v1.1-0.8B-Instant-Q8_0"],
          "options": {
            "launchMode": "single",
            "modelsDir": "D:/AI/llama-b12090-bin-win-cpu-x64/models",
            "contextSize": 20480,
            "nGpuLayers": "99",
            "parallel": 1,
            "cacheDir": "D:/models/cache"
          }
        },
        {
          "id": "startlux-decision",
          "name": "StartLux Decision",
          "type": "startlux",
          "enabled": true,
          "endpoint": "http://127.0.0.1:8091",
          "manage": true,
          "autoStart": true,
          "restartOnExit": true,
          "serverDir": "D:/AI/StartLux-Decision",
          "options": {
            "modelDir": "D:/AI/StartLux-Decision/models/StartLux-Decision-v1.1-0.8B-Instant",
            "llamacppService": "startlux-gguf",
            "instant": true
          }
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

### 服务、模型与任务

- **服务条目**是一个模型部署：单模型条目挂一个 GGUF，多模型条目挂一个 GGUF 目录，audiocpp 条目挂一个语音模型。
- **模型**是条目里的 `models` / `/v1/models` 结果；StartLux-Decision、qwen3-embedding 与 reranker 同级。
- **任务**是模型的 `tasks`：`embeddings`、`rerank`、`chat`、`systemone`、`tts`、`sing`。`/v1/systemone`、`/v1/embeddings` 与 `/v1/rerank` 按任务选条目。
- embeddings 与 rerank 需要对应的模型；一个条目同时挂两种任务时，只适合上游同一个模型同时开两个端点。分开用两个条目更稳。
- llama.cpp 条目用 `chat` 表示「只提供模型，不加 embedding/rerank 旗标」。StartLux 的 GGUF 就挂在这样一条条目上。
- StartLux Decision 是独立条目：`startlux-decide` 把 typed systemone 请求翻译成 llama-server 的 prompt/readout。它用 `options.llamacppService`（或 `options.llamacppUrl`）指向 llama.cpp 条目，条目自己的地址就是 `/v1/systemone` 端口。

### 服务条目

用户只填 `name` 与 `endpoint`；`id`、协议、主机端口、健康路径都由服务端推导。

| 字段 | 说明 |
|---|---|
| `id` | 服务端生成的稳定键；日志、状态与 API 路径用它，不可手填、不可修改 |
| `name` | 用户填写的显示名，也是唯一身份；面板与状态事件都用它 |
| `type` | `audiocpp` / `sing` / `openai` / `llamacpp` / `startlux` / `systemone`；决定协议与启动预设 |
| `enabled` | 参与启动与探活 |
| `endpoint` | 一个 URL，例如 `http://127.0.0.1:8080`、`https://host/v1`；无协议按 http |
| `manage` | `false` 只探活，不拉起进程；`true` 时没有预设的类型必须给 `binary` |
| `autoStart` | World 启动时一并拉起 |
| `restartOnExit` | 非预期退出后按 5s / 15s / 60s 退避重启，最多 3 次 |
| `serverDir` | 可执行文件目录，也是进程工作目录 |
| `binary` | 可执行文件；相对路径按 serverDir 解析。`startlux` 留空用 `<serverDir>/.venv/Scripts/startlux-decide(.exe)` |
| `args` | 追加参数，按空白分隔（支持引号）；单模型模式的 `-m` / `--model` 可以写在这里，也可以由 `models` 自动补 |
| `secretName` | 上游 API Key 的 `.env` 变量名；只存名字 |
| `modelProfile` | `auto` 或模型 profile id |
| `models` | 模型名列表；llama.cpp 单模型只取第一个，多模型用于目录补全与请求兜底；空 = 从 `/v1/models` 现取 |
| `tasks` | 该条目承载的任务：`embeddings` / `rerank` / `chat` / `systemone` / `tts` / `sing`；空 = 按类型默认 |
| `options` | 该服务的默认 options；audiocpp 预设读取 `backend`、`device`、`threads`、`idleUnloadMs`、`ui`、`pollMs`、`startTimeoutSec`；llama.cpp 读取 `launchMode`、`modelsDir`、`cacheDir`、`contextSize`、`nGpuLayers`、`parallel`、`startTimeoutSec`；StartLux Decision 读取 `modelDir`、`llamacppService`、`llamacppUrl`、`bidirMode`、`thinkMode`、`gate`、`instant`、`startTimeoutSec` |

### 类型推导

| `type` | 协议 | 默认端口 |
|---|---|---|
| `audiocpp` | `audiocpp` | 8080 |
| `sing` | `sing` | 9882 |
| `openai` | `openai` | https 443，否则 80 |
| `llamacpp` | `llamacpp` | 回环 8081，否则按协议 |
| `startlux` | `systemone` | 回环 8091，否则按协议 |
| `systemone` | `systemone` | 回环 8091，否则按协议 |

`tasks` 空时的默认值：`llamacpp` → `embeddings` + `rerank`；`startlux` / `systemone` → `systemone`；`audiocpp` / `openai` → `tts`；`sing` → `sing`。面板新建 llama.cpp 条目时默认选 `Chat（只提供模型）`，避免给 StartLux 的 GGUF 误加 embedding 旗标。

- 端点缺主机时按 `127.0.0.1`；缺端口时按上表补。`8091` / `8081` 只用于回环地址；`https://api.example.com` 这类外部端点仍用 443，`http://` 用 80。Cortico 内置 llama.cpp 供应商默认占 `8090`，StartLux Decision 默认避开它。
- 健康路径固定 `/health`；`openai` / `systemone` 的 `/health` 回 404 时改探 `/v1/models`。
- audiocpp 的配置文件固定读 `<serverDir>/server.json`。

### id 生成

面板新增服务时由服务端生成 `id`：ASCII 名字取 slug（`My TTS` → `my-tts`），中文或空名字取 `<type>-<序号>`（`openai-1`、`startlux-1`）；与已有 id 冲突时追加序号。创建时传入的 `id` 会被忽略，更新时不允许修改。

### 启动预设

- `audiocpp`：默认 `audiocpp_server(.exe)`，参数 `--config --host --port --backend --device --threads --idle-unload-ms --no-ui` 加 `args`；`--host` / `--port` 来自 `endpoint`。
- `llamacpp`：两种启动方式，`options.launchMode` 显式选择；没有 `launchMode` 时按 `args` 推断，空配置默认多模型。
  - `router`（多模型）：`llama-server --host --port --models-dir <options.modelsDir>`。面板从 GGUF 目录读取 `.gguf` 让你多选；选中的模型写进 `models`，用于目录与请求兜底。llama-server 会按需加载目录里的模型。
  - `single`（单模型）：`llama-server --host --port -m <modelsDir>/<选中的模型>.gguf`。面板只允许选一个；`-m` / `--model` 已经写在 `args` 里时保留原值。
  - 两种模式都读取 `options.cacheDir`（设为 `LLAMA_CACHE`）、`options.contextSize`（`-c`）、`options.nGpuLayers`（`-ngl`）、`options.parallel`（`--parallel`）；`args` 里的同名参数优先。任务 `embeddings` 加 `--embeddings`，`rerank` 加 `--reranking`，`chat` 不加旗标。
  - 0.8 及更早的 `serve` 配置按多模型处理，残留的 `serve` 子命令会被清掉；带 `-m` / `--model` 的按单模型。既没有 `modelsDir` 也没有模型参数的旧 serve 配置会提示迁移，不再有 `llama serve` 启动方式。
- `startlux`（StartLux Decision）：默认 `<serverDir>/.venv/Scripts/startlux-decide(.exe)`（POSIX 为 `.venv/bin/startlux-decide`），也可以手填 `binary`。**直接运行 venv 里的入口即可，不需要先 activate**；工作目录是 `serverDir`。
  - 参数：`serve --model <options.modelDir> --backend llamacpp --llamacpp-url <上游> --host <endpoint host> --port <endpoint port>`，可选 `--think-mode`、`--gate`，最后追加条目 `args`（受管参数会被清掉）。
  - 上游：`options.llamacppService` 写一条 llama.cpp 条目的 id，地址取该条目的 `endpoint`；没有 id 时用 `options.llamacppUrl`。两者必须有一个。
  - 环境自动设 `STARTLUX_LLAMACPP_BIDIR=server`，可用 `options.bidirMode` 覆盖；`options.instant: true` 会忽略 `--think-mode auto/always`。
  - `options.modelDir` 必填。`startlux-decide` 的 llamacpp 后端调用 `/completion`，请求里不带 `model`；上游 llama.cpp 条目用**单模型**最稳。多模型条目需要 llama-server 能接受不带 `model` 的 `/completion` 请求。
- `systemone`：外部 Jev 兼容端点，`manage: false` 时只探活与转发；本机 StartLux Decision 用 `type: startlux`。
- `openai` / `sing`：操作者给 `binary` 与 `args`。

StartLux 0.8B Instant 本地部署要点：

- 模型卡给的是 Q8_0 0.81 GB / Q4_K_M 0.53 GB，上下文 262,144；权重许可是 CC BY-NC 4.0，商用需单独授权。
- 一条 `llamacpp` 条目挂 GGUF：单模型模式选 `StartLux-Decision-v1.1-0.8B-Instant-Q8_0`，`args` 里放 Instant 需要的 `--parallel 1 --ctx-checkpoints 0 -b 16384 -ub 16384`，`options.contextSize` 设 `20480`，`options.nGpuLayers` 设 `99`。
- 一条 `startlux` 条目挂 BF16 仓库目录（tokenizer、`config.json`、`decision_config.json`），`options.llamacppService` 指向上面那条；条目地址默认 `http://127.0.0.1:8091`，它就是 `/v1/systemone` 端口。把 llama.cpp 条目排在 StartLux Decision 前面：`startlux-decide` 启动时要连上游。
- `startlux-decide` 会把 `STARTLUX_LLAMACPP_BIDIR=server` 传给自己的 llamacpp 后端；如果 prompt 更长，调大 llama.cpp 条目 `args` 里的 `-c` / `-b` / `-ub`。
- 大模型加载慢时调大对应条目的 `options.startTimeoutSec`（默认 60 秒）。
- 服务不会下载模型或转换权重，只负责拉起进程、探活和转发。

### llama.cpp 用法

服务插件只托管辅助模型与 StartLux Decision，不代理 chat；聊天模型用 Cortico 内置的 llama.cpp 供应商。

- **模型目录**：多模型模式把 embedding、reranker 与 StartLux 的 GGUF 放进同一个目录，也可以分开放多个条目。单文件模型可以放根目录；多分片或多模态模型放独立子目录。模型名是相对路径去掉 `.gguf`，子目录用 `/` 分隔。
- **Embeddings**：tasks 选 `Embeddings` 或 `Embeddings + Rerank`，模型用 embedding 模型（例如 Qwen3-Embedding、bge-m3、embeddinggemma）。插件按 tasks 加 `--embeddings`。
- **Rerank**：tasks 选 `Rerank` 或两者，模型用 reranker（例如 Qwen3-Reranker、bge-reranker-v2-m3）。插件按 tasks 加 `--reranking`。
- **Chat / StartLux 的 GGUF**：tasks 选 `Chat（只提供模型）`，插件不加任何端点旗标；`llama-server` 只按需要加载模型。
- **一个条目同时开两种任务**时上游是同一个模型；不同模型请各建一个条目。
- `tasks` 是条目级：开了 `Embeddings` / `Rerank` 就会给整台 llama-server 加 `--embeddings` / `--reranking`。这些旗标会限制服务能力，所以「embedding + StartLux 的 chat GGUF」放在同一个多模型条目里不一定能同时工作；要稳就分两个 llama.cpp 条目、两个端口。
- **参数**：GPU 用 `-ngl all`（llama-server 也接受 99）；`-c` 按模型上下文设，0 表示原生上限；`--parallel` 按显存与并发设；embedding 的 pooling 用模型默认值，reranker 用 rank；reranker 的 query + document 必须放进 `--ubatch-size`，不够就调大。
- **请求带 model**：多模型模式要求 `model`。请求缺 `model` 时，插件用条目 `models` 的第一个补；`models` 空时从 `/v1/models` 取第一个。多模型目录建议在请求里显式给 `model`。单模型模式会忽略这个字段。
- **用内置供应商的 llama-server**：条目的 `manage` 设为 false，`endpoint` 指向它的 API 地址（默认 `http://127.0.0.1:8090/v1`），tasks 按模型填。它的 `launch.extraArgs` 里要加 `--embeddings` / `--reranking`，否则上游没有对应端点；也可以直接用本插件托管。

配置示例：

```jsonc
{
  "id": "embed",
  "name": "Embeddings",
  "type": "llamacpp",
  "endpoint": "http://127.0.0.1:8081",
  "manage": true,
  "autoStart": true,
  "restartOnExit": true,
  "serverDir": "C:/llama",
  "tasks": ["embeddings", "rerank"],
  "models": ["Qwen3-Embedding-0.6B-Q8_0", "Qwen3-Reranker-0.6B.Q4_K_M"],
  "options": {
    "launchMode": "router",
    "modelsDir": "D:/models/gguf",
    "cacheDir": "D:/models/cache",
    "contextSize": 16384,
    "nGpuLayers": "all",
    "parallel": 4
  }
}
```

从 0.8.x 迁移：

- 本地 StartLux 拆成两条：一条 `type: llamacpp` 挂 GGUF（`tasks: ['chat']`，单模型或多模型都可），一条 `type: startlux` 挂 BF16 模型目录。旧的 `startluxDir` / `startluxBinary` / `startluxArgs` / `systemonePort` / `systemoneUrl` / `systemoneSecretName` 不再使用；`modelDir`、`thinkMode`、`gate`、`instant` 移到 startlux 条目。
- llama.cpp 条目的 `launchMode: 'serve'` 按 `router` 处理；`serve` 子命令会被清掉。带 `-m` / `--model` 的旧 serve 配置按单模型；没有 `modelsDir` 也没有模型参数的会提示迁移。新建条目只有 `router`（多模型）与 `single`（单模型）两种。
- 0.7.0 及更早的 `type: llamacpp` + `tasks: ['systemone']` 会被标成迁移错误，不拉起进程。
- 旧 `svc` / `custom` 类型不再出现在面板与类型表里；旧配置的协议仍按原样处理，但保存前要把类型改成新类型。

启动前先探活：已经活着就接管，不重复拉起。停止时先停 StartLux Decision 的 `startlux-decide`，再停它指向的 llama.cpp 条目（按条目逆序）。服务输出写到 `dataDir/service-<id>.log`。修改运行中条目的 endpoint、args 或 options 后，点一次「重启」让新参数生效。

## HTTP 网关

默认 `http://127.0.0.1:9883`，由 World 启停。只认这八条路由，不代理 LLM 的 chat/responses。

| 路由 | 说明 |
|---|---|
| `GET /health` | `{status, ready, version, uptimeSec, services[], models}`；模型数是发现到的目录条数 |
| `GET /v1/models` | OpenAI 形状；每项带 `service`、`display_name`、`tasks`、`voices` 与请求参数元数据 `parameters` |
| `GET /v1/audio/voices?model=&service=` | 返回 `{object, model, voices[], data[]}` |
| `POST /v1/audio/speech` | `{model?, input, voice?, response_format?, speed?, instructions?, emotion?, language?, options?}` |
| `POST /v1/audio/sing` | `{model?, lyrics}`；路由到 `type: 'sing'` 的条目 |
| `POST /v1/systemone` | JSON 对象原样转发到 `tasks` 含 `systemone` 的条目；`type: 'startlux'` 与 `type: 'systemone'` 都走自己的 endpoint；`model` 用于选条目，不做 token 截断 |
| `POST /v1/embeddings` | `{model?, input, dimensions?}` 转发到 `tasks` 含 `embeddings` 的条目；缺 `model` 时补条目的第一个模型 |
| `POST /v1/rerank` | `{model?, query, documents, top_n?}` 转发到 `tasks` 含 `rerank` 的条目；缺 `model` 时补条目的第一个模型；上游 404/405/501 回 501 `unsupported` |

- 令牌：配置只存 `tokenSecret` 名字，值从部署 `.env` 读。非回环地址没有令牌、或变量名为空值，网关拒绝启动。`allowQueryToken: true` 时才接受 `?token=`。
- 限额：请求体 1 MiB，`input` 8000 字，`instructions` 2000 字，`options` 16 KiB。
- 错误：JSON `{error:{message,type,code,param}}`；400/401/404/413/429/501/502/503/504，503 带 `Retry-After: 2`。
- 不接收 `play`，不排队、不重试上游；重复请求由客户端决定。
- 音频回应带 `content-type`、`content-length`，WAV 可算时长时带 `x-voice-seconds`。

## 模型 profile

内置 `openai`、`audiocpp-ming3`、`audiocpp-indextts2`、`custom`、`sing`。解析顺序：条目 `modelProfile` → 模型 id 前缀/通配匹配 → `openai` 兜底。`custom` profile 仍可用于 OpenAI 类型条目的字段映射；0.8 及更早的 `type: custom` 条目也仍按 custom 方言处理。

- `audiocpp-ming3`：有 `instructions` → `options.template_name='freeform'` 并带上指令；否则有 `emotion` → `emotion`；否则有 `speed` → `basic`，按 `speedLevels` 取慢速/中速/快速，pitch 与 volume 为中。模型页额外暴露模板、语言、指令语言、音高、音量、最大 token、引导强度、噪声尺度、温度、种子、整段发送、文本分块与静音修剪；`instruct`、`emotion`、`speed` 仍由语音的朗读风格控制。
- `audiocpp-indextts2`：`index-tts2` / `index_tts2` / 2.5 走这个 profile；有 `instructions` → `options.use_emotion_text=true` 且 `emotion_text` 取指令，否则有 `emotion` → 同样写入 `emotion_text`。`use_emotion_text` 与 `emotion_text` 由语音语义管理，模型页不单独暴露；旧配置里的这两个 options 不会再覆盖 variant。`speed` 不映射到 `duration_scale`。
- profile 的 `fields` 把语义字段映射到上游 JSON 字段；`variants` 用 `when.has` / `when.not` 选第一个匹配项，`set` 里的 `{{field}}` 用请求值替换；`options` 声明类型、枚举与默认值；`defaults` 是请求体默认字段。
- 条目 `options` 里只有 profile 声明过的名字会进请求体；启动参数与协议设置不会混进去。

### 发现

- `GET /v1/models` 取模型；audiocpp 另读 `server.json` 声明的模型（没有 `server.json` 时只用 `/v1/models`）。
- `model_specs/*.json` 只按模型 family/id 补元数据（显示名、任务、音色、`options.request` 参数），不会新增模型；单文件 ≤ 2 MiB，只认 `category='tts'`，带 `schema_version` 时必须是 1。
- `GET /v1/audio/voices?model=` 覆盖静态音色。
- 读不到时保留上次目录并标 stale；不会让服务本身失败。

### 协议设置

`custom` 旧条目读 `options.url`（优先于 `endpoint`）、`path`（追加到 `endpoint` 后）、`method`、`headers`、`body`、`response`（`audio`/`base64`/`url`）、`audioPath`；`headers` 里的 `${KEY}` 换成 `secretName` 的值。`sing` 条目读 `options.path`，默认 `/sing`。

## 状态

World 页有三只灯：网关、服务在线数 / 总数、模型总数；徽标显示网关端口与服务条目数。状态变化推只归档的事件：

- `service.started`、`service.stopped`、`service.failed`，都带 `deliver: false`，不占模型上下文。

## 服务面板

World 页用 Cortico 自己的页面页签分成两块面板，不再声明配置组：

- 「服务」：左侧是全宽「+ 新建服务」、说明与可滚动的卡片列表；左栏吸顶，右侧配置滚动时列表保持可见，卡片过多时只滚列表。每张卡片显示名称、类型 / 模型药丸（多选时显示首个模型 `+N`，没有时 `—`）、状态灯与状态行（草稿 / 已停用 / 启动中 / 在线 / 错误），以及启动 / 停止 / 重启快捷动作；删除与放弃草稿的图标在每张卡片上。选中卡片用强调色描边。
- 右侧是选中服务的状态块（状态、说明、地址、模型数、PID、重启次数、令牌）与动作行（启动 / 停止 / 重启 / 探活 / 日志 / 上移 / 下移）。
- 编辑器不用抽屉：基本信息常显（名称与类型）；下面按编号折叠区分「服务地址 / 运行时 / 模型 / 高级」。
  - 类型下拉按用途排列：`audiocpp`、`Sing`、`OpenAI`、`llama.cpp`、`StartLux Decision`、`SystemOne`；显示名不再全小写。
  - 服务地址：API 地址与「API Key」（部署 `.env` 变量名）；已保存的条目有「测试连接」，草稿不显示。
  - 运行时：启用、托管进程、随 World 启动、退出后重启；托管时显示目录、可执行文件与参数。`audiocpp` 另有后端、设备与线程、空闲卸载与 WebUI 开关。`llama.cpp` 另有启动方式（多模型 / 单模型）、GGUF 目录、缓存目录、上下文长度、GPU 层数与并行槽位。`StartLux Decision` 另有模型目录、llama.cpp 服务（或地址）、思考模式/阈值与 Instant；服务目录填 StartLux 仓库根目录，可执行文件留空用 venv 里的入口。这些写回 `entry.options` 的同名键并保留其他键；StartLux 模型目录与 llama.cpp 上游必填，思考阈值限 0–1。
  - 模型：`llama.cpp` 的任务（Embeddings + Rerank / Embeddings / Rerank / Chat）、模型文件选择（从 GGUF 目录读取 `.gguf`；多模型多选，单模型单选）与 GGUF 目录；其他类型显示模型 profile 与逗号分隔的模型表。
  - 高级：其余 Options JSON，默认折叠。
- 新增服务先作为草稿卡片出现，默认名称 `未命名服务`、类型 `audiocpp`、地址 `http://127.0.0.1:8080`、不启用、托管进程、不随 World 启动、退出不重启。名称、类型与模型药丸随输入即时更新；删除草稿不需要确认，保存时才调用 `add` 并选中新条目。
- 切换类型只在地址为空或等于旧类型默认地址时替换默认端点；`openai` 默认关闭进程托管，`sing` 默认 `http://127.0.0.1:9882`，`startlux` 默认 `http://127.0.0.1:8091`。
- 4 秒轮询只更新卡片状态灯、状态行、状态块与动作行，不重建正在编辑的表单。
- 「网关」：只读状态与端口、令牌变量名 / 令牌值、查询参数令牌、超时、默认语音模型；编号折叠区为「基本 / 令牌 / 请求」，一次「保存」经 `saveGateway` 写回标量。端口、主机与令牌变量改动只标「需要重启」，不在这里重启 World。

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
pnpm smoke:webui
pnpm smoke:host "D:/AI/audio-v0.9.3-bin-windows-x64-cuda13.3" 8018
```

`smoke:webui` 用 jsdom 装载 `dist/webui.js`，确认两个页面面板、卡片、草稿、轮询保留输入与编号折叠区；不排版，也不连真实数据面。`smoke:host` 用真的 `audiocpp_server` 拉起、探活、停止一次，打印三个阶段的 status。

## 版本规则

- 每次发版至少升 patch（第三位）；较大改动升 minor（第二位）。不单独发明 major，除非契约破坏到需要另起包。
- 0.9.0 按此规则升 minor：类型表去掉 `svc` / `custom`，新增 `StartLux Decision`；类型显示名与顺序整理；llama.cpp 去掉 `llama serve`，只留多模型与单模型，模型从 GGUF 目录多选/单选；StartLux 从 llama.cpp 条目拆成独立服务类型，代理 llama.cpp 的 GGUF，venv 入口直接启动。
- 0.8.1 按此规则升 patch：只更新扩展介绍，无运行时变更。
- 0.8.0 按此规则升 minor：llama.cpp 增加 `serve` / `router` / `single` 三种启动方式、GGUF 目录与启动参数；任务下拉保持预设标签；服务地址的上游令牌字段改叫 API Key；StartLux 伴生默认端口改为 8091，避开内置 llama.cpp 供应商的 8090。
- 0.7.0 按此规则升 minor：StartLux 改为 `llamacpp` 条目下的模型（`tasks: ['systemone']`），同一条目托管 llama-server 与伴生 startlux-decide；网关按模型任务路由，外部 systemone 类型保留。
- 0.6.0 按此规则升 minor：systemone 增加 StartLux 本地启动预设，llamacpp 与 systemone 获得默认端口。（0.7.0 起本地 StartLux 改用 llamacpp 条目，0.6.0 的写法不再推荐。）
- 0.5.0 按此规则升 minor：新增 `/v1/systemone`、`/v1/embeddings`、`/v1/rerank` 三条网关路由与对应协议适配器。
- 0.4.3 按此规则升 patch：服务页左栏吸顶，右侧配置滚动时列表不跟着走。
- 0.4.2 按此规则升 patch：IndexTTS2 的 `use_emotion_text` / `emotion_text` 改由语音语义管理，修复旧 options 覆盖。
- 0.4.1 按此规则升 patch：补齐 Ming 3.0 的模型页参数，不改协议与页面布局。
- 0.4.0 按此规则发布：服务页改成框架页面页签、复刻供应商设置页布局、新增草稿流程，算较大改动，升 minor（0.3.0 → 0.4.0）。
- 0.3.0 的默认端口改动仍有效：audiocpp 从 8000 改为 8080；服务网关保持 9883。

## 许可

MIT。
