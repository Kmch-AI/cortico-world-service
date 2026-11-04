## 0.6.0

- 新增 systemone 的 StartLux 本地启动预设：默认 `startlux-decide`，参数 `serve --model <options.modelDir> --backend llamacpp --llamacpp-url <options.llamacppUrl 或 http://127.0.0.1:8081> --host <endpoint host> --port <endpoint port>`；`options.thinkMode` 为 `auto` / `never` / `always` 时追加 `--think-mode`，`options.gate` 是有限数字时追加 `--gate`，最后追加条目 `args`。
- 托管 systemone 时 `options.modelDir` 必填；缺失时条目保持 `off` 并给出原因，不拉起进程。外部 systemone（`manage:false`）仍只探活与转发。
- `DEFAULT_PORTS` 增加 `systemone: 8090` 与 `llamacpp: 8081`；托管 systemone 的健康接口没给 `backend` 时，状态文案用 `llamacpp`。
- 服务面板在 systemone 托管时显示「StartLux 本地预设」字段组：模型目录、llama.cpp 地址、思考模式与思考阈值；保存时校验模型目录、阈值范围与思考模式枚举，写回 `options` 并保留其他键；草稿切换不丢这些值。
- README 补 StartLux 本地部署要点：GGUF 转换、`llama-server` 建议参数、Instant 模型限制与启动超时。
- 新增 5 个测试（systemone 预设参数、缺省参数、缺 modelDir、外部 systemone、backend 文案），服务包 11 个文件 163 个测试全绿；typecheck、build:webui、smoke:webui、check:extension 通过。
- 版本按新增启动预设升 minor。

## 0.5.0

- 新增三条 JSON 网关路由：`POST /v1/systemone`（TypeSafe Jev wire format，原样转发到 `systemone` 条目）、`POST /v1/embeddings` 与 `POST /v1/rerank`（转发到 `llamacpp` 条目）。
- `protocolOf` 为 `systemone` / `llamacpp` 返回真正的 HTTP 协议，不再把 systemone 当 OpenAI 兼容预设、也不再让 llamacpp 只托管进程。
- 新增 `JsonResult` / `SystemOneRequest` / `EmbeddingsRequest` / `RerankRequest` 与 `JsonRequest` 适配器形状；Bearer 仍取 `entry.secretName`，超时/取消/错误映射沿用 `timedFetch`。
- llamacpp 上游 rerank 返回 404/405/501 时映射为 501 `unsupported`；没有对应条目时返回 503。
- systemone 条目探活优先 `/health`，404 时回退 `/v1/models`；目录发现把 systemone 标为 chat、llamacpp 标为 embeddings/rerank，不再误标 TTS。
- 新增 23 个测试，服务包 11 个文件 158 个测试全绿；typecheck、build:webui、smoke:webui、check:extension 通过。
- 版本按新增路由升 minor。

## 0.4.3

- 服务页左栏改为吸顶：右侧配置滚动时，「+ 新建服务」与服务卡片列表保持可见；卡片过多时列表自己滚动。
- 左栏在单列布局下恢复普通流式排列；列表高度增加视口上限，短窗口下不会伸到滚动区外。

## 0.4.2

- IndexTTS2 的 `use_emotion_text` 与 `emotion_text` 改为由语音语义管理,不再在模型参数面板显示。
- 请求 options 里遗留的 `use_emotion_text:false` / `emotion_text` 不再覆盖 profile 的 variant;带 `instructions` 或 `emotion` 的请求现在会真正以 `use_emotion_text:true` 和对应文本发给 IndexTTS2。
- 模型页 IndexTTS2 可见参数从 18 个降到 16 个;`emotion_alpha`、采样与分块参数仍可配置。

## 0.4.1

- `audiocpp-ming3` 的模型页参数不再全部隐藏：新增模板、语言、指令语言、音高、音量、最大 token、引导强度、噪声尺度、温度、种子、整段发送、文本分块大小/模式与静音修剪；这些参数只在用户填写时进入请求，不改变默认请求体。
- `instruct`、`emotion`、`speed` 仍由语音的模型页朗读风格控制，不在模型参数里重复暴露。
- 模型参数元数据继续从 profile 与 `model_specs` 合并，Ming 的枚举、范围与说明随 `/v1/models` 返回。

## 0.4.0

- 页面页签改用 Cortico 自己的 `webUi().panels`：「服务」与「网关」各自是一块面板，客户端 bundle 同时导出两者；不再有内部分段标签，也没有配置组或配置页签。
- 服务面板复刻模型供应商设置页：左侧是全宽「+ 新建服务」、说明与可滚动的大卡片列表；卡片显示名称、type/model 药丸、状态灯与状态行、启动/停止/重启快捷动作，删除/放弃图标在每张卡片上。选中卡片用强调色描边，悬停有抬升。
- 右侧是选中服务的状态块（phase/detail/baseUrl/models/pid/restarts/token）与动作行；编辑器不再用抽屉：基本信息常显，下面按编号折叠区分为「服务地址 / 运行时 / 模型 / 高级」。
- 新增服务先作为草稿卡片出现：名称 `未命名服务`、类型 `audiocpp`、地址 `http://127.0.0.1:8080`、`enabled=false`、`manage=true`、`autoStart=false`、`restartOnExit=false`。名称、类型与模型药丸随输入即时更新；删除草稿不需要确认，保存时才调用 `add` 并选中新条目。
- 类型切换只在地址为空或等于旧类型默认地址时替换默认端点；`openai` 默认关闭进程托管，`sing`/`svc` 默认 `http://127.0.0.1:9882`。
- `audiocpp` / `llamacpp` 在托管时显示后端、设备与线程；`audiocpp` 另有空闲卸载与 WebUI 开关。这些字段写回 `entry.options` 的同名键，并保留其余 options。
- 服务地址区有测试连接按钮（草稿不显示）；已保存的条目直接探活，结果回写状态块。
- 4 秒轮询只刷新卡片状态灯/状态行、状态块与动作行，不重建正在编辑的表单。
- 网关页签沿用编号折叠区「基本 / 令牌 / 请求」与底部保存按钮。
- 版本 0.4.0：页面布局属于较大改动，按发布规则升 minor。

