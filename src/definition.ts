import { join } from 'node:path';
import type { WorldDefinition } from 'cortico/world.ts';
import { SERVICE_DEFAULTS, SERVICE_ID } from './config.ts';
import { clearEnvLine } from './secrets.ts';
import type { ServiceConfigSection } from './types.ts';
import { ServiceWorld } from './world.ts';

export const SERVICE: WorldDefinition<ServiceConfigSection> = {
  id: SERVICE_ID,
  label: 'Service',
  defaults: () => ({ ...SERVICE_DEFAULTS, services: [] }),
  create: (ctx) => new ServiceWorld({
    cfg: ctx.cfg,
    timezone: ctx.timezone,
    dataDir: ctx.dataDir,
    persist: (patch) => ctx.persist(patch),
    secret: (name) => ctx.secret(name),
    storeSecret: (name, value) => ctx.storeSecret(name, value),
    clearSecret: (name) => clearEnvLine(join(ctx.botDir, '.env'), name),
    restart: () => ctx.restart(),
  }),
  describe: {
    tools: [],
    events: [
      {
        type: 'service.started',
        description: { zh: '一个推理服务已就绪;只归档。', en: 'An inference service is online; archived only.' },
      },
      {
        type: 'service.stopped',
        description: { zh: '一个推理服务已停止;只归档。', en: 'An inference service stopped; archived only.' },
      },
      {
        type: 'service.failed',
        description: { zh: '一个推理服务启动失败或异常退出;只归档。', en: 'An inference service failed to start or exited unexpectedly; archived only.' },
      },
    ],
  },
};
