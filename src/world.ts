/**
 * audiocpp 托管 World:只拉起、探活与报状态,不合成、不播放、不碰语音内容。
 * 语音 World 经 HTTP 连它,两个包互不 import。
 */
import type { Language } from 'cortico/core/language.ts';
import type { Logger, ToolDef, World, WorldHost, WorldLamp, WorldWebUiDecl } from 'cortico/core/types.ts';
import { nullLogger, nowIso } from 'cortico/core/util.ts';
import { AUDIOCPP_ID, audiocppConfigGroups, audiocppText } from './config.ts';
import { Supervisor, type SupervisorDeps } from './supervisor.ts';
import type { AudiocppConfigSection, SupervisorStatus } from './types.ts';

export interface AudiocppWorldOptions {
  cfg: AudiocppConfigSection;
  timezone: string;
  dataDir: string;
  log?: Logger;
  deps?: Partial<SupervisorDeps>;
}

export class AudiocppWorld implements World {
  readonly id = AUDIOCPP_ID;
  private readonly log: Logger;
  private readonly supervisor: Supervisor;
  private host: WorldHost | null = null;

  constructor(private readonly opts: AudiocppWorldOptions) {
    this.log = opts.log ?? nullLogger();
    this.supervisor = new Supervisor({
      cfg: opts.cfg,
      dataDir: opts.dataDir,
      log: this.log,
      deps: {
        ...opts.deps,
        onPhase: (status) => {
          opts.deps?.onPhase?.(status);
          this.report(status);
        },
      },
    });
  }

  envPromptVars(): null {
    return null;
  }

  tools(): ToolDef[] {
    return [];
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const t = audiocppText(language);
    const status = this.supervisor.status();
    const processLamp: WorldLamp = {
      label: t.lampProcess,
      state: status.phase === 'online' ? 'online'
        : status.phase === 'starting' ? 'loading'
          : status.phase === 'error' ? 'error' : 'offline',
      ...(status.detail ? { hint: status.detail } : {}),
    };
    const modelsLamp: WorldLamp = {
      label: t.lampModels,
      state: status.models > 0 ? 'online' : status.phase === 'online' ? 'offline' : status.phase === 'starting' ? 'loading' : 'offline',
      hint: `${status.models}`,
    };
    return {
      label: t.label,
      lamps: [processLamp, modelsLamp],
      badges: [
        { label: 'port', value: this.opts.cfg.port, tone: 'plain' },
        { label: 'backend', value: status.backend || this.opts.cfg.backend, tone: 'plain' },
        ...(status.pid ? [{ label: 'pid', value: status.pid, tone: 'plain' as const }] : []),
      ],
      config: audiocppConfigGroups(language),
      links: this.opts.cfg.ui && status.phase === 'online'
        ? [{ label: 'audiocpp WebUI', href: status.baseUrl }]
        : [],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    try {
      if (this.opts.cfg.autoStart) await this.supervisor.start();
      else await this.supervisor.refresh();
      this.supervisor.watch();
    } catch (error) {
      this.log.error('audiocpp 托管启动失败', { err: error instanceof Error ? error.message : String(error) });
    }
  }

  async stop(): Promise<void> {
    await this.supervisor.stop();
    this.host = null;
  }

  private report(status: SupervisorStatus): void {
    const host = this.host;
    if (!host) return;
    const type = status.phase === 'online' ? 'audiocpp.started'
      : status.phase === 'error' ? 'audiocpp.failed'
        : status.phase === 'off' ? 'audiocpp.stopped' : '';
    if (!type) return;
    const text = status.phase === 'online'
      ? `audiocpp is online at ${status.baseUrl} (${status.backend || this.opts.cfg.backend}, ${status.models} models).`
      : status.phase === 'error'
        ? `audiocpp failed: ${status.detail}`
        : 'audiocpp stopped.';
    void host.pushEvent({
      type,
      ts: nowIso(this.opts.timezone),
      source: this.id,
      origin: 'internal',
      senderKey: this.id,
      text,
      meta: { ...status },
    }, { deliver: false }).catch((error: unknown) => {
      this.log.warn('audiocpp 状态事件投递失败', { err: error instanceof Error ? error.message : String(error) });
    });
  }
}
