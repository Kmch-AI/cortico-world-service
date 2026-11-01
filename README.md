# @kmchai/cortico-world-audiocpp

给 Cortico 托管本机 `audiocpp_server`：拉起、探活、报状态、退出时收尸。它不合成、不播放、不碰语音内容。

语音 World（如 `@kmchai/cortico-world-voice`）只需要把 `baseUrl` 指向它的端口。两个包互不 import：不装这个，语音 World 也可以连任何已经在跑的 audiocpp 或 OpenAI 兼容服务。

## 为什么是 World，不是 provider

Cortico 的 provider 扩展契约是「LLM 端点方言」：`ProviderModule.create()` 必须返回一个 `BaseProvider`，`respond()` 产出 Responses 流。audiocpp 是音频推理服务（`/v1/audio/speech` 等），没有 chat/responses 端点，套不进这个契约。托管进程在框架里是 World 的职责。

## 安装

```bash
# 在部署的 extensions/ 目录里
corepack pnpm add "D:/path/to/cortico-world-audiocpp" --ignore-workspace
```

或在控制台「扩展」页选「从本机目录安装」,装完重启进程。启用 `worlds.audiocpp.enabled`。

## 最小配置

```jsonc
{
  "worlds": {
    "audiocpp": {
      "enabled": true,
      "manage": true,
      "serverDir": "D:/AI/audio-v0.9.3-bin-windows-x64-cuda13.3",
      "host": "127.0.0.1",
      "port": 8000,
      "backend": "cuda",
      "device": 0,
      "autoStart": true
    }
  }
}
```

`serverDir` 里要有 `audiocpp_server.exe`（Windows）或 `audiocpp_server`（其他平台），以及 `server.json`。进程的工作目录就是 `serverDir`，因为 `server.json` 里的模型路径是相对的。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `manage` | `true` | 关掉只探活，不拉起进程 |
| `serverDir` | 空 | 服务目录；空 = 未配置，灯 offline，不抛错 |
| `configPath` | 空 | `server.json` 路径；空 = `serverDir/server.json` |
| `binary` | 空 | 可执行文件名；空按平台取 |
| `host` / `port` | `127.0.0.1` / `8000` | 传给 `--host` / `--port` |
| `backend` | `cuda` | `cuda` / `cpu` / `vulkan` / `hip` / `metal` |
| `device` | `0` | `--device` |
| `threads` | `0` | `--threads`；0 用服务默认值 |
| `autoStart` | `true` | World 启动时拉起 |
| `restartOnExit` | `true` | 非预期退出后按 5s / 15s / 60s 退避重启，最多 3 次 |
| `idleUnloadMs` | `0` | `--idle-unload-ms`；只卸模型，不杀进程 |
| `extraArgs` | 空 | 追加参数，按空白分隔（支持引号） |
| `ui` | `true` | 启用服务自带 WebUI；在线时 World 页给链接 |
| `pollMs` | `5000` | 探活间隔 |
| `startTimeoutSec` | `60` | 启动等待上限 |
| `logFile` | 空 | 服务输出文件；空 = 数据目录的 `audiocpp.log` |

启动前先探 `GET /health`：已经活着就接管状态，不重复拉起。停止时结束子进程；Windows 上由 Node 的 `child.kill()` 终止。

## 状态

World 页有两只灯：进程（offline / loading / online / error）与模型（数量）。状态变化推只归档的事件：

- `audiocpp.started`、`audiocpp.stopped`、`audiocpp.failed`，都带 `deliver: false`，不占模型上下文。

## 验证

```bash
pnpm typecheck
pnpm test
pnpm smoke:host "D:/AI/audio-v0.9.3-bin-windows-x64-cuda13.3" 8018
```

`smoke:host` 用真的 `audiocpp_server` 拉起、探活、停止一次，打印三个阶段的 status。

装进 Cortico 后应看到：World 页多一张「audiocpp」卡；启用后进程被拉起；`GET http://127.0.0.1:8000/health` 通；停用 World 后进程退出；灯与端口徽标正确。

## 许可

MIT。
