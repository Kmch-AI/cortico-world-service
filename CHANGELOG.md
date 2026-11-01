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
