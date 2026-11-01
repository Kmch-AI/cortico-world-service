import type { WorldDefinition } from 'cortico/world.ts';
import { AUDIOCPP_DEFAULTS, AUDIOCPP_ID } from './config.ts';
import type { AudiocppConfigSection } from './types.ts';
import { AudiocppWorld } from './world.ts';

export const AUDIOCPP: WorldDefinition<AudiocppConfigSection> = {
  id: AUDIOCPP_ID,
  label: 'audiocpp',
  defaults: () => ({ ...AUDIOCPP_DEFAULTS }),
  create: (ctx) => new AudiocppWorld({
    cfg: ctx.cfg,
    timezone: ctx.timezone,
    dataDir: ctx.dataDir,
  }),
  describe: {
    tools: [],
    events: [
      {
        type: 'audiocpp.started',
        description: { zh: 'audiocpp 服务已就绪;只归档。', en: 'The audiocpp service is online; archived only.' },
      },
      {
        type: 'audiocpp.stopped',
        description: { zh: 'audiocpp 服务已停止;只归档。', en: 'The audiocpp service stopped; archived only.' },
      },
      {
        type: 'audiocpp.failed',
        description: { zh: 'audiocpp 服务启动失败或异常退出;只归档。', en: 'The audiocpp service failed to start or exited unexpectedly; archived only.' },
      },
    ],
  },
};
