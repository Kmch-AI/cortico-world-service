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