## 0.3.0

- audiocpp 默认端口从 8000 改为 8080:类型推导、默认地址、端点占位、示例与测试同步;服务网关仍是 9883,其他 8000 限额与超时不变。
- 服务面板改版:顶部内部 tab 分为「服务」「网关」;服务页左侧顶部是添加服务按钮、下面是服务列表,右侧是选中服务的编辑区;编辑区按「基本 / 运行 / 进程 / 高级」分组,可展开收起;网关按「基本 / 令牌 / 请求」分组。轮询只更新状态,不重建正在编辑的表单。

## 0.2.0

- `ServiceEntry` 简化为 `id` / `name` / `type` / `enabled` / `endpoint` / `manage` / `autoStart` / `restartOnExit` 加进程与模型字段;移除 `kind`、`protocol`、`host`、`port`、`baseUrl`、`healthPath`、`configPath`、`label` 与 `modelProfiles`。
- 协议、主机端口、健康路径改为推导:新增 `src/entry.ts` 的 `protocolOf`、`endpointUrl`、`hostPort`、`healthPathOf` 与 `serverJsonPath`;`openai` / `custom` 的 `/health` 回 404 时探 `/v1/models`。
- `id` 由服务端生成:ASCII 名字取 slug,中文或空名字取 `<type>-<序号>`;创建时忽略用户给的 id,更新时不可改。
- 启动参数改从 `endpoint` 取 `--host` / `--port`;audiocpp 配置固定读 `<serverDir>/server.json`;没有启动预设的类型在 `manage=true` 时必须给 `binary`。
- 面板与状态事件一律显示 `name`;定义与 World 的标签统一为 `Kmch AI · 服务`。
- World 只声明一个 `services` 面板,不再声明 ConfigGroup;网关标量改经新的 `saveGateway` 写回。`saveGateway` 校验端口、超时与令牌变量名,拒绝未知键;端口、主机或令牌变量改动只标「需要重启」。
- 面板改为主从视图:顶部选单是「网关」与各服务名,下面是选中项的状态与表单;不再有服务/网关两个分段。服务条目只显示名称、类型、地址与四个开关,协议与健康路径由类型推导、不进面板;进程字段只在托管时出现,密钥变量名、profile、模型与 options 收在折叠的「高级」里。
- `add` 返回新条目(含 `tokenSet`),面板据此选中新服务;创建忽略传入的 `id`,重名允许。
- 目录发现只列真实模型:audiocpp 用 `server.json` ∪ `/v1/models`,其余协议只用 `/v1/models` 或条目里配置的模型;`model_specs` 只按 family/id 补标签、任务、音色与参数元数据,不再把全部 spec 列成模型。
- `/v1/models` 带上模型请求参数元数据;参数只取 profile 真正接受的字段,隐藏由语音语义控制的项。
- 新增 `audiocpp-indextts2` profile:18 个请求参数,`instructions`/`emotion` 映射到 `emotion_text`;IndexTTS2 不支持副语言标签。

## 0.1.0

- 包从 `@kmchai/cortico-world-audiocpp` 更名为 `@kmchai/cortico-world-service`,World id 从 `audiocpp` 改为 `service`。
- 新增 `ServiceEntry` / `ServiceStatus` / `GatewayStatus` / `ModelProfile`;`services` 数组支持多条服务。
- Supervisor 从单一 audiocpp 配置泛化为按 `kind` 预设的通用进程托管;`custom` 条目不再要求 audiocpp 字段。
- 新增 Manager:按 id 启停,顺序启动、逆序停止,状态汇总与日志尾部。
- 状态事件改为 `service.started` / `service.stopped` / `service.failed`,仍只归档。
- 新增 HTTP 网关:`/health`、`/v1/models`、`/v1/audio/voices`、`/v1/audio/speech`、`/v1/audio/sing`;Bearer 令牌、回环免认证、1 MiB 请求体与输入限额、统一错误形状。
- 新增协议层:`openai`、`audiocpp`、`custom` JSON 映射与 `sing`;按 `protocol` 选择,带上游令牌、超时、错误片段与 WAV 时长。
- 新增模型 profile:`openai`、`audiocpp-ming3`(freeform/emotion/basic)、`custom`、`sing`;支持字段映射、variant、options、defaults、speedLevels 与条目级覆盖。
- 新增目录发现:`/v1/models`、`/v1/audio/voices`,audiocpp 的 `server.json` 与 `model_specs`;失败保留上次结果并标 stale。
- 网关在非回环地址无令牌、或令牌变量为空时拒绝启动。
- 新增「服务」WebUI 面板:服务列表的状态灯与启停、增删改与排序、探活与模型发现、模型 profile 覆盖、日志尾部、条目与网关令牌;`services` 数组整体经 `WorldContext.persist` 写回,写入前校验 id、端口与重复端口。
- 新增 `scripts/build-webui.mjs`(esbuild)与 `cortico.webUiClient` / `cortico.webUiStyle`;面板 bundle 为 `dist/webui.js` + `dist/webui.css`。
