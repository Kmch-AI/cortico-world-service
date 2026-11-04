/**
 * 服务 World:托管本机推理服务进程,并在同一组服务条目上开一条 OpenAI 形状的语音网关。
 * 不合成策略、不播放、不排队、不给模型工具;其他 World 经 HTTP 连网关,包之间互不 import。
 */
import type { Language } from 'cortico/core/language.ts';
import type { Logger, ToolDef, World, WorldHost, WorldLamp, WorldWebUiDecl } from 'cortico/core/types.ts';
import { nullLogger, nowIso } from 'cortico/core/util.ts';
import { SERVICE_ID, SERVICE_VERSION, serviceText } from './config.ts';
import { serviceIdFor, systemoneEndpointOf, tasksOfEntry } from './entry.ts';
import { ServiceError, errorMessage } from './errors.ts';
import {
  gatewayAuthError, isLoopbackHost, startGateway, type GatewayHandle, type GatewayHandlers,
  type GatewayHealthBody, type GatewayModel, type GatewayVoiceList,
} from './gateway/server.ts';
import { Manager, DEFAULT_LOG_LINES, MAX_LOG_LINES } from './manager.ts';
import type {
  PanelGateway, PanelLogs, PanelModels, PanelService, PanelServiceEntry, PanelState,
  PanelTokenResult,
} from './panel.ts';
import { ModelCatalog } from './profiles/discover.ts';
import { buildSing, buildSpeech, resolveProfile, resolveSingProfile } from './profiles/resolve.ts';
import {
  acceptsSing, acceptsSpeech, adapterOf, protocolOf, type JsonRequest,
} from './protocol/index.ts';
import { ENV_NAME_RE } from './secrets.ts';
import type { SupervisorDeps } from './supervisor.ts';
import type {
  EmbeddingsRequest, GatewayPhase, GatewayStatus, JsonResult, ModelRecord, RerankRequest,
  ServiceConfigSection, ServiceEntry, ServiceStatus, SingRequest, SpeechRequest, SystemOneRequest,
  TtsAudio,
} from './types.ts';
import { normalizeEntry, normalizeGatewayPatch, validateServices } from './validate.ts';

export interface ServiceWorldOptions {
  /** `worlds.service` 的活引用。 */
  cfg: ServiceConfigSection;
  timezone: string;
  dataDir: string;
  /** WorldContext.persist 的包装;缺省时只改内存配置。 */
  persist?(patch: Partial<ServiceConfigSection>): void;
  log?: Logger;
  deps?: Partial<SupervisorDeps>;
  /** 部署 .env 读取:网关令牌与上游 `secretName` 都经它取。 */
  secret?(name: string): string;
  /** 写部署 .env;缺省时 setToken 只改内存中的测试密钥表。 */
  storeSecret?(name: string, value: string): void;
  /** 删部署 .env 中的一行;缺省时退回 storeSecret(name, '')。 */
  clearSecret?(name: string): void;
  /** 改网关令牌后按需重启 World;缺省时令牌在下次启动时生效。 */
  restart?(): Promise<void>;
  /** 协议与目录发现的 fetch;测试注入。 */
  fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_SEC = 180;

function httpBase(host: string, port: number): string {
  const value = host.trim() || '127.0.0.1';
  const address = value.includes(':') && !value.startsWith('[') ? `[${value}]` : value;
  return `http://${address}:${port}`;
}

function gatewayLampState(status: GatewayStatus): WorldLamp['state'] {
  switch (status.phase) {
    case 'ok': return 'online';
    case 'starting': return 'loading';
    case 'error': return 'error';
    case 'degraded': return status.ready ? 'online' : 'offline';
    default: return 'offline';
  }
}

export class ServiceWorld implements World {
  readonly id = SERVICE_ID;
  private readonly log: Logger;
  private readonly manager: Manager;
  private readonly catalog: ModelCatalog;
  private readonly fetchImpl: typeof fetch;
  private readonly secretOf: (name: string) => string;
  private host: WorldHost | null = null;
  private gateway: GatewayHandle | null = null;
  /** 网关监听时的标量;用来判断面板改了端口或令牌名后是否要重启。 */
  private gatewayBinding: { host: string; port: number; tokenSecret: string } | null = null;
  private gatewayError = '';
  private started = false;
  private startedAt = 0;

  constructor(private readonly opts: ServiceWorldOptions) {
    this.log = opts.log ?? nullLogger();
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.secretOf = opts.secret ?? (() => '');
    this.manager = new Manager({
      services: () => this.opts.cfg.services ?? [],
      dataDir: opts.dataDir,
      log: this.log,
      // 先落盘,再让活配置指向同一份数组;管理器随后按它停掉被删或停用的条目。
      persist: (services) => {
        this.opts.persist?.({ services });
        this.opts.cfg.services = services;
      },
      deps: opts.deps,
      onStatus: (status) => this.report(status),
    });
    this.catalog = new ModelCatalog({
      fetch: this.fetchImpl,
      secret: (name) => this.secretOf(name),
      log: this.log,
    });
  }

  envPromptVars(): null {
    return null;
  }

  tools(): ToolDef[] {
    return [];
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const t = serviceText(language);
    const gateway = this.gatewayStatus();
    const statuses = gateway.services;
    const enabled = statuses.filter((status) => status.entry.enabled);
    const online = enabled.filter((status) => status.phase === 'online').length;
    const failed = enabled.filter((status) => status.phase === 'error').length;
    const starting = enabled.filter((status) => status.phase === 'starting').length;
    const total = enabled.length;
    const models = gateway.models;

    const servicesState: WorldLamp['state'] = total === 0
      ? 'offline'
      : online === total ? 'online'
        : failed > 0 ? 'error'
          : starting > 0 ? 'loading'
            : online > 0 ? 'online' : 'offline';
    const modelsState: WorldLamp['state'] = models > 0
      ? 'online'
      : starting > 0 ? 'loading' : 'offline';

    const links = enabled
      .filter((status) => status.phase === 'online'
        && status.entry.type === 'audiocpp'
        && status.entry.options?.ui !== false)
      .map((status) => ({
        label: `${status.entry.name} WebUI`,
        href: status.baseUrl,
      }));

    return {
      label: t.label,
      lamps: [
        { label: t.lampGateway, state: gatewayLampState(gateway), hint: gateway.detail },
        { label: t.lampServices, state: servicesState, hint: `${online}/${total}` },
        { label: t.lampModels, state: modelsState, hint: `${models}` },
      ],
      badges: [
        { label: 'port', value: this.gateway?.port ?? this.opts.cfg.port, tone: 'plain' },
        { label: 'services', value: statuses.length, tone: 'plain' },
      ],
      panels: [
        { id: 'services', title: t.panelServices, getMethods: ['state', 'models', 'logs'] },
        { id: 'gateway', title: t.panelGateway, getMethods: ['state'] },
      ],
      invoke: (panel, method, args) => this.invokePanel(panel, method, args),
      links,
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.started = true;
    this.startedAt = Date.now();
    this.gatewayError = '';
    this.gatewayBinding = null;

    const cfg = this.opts.cfg;
    const token = this.token();
    const authError = gatewayAuthError(cfg, token);
    if (authError) {
      this.gatewayError = authError;
      this.log.error('服务网关拒绝启动', { err: authError });
      return;
    }

    try {
      await this.manager.startAll();
      this.manager.watchAll();
    } catch (error) {
      this.log.error('服务托管启动失败', { err: errorMessage(error) });
    }

    this.catalog.seed(this.manager.entries());
    await this.refreshCatalogs();

    try {
      this.gateway = await startGateway({
        host: cfg.host.trim() || '127.0.0.1',
        port: cfg.port,
        token,
        tokenRequired: Boolean(cfg.tokenSecret.trim()) || !isLoopbackHost(cfg.host),
        allowQueryToken: cfg.allowQueryToken,
        handlers: this.handlers(),
        log: this.log,
      });
      this.gatewayBinding = {
        host: cfg.host.trim() || '127.0.0.1',
        port: this.gateway.port,
        tokenSecret: cfg.tokenSecret.trim(),
      };
    } catch (error) {
      this.gatewayError = `gateway failed to start: ${errorMessage(error)}`;
      this.log.error('服务网关启动失败', { err: errorMessage(error) });
    }
  }

  async stop(): Promise<void> {
    const gateway = this.gateway;
    this.gateway = null;
    this.gatewayBinding = null;
    if (gateway) {
      try {
        await gateway.close();
      } catch (error) {
        this.log.warn('服务网关关闭失败', { err: errorMessage(error) });
      }
    }
    await this.manager.stopAll();
    this.host = null;
    this.started = false;
    this.startedAt = 0;
  }

  /** 服务网关状态;WebUI、`/health` 与面板共用同一份口径。 */
  gatewayStatus(): GatewayStatus {
    const health = this.healthBody();
    return {
      status: health.status,
      phase: health.status,
      ready: health.ready,
      detail: this.gatewayDetail(health),
      host: this.opts.cfg.host,
      port: this.gateway?.port ?? this.opts.cfg.port,
      baseUrl: httpBase(this.opts.cfg.host, this.gateway?.port ?? this.opts.cfg.port),
      version: health.version,
      uptimeSec: health.uptimeSec,
      services: health.services,
      models: health.models,
    };
  }

  // -------------------------------------------------------------------------
  // 面板:services.state / models / logs 与增删改、启停、探活、发现、令牌
  // -------------------------------------------------------------------------

  private async invokePanel(panel: string, method: string, args: unknown[]): Promise<unknown> {
    if (panel === 'gateway') {
      switch (method) {
        case 'state': return this.panelState();
        case 'saveGateway': return this.saveGateway(args[0]);
        case 'setToken': return this.setToken(args);
        default: throw new Error(`unknown method: gateway.${method}`);
      }
    }
    if (panel !== 'services') throw new Error(`unknown panel: ${panel}`);
    switch (method) {
      case 'state': return this.panelState();
      case 'models': return this.panelModels();
      case 'logs': return this.panelLogs(args);
      case 'add': return this.addService(args[0]);
      case 'update': return this.updateService(args[0], args[1]);
      case 'remove': return this.removeService(args[0]);
      case 'reorder': return this.reorderServices(args);
      case 'start': return this.controlService('start', args[0]);
      case 'stop': return this.controlService('stop', args[0]);
      case 'restart': return this.controlService('restart', args[0]);
      case 'probe': return this.controlService('probe', args[0]);
      case 'discover': return this.discoverServices(args);
      default: throw new Error(`unknown method: services.${method}`);
    }
  }

  private panelState(): PanelState {
    const gateway = this.gatewayStatus();
    const cfg = this.opts.cfg;
    const enabled = gateway.services.filter((status) => status.entry.enabled);
    const services: PanelService[] = gateway.services.map((status) => ({
      ...status,
      entry: { ...status.entry, tokenSet: this.entryTokenSet(status.entry) },
    }));
    const binding = this.gatewayBinding;
    const panelGateway: PanelGateway = {
      enabled: cfg.enabled,
      status: gateway.status,
      phase: gateway.phase,
      ready: gateway.ready,
      detail: gateway.detail,
      host: cfg.host,
      port: cfg.port,
      baseUrl: gateway.baseUrl,
      version: gateway.version,
      uptimeSec: gateway.uptimeSec,
      tokenRequired: Boolean(cfg.tokenSecret.trim()) || !isLoopbackHost(cfg.host),
      tokenSet: this.token() !== '',
      secretName: cfg.tokenSecret,
      allowQueryToken: cfg.allowQueryToken,
      requestTimeoutSec: cfg.requestTimeoutSec,
      defaultSpeechModel: cfg.defaultSpeechModel,
      restartRequired: Boolean(binding && (
        binding.host !== (cfg.host.trim() || '127.0.0.1')
        || binding.port !== cfg.port
        || binding.tokenSecret !== cfg.tokenSecret.trim()
      )),
      models: gateway.models,
      online: enabled.filter((status) => status.phase === 'online').length,
      total: enabled.length,
    };
    return { gateway: panelGateway, services };
  }

  private panelModels(): PanelModels {
    const entries = this.manager.entries();
    return {
      models: this.catalog.models(entries),
      services: entries.map((entry) => this.catalog.get(entry.id) ?? {
        service: entry.id,
        models: this.catalog.models([entry]),
        stale: false,
        detail: entry.enabled ? 'not discovered' : 'disabled',
        updatedAt: 0,
      }),
    };
  }

  private async panelLogs(args: unknown[]): Promise<PanelLogs> {
    const id = this.serviceIdArg(args[0]);
    const entry = this.manager.entries().find((item) => item.id === id);
    if (!entry) throw ServiceError.notfound(`unknown service: ${id}`, 'id');
    const requested = args[1] === undefined || args[1] === null ? DEFAULT_LOG_LINES : Number(args[1]);
    const lines = Number.isFinite(requested)
      ? Math.min(MAX_LOG_LINES, Math.max(1, Math.floor(requested)))
      : DEFAULT_LOG_LINES;
    return { id, lines, text: await this.manager.logs(id, lines) };
  }

  private async addService(input: unknown): Promise<PanelServiceEntry> {
    const entries = this.manager.entries();
    // id 只在这里生成:用户只填 name,ASCII 名字取 slug,中文/空名字取 type + 序号。
    const fields = normalizeEntry(input);
    const id = serviceIdFor(fields.name, fields.type, entries.map((entry) => entry.id));
    const entry: ServiceEntry = { ...fields, id };
    const next = [...entries, entry];
    validateServices(next);
    await this.saveServices(next);
    this.log.info('服务条目已添加', { id });
    return { ...entry, tokenSet: this.entryTokenSet(entry) };
  }

  /**
   * 保存网关标量。只写白名单键;host / port 与监听时的绑定不同只标 `restartRequired`,
   * 不在这里重启 World——面板还在用这条连接。
   */
  private async saveGateway(input: unknown): Promise<PanelState> {
    const patch = normalizeGatewayPatch(input);
    if (Object.keys(patch).length) {
      this.opts.persist?.(patch);
      Object.assign(this.opts.cfg, patch);
      this.log.info('网关配置已保存', { keys: Object.keys(patch) });
    }
    return this.panelState();
  }

  private async updateService(idArg: unknown, patch: unknown): Promise<PanelState> {
    const whole = patch === undefined && idArg && typeof idArg === 'object' && !Array.isArray(idArg)
      ? idArg as Record<string, unknown>
      : null;
    const id = whole ? this.serviceIdArg(whole.id) : this.serviceIdArg(idArg);
    const entries = this.manager.entries();
    const current = entries.find((entry) => entry.id === id);
    if (!current) throw ServiceError.notfound(`unknown service: ${id}`, 'id');
    const body: unknown = whole ?? patch;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw ServiceError.invalid('patch must be a JSON object', 'patch');
    }
    const raw = body as Record<string, unknown>;
    if (raw.id !== undefined && (typeof raw.id !== 'string' || raw.id.trim() !== id)) {
      throw ServiceError.invalid('id cannot be changed; remove the entry and add a new one', 'id');
    }
    const entry = normalizeEntry({ ...raw, id }, current);
    const next = entries.map((item) => (item.id === id ? entry : item));
    validateServices(next);
    await this.saveServices(next);
    this.log.info('服务条目已更新', { id });
    return this.panelState();
  }

  private async removeService(idArg: unknown): Promise<PanelState> {
    const id = this.serviceIdArg(idArg);
    const entries = this.manager.entries();
    const next = entries.filter((entry) => entry.id !== id);
    if (next.length === entries.length) throw ServiceError.notfound(`unknown service: ${id}`, 'id');
    await this.saveServices(next);
    this.log.info('服务条目已删除', { id });
    return this.panelState();
  }

  private async reorderServices(args: unknown[]): Promise<PanelState> {
    const entries = this.manager.entries();
    let ids: string[];
    if (Array.isArray(args[0])) {
      ids = args[0].map((value) => this.serviceIdArg(value));
    } else if (args.length > 1 && typeof args[1] === 'string') {
      // 也接受扁平顺序:reorder(ids...)
      ids = args.map((value) => this.serviceIdArg(value));
    } else {
      const id = this.serviceIdArg(args[0]);
      const index = Number(args[1]);
      if (!Number.isInteger(index) || index < 0 || index >= entries.length) {
        throw ServiceError.invalid('index is out of range', 'index');
      }
      ids = entries.map((entry) => entry.id).filter((item) => item !== id);
      ids.splice(index, 0, id);
    }
    const current = new Set(entries.map((entry) => entry.id));
    if (ids.length !== current.size || new Set(ids).size !== ids.length
      || ids.some((id) => !current.has(id))) {
      throw ServiceError.invalid('reorder must list every service id exactly once', 'ids');
    }
    const byId = new Map(entries.map((entry) => [entry.id, entry] as const));
    await this.saveServices(ids.map((id) => byId.get(id)!));
    return this.panelState();
  }

  private async controlService(
    action: 'start' | 'stop' | 'restart' | 'probe',
    idArg: unknown,
  ): Promise<PanelState> {
    const id = this.serviceIdArg(idArg);
    const entry = this.manager.entries().find((item) => item.id === id);
    if (!entry) throw ServiceError.notfound(`unknown service: ${id}`, 'id');
    if ((action === 'start' || action === 'restart') && !entry.enabled) {
      throw ServiceError.invalid(`service ${id} is disabled; enable it first`, 'id');
    }
    const status = action === 'start' ? await this.manager.start(id)
      : action === 'stop' ? await this.manager.stop(id)
        : action === 'restart' ? await this.manager.restart(id)
          : await this.manager.probe(id);
    if (!status) throw ServiceError.notfound(`unknown service: ${id}`, 'id');
    if (status.phase === 'online') await this.refreshCatalog(entry);
    return this.panelState();
  }

  private async discoverServices(args: unknown[]): Promise<PanelModels> {
    let entries: readonly ServiceEntry[];
    if (args[0] !== undefined && args[0] !== null && args[0] !== '') {
      const id = this.serviceIdArg(args[0]);
      const entry = this.manager.entries().find((item) => item.id === id);
      if (!entry) throw ServiceError.notfound(`unknown service: ${id}`, 'id');
      entries = [entry];
    } else {
      entries = this.manager.entries().filter((entry) => entry.enabled && protocolOf(entry) !== 'none');
    }
    await Promise.all(entries.map(async (entry) => {
      try {
        await this.catalog.refresh(entry);
      } catch (error) {
        this.log.warn('模型目录刷新失败', { service: entry.id, err: errorMessage(error) });
      }
    }));
    return this.panelModels();
  }

  /**
   * 写一个 .env 令牌。`name` 缺省用 cfg.tokenSecret;网关变量名还没配时,
   * 第一个新名字直接成为 cfg.tokenSecret。只回 tokenSet,值不出这个进程。
   */
  private setToken(args: unknown[]): PanelTokenResult {
    const rawName = typeof args[0] === 'string' ? args[0].trim() : '';
    const configuredName = this.opts.cfg.tokenSecret.trim();
    // 面板总是给 [name, value];只给一个字符串时按网关令牌的值处理。
    const oneArg = args.length < 2 || args[1] === undefined;
    const value = oneArg ? rawName : (typeof args[1] === 'string' ? args[1].trim() : '');
    const name = oneArg ? configuredName : (rawName || configuredName);
    if (!name) throw ServiceError.invalid('token variable name is required', 'name');
    if (!ENV_NAME_RE.test(name)) {
      throw ServiceError.invalid(`"${name}" is not an environment variable name`, 'name');
    }
    if (value && /\s/.test(value)) {
      throw ServiceError.invalid('token value must not contain whitespace', 'value');
    }
    if (!this.opts.storeSecret && !this.opts.clearSecret) {
      throw new Error('this host does not expose storeSecret');
    }

    const entries = this.manager.entries();
    const gateway = name === configuredName;
    const serviceSecret = entries.some((entry) => entry.secretName?.trim() === name);
    const adoptGateway = !gateway && !serviceSecret && !configuredName;
    if (!gateway && !serviceSecret && !adoptGateway) {
      throw ServiceError.invalid(`unknown token variable: ${name}`, 'name');
    }

    if (adoptGateway) {
      this.opts.persist?.({ tokenSecret: name });
      this.opts.cfg.tokenSecret = name;
    }
    if (value) this.opts.storeSecret?.(name, value);
    else if (this.opts.clearSecret) this.opts.clearSecret(name);
    else this.opts.storeSecret?.(name, '');

    if (gateway || adoptGateway) this.scheduleWorldRestart();
    return { tokenSet: value !== '' };
  }

  private scheduleWorldRestart(): void {
    const restart = this.opts.restart;
    if (!this.started || !restart) return;
    const timer = setTimeout(() => {
      void restart().catch((error: unknown) => {
        this.log.warn('服务 World 重启失败', { err: errorMessage(error) });
      });
    }, 300);
    timer.unref?.();
  }

  private serviceIdArg(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) {
      throw ServiceError.invalid('id is required', 'id');
    }
    return value.trim();
  }

  private async saveServices(next: readonly ServiceEntry[]): Promise<void> {
    const list = next.map((entry) => ({ ...entry }));
    await this.manager.setServices(list);
    this.catalog.seed(list);
  }

  private entryTokenSet(entry: ServiceEntry): boolean {
    const name = entry.secretName?.trim();
    return Boolean(name) && this.secretOf(name!).trim() !== '';
  }

  private token(): string {
    const name = this.opts.cfg.tokenSecret.trim();
    return name ? (this.secretOf(name) ?? '').trim() : '';
  }

  private handlers(): GatewayHandlers {
    return {
      health: () => this.healthBody(),
      models: () => this.modelList(),
      voices: (query) => this.voiceList(query),
      speech: (request, signal) => this.speech(request, signal),
      sing: (request, signal) => this.sing(request, signal),
      systemone: (request, signal) => this.systemone(request, signal),
      embeddings: (request, signal) => this.embeddings(request, signal),
      rerank: (request, signal) => this.rerank(request, signal),
    };
  }

  private healthBody(): GatewayHealthBody {
    const statuses = this.manager.status();
    const enabled = statuses.filter((status) => status.entry.enabled);
    const online = enabled.filter((status) => status.phase === 'online').length;
    const failed = enabled.filter((status) => status.phase === 'error');
    const starting = enabled.filter((status) => status.phase === 'starting').length;
    const total = enabled.length;
    const catalogue = this.catalog.models(enabled.map((status) => status.entry)).length;
    const supervised = enabled.reduce((sum, status) => sum + status.models, 0);
    const models = catalogue || supervised;

    let phase: GatewayPhase;
    if (!this.started) phase = 'off';
    else if (this.gatewayError || !this.gateway) phase = 'error';
    else if (starting > 0) phase = 'starting';
    else if (total > 0 && online === total) phase = 'ok';
    else if (failed.length > 0) phase = 'error';
    else phase = 'degraded';

    return {
      status: phase,
      ready: this.gateway !== null && online > 0,
      version: SERVICE_VERSION,
      uptimeSec: this.startedAt ? Math.max(0, Math.round((Date.now() - this.startedAt) / 1000)) : 0,
      services: statuses,
      models,
    };
  }

  private gatewayDetail(health: GatewayHealthBody): string {
    if (!this.started) return 'not started';
    if (this.gatewayError) return this.gatewayError;
    if (!this.gateway) return 'gateway is not listening';
    const enabled = health.services.filter((status) => status.entry.enabled);
    const online = enabled.filter((status) => status.phase === 'online').length;
    const total = enabled.length;
    switch (health.status) {
      case 'ok': return `${online}/${total} services online`;
      case 'starting': return `${online}/${total} services online, starting`;
      case 'error': {
        const failed = enabled.find((status) => status.phase === 'error');
        return failed?.detail ?? 'service failed';
      }
      case 'degraded': return online > 0 ? `${online}/${total} services online` : 'no service online';
      default: return 'not started';
    }
  }

  private modelList(): GatewayModel[] {
    const entries = this.manager.entries().filter((entry) => protocolOf(entry) !== 'none');
    return this.catalog.models(entries).map((model) => ({
      id: model.id,
      object: 'model',
      owned_by: 'cortico-world-service',
      service: model.service,
      ...(model.label ? { display_name: model.label } : {}),
      tasks: model.tasks,
      voices: model.voices,
      ...(model.parameters?.length ? { parameters: model.parameters } : {}),
    }));
  }

  private async voiceList(query: { model?: string; service?: string }): Promise<GatewayVoiceList> {
    let entries = this.manager.entries().filter((entry) => entry.enabled && protocolOf(entry) !== 'none');
    if (query.service) {
      const entry = entries.find((item) => item.id === query.service);
      if (!entry) throw ServiceError.notfound(`unknown service: ${query.service}`, 'service');
      entries = [entry];
    }
    let selected: { model: ModelRecord; entry: ServiceEntry } | undefined;
    if (query.model) {
      selected = this.catalog.find(query.model, entries);
      if (!selected) throw ServiceError.notfound(`unknown model: ${query.model}`, 'model');
    } else {
      const preferred = this.opts.cfg.defaultSpeechModel.trim();
      if (preferred) selected = this.catalog.find(preferred, entries);
      if (!selected) {
        const first = this.catalog.models(entries)[0];
        if (first) {
          const entry = entries.find((item) => item.id === first.service);
          if (entry) selected = { model: first, entry };
        }
      }
      if (!selected) throw ServiceError.notfound('no model available', 'model');
    }

    let voices = selected.model.voices;
    if (!voices.length) {
      const adapter = adapterOf(selected.entry);
      if (adapter.listVoices) {
        try {
          const live = await adapter.listVoices({
            entry: selected.entry,
            model: selected.model.id,
            timeoutMs: Math.min(8000, this.timeoutMs()),
            fetch: this.fetchImpl,
            secret: (name) => this.secretOf(name),
          });
          if (live.length) {
            this.catalog.setVoices(selected.entry.id, selected.model.id, live);
            voices = live.map((voice) => voice.value);
          }
        } catch {
          // 上游列不出音色时返回空列表,不挡模型。
        }
      }
    }

    return {
      model: selected.model.id,
      voices,
      data: voices.map((value) => ({
        id: `${selected.entry.id}:${selected.model.id}:${value}`,
        value,
        label: value,
        model: selected.model.id,
        service: selected.entry.id,
      })),
    };
  }

  private selectSpeech(requested?: string): { entry: ServiceEntry; model?: ModelRecord } {
    const entries = this.manager.entries().filter((entry) => entry.enabled && acceptsSpeech(entry));
    const wanted = requested?.trim();
    if (wanted) {
      const found = this.catalog.find(wanted, entries);
      if (found) return { entry: found.entry, model: found.model };
      if (entries.length === 1) {
        return { entry: entries[0]!, model: this.syntheticModel(entries[0]!, wanted) };
      }
      throw ServiceError.notfound(`unknown model: ${wanted}`, 'model');
    }

    const preferred = this.opts.cfg.defaultSpeechModel.trim();
    if (preferred) {
      const found = this.catalog.find(preferred, entries);
      if (found) return { entry: found.entry, model: found.model };
      if (entries.length === 1) {
        return { entry: entries[0]!, model: this.syntheticModel(entries[0]!, preferred) };
      }
    }
    const first = this.catalog.models(entries)[0];
    if (first) {
      const entry = entries.find((item) => item.id === first.service);
      if (entry) return { entry, model: first };
    }
    if (entries.length === 1) return { entry: entries[0]! };
    if (!entries.length) throw ServiceError.unavailable('no speech service configured');
    throw ServiceError.notfound('no speech model available', 'model');
  }

  private selectSing(requested?: string): { entry: ServiceEntry; model?: ModelRecord } {
    const entries = this.manager.entries().filter((entry) => entry.enabled && acceptsSing(entry));
    const wanted = requested?.trim();
    if (wanted) {
      const found = this.catalog.find(wanted, entries);
      if (found) return { entry: found.entry, model: found.model };
      if (entries.length === 1) {
        return { entry: entries[0]!, model: this.syntheticModel(entries[0]!, wanted) };
      }
      throw ServiceError.notfound(`unknown singing model: ${wanted}`, 'model');
    }
    const preferred = this.opts.cfg.defaultSpeechModel.trim();
    if (preferred) {
      const found = this.catalog.find(preferred, entries);
      if (found) return { entry: found.entry, model: found.model };
      if (entries.length === 1) {
        return { entry: entries[0]!, model: this.syntheticModel(entries[0]!, preferred) };
      }
    }
    const online = entries.find((entry) => this.manager.statusOf(entry.id)?.phase === 'online');
    if (online) return { entry: online };
    if (entries[0]) return { entry: entries[0] };
    throw ServiceError.unavailable('no singing service configured');
  }

  private syntheticModel(entry: ServiceEntry, id: string): ModelRecord {
    return {
      id,
      voices: [],
      tasks: tasksOfEntry(entry),
      service: entry.id,
      source: 'config',
    };
  }

  private timeoutMs(): number {
    const value = this.opts.cfg.requestTimeoutSec;
    return (Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_SEC) * 1000;
  }

  private async speech(request: SpeechRequest, signal: AbortSignal): Promise<TtsAudio> {
    const selected = this.selectSpeech(request.model);
    const status = this.manager.statusOf(selected.entry.id);
    if (!status || status.phase !== 'online') {
      throw ServiceError.unavailable(`service ${selected.entry.id} is not ready`);
    }
    const modelId = request.model ?? selected.model?.id;
    const profile = resolveProfile(selected.entry, modelId);
    const built = buildSpeech(profile, {
      ...request,
      ...(modelId ? { model: modelId } : {}),
    }, selected.entry.options ?? {});
    const adapter = adapterOf(selected.entry);
    return adapter.speech({
      entry: selected.entry,
      body: built.body,
      values: built.values,
      format: built.format,
      timeoutMs: this.timeoutMs(),
      signal,
      fetch: this.fetchImpl,
      secret: (name) => this.secretOf(name),
      log: this.log,
    });
  }

  private async sing(request: SingRequest, signal: AbortSignal): Promise<TtsAudio> {
    const selected = this.selectSing(request.model);
    const status = this.manager.statusOf(selected.entry.id);
    if (!status || status.phase !== 'online') {
      throw ServiceError.unavailable(`singing service ${selected.entry.id} is not ready`);
    }
    const modelId = request.model ?? selected.model?.id;
    const profile = resolveSingProfile(selected.entry);
    const built = buildSing(profile, {
      ...request,
      ...(modelId ? { model: modelId } : {}),
    }, selected.entry.options ?? {});
    const adapter = adapterOf(selected.entry);
    if (!adapter.sing) throw ServiceError.unavailable(`service ${selected.entry.id} does not sing`);
    return adapter.sing({
      entry: selected.entry,
      body: built.body,
      values: built.values,
      format: built.format,
      timeoutMs: this.timeoutMs(),
      signal,
      fetch: this.fetchImpl,
      secret: (name) => this.secretOf(name),
      log: this.log,
    });
  }

  /**
   * 路由模式要求请求带 model。条目配置了 models 就用第一个；否则取目录里该任务的第一个。
   * 单模型服务会忽略这个字段，注入它没有副作用。
   */
  private defaultModelFor(entry: ServiceEntry, task: 'embeddings' | 'rerank'): string | undefined {
    const configured = (entry.models ?? []).map((model) => model.trim()).find(Boolean);
    if (configured) return configured;
    const models = this.catalog.models([entry]);
    return models.find((model) => model.tasks.includes(task))?.id ?? models[0]?.id;
  }

  /** 在启用条目里按模型任务和 model 选一个;没有 model 时按配置顺序取第一个。 */
  private selectJsonEntry(
    task: 'systemone' | 'embeddings' | 'rerank',
    requested: string | undefined,
    label: string,
  ): ServiceEntry {
    const entries = this.manager.entries()
      .filter((entry) => entry.enabled && tasksOfEntry(entry).includes(task));
    if (!entries.length) throw ServiceError.unavailable(`no ${label} service configured`);
    const wanted = requested?.trim();
    if (!wanted) {
      return entries.find((entry) => this.manager.statusOf(entry.id)?.phase === 'online') ?? entries[0]!;
    }
    const found = this.catalog.find(wanted, entries);
    if (found) return found.entry;
    const configured = entries.find((entry) => (entry.models ?? [])
      .some((model) => model.toLowerCase() === wanted.toLowerCase()));
    if (configured) return configured;
    // 单条目没有歧义,未知模型也透传,和 speech 的行为一致；但已知模型属于别的任务时不能误投。
    if (entries.length === 1) {
      const known = this.catalog.find(wanted, this.manager.entries());
      if (known && known.entry.id !== entries[0]!.id) {
        throw ServiceError.notfound(`model ${wanted} does not handle ${task}`, 'model');
      }
      return entries[0]!;
    }
    throw ServiceError.notfound(`unknown model: ${wanted}`, 'model');
  }

  /** 只记录状态码与延迟,不记录请求或回应的正文。 */
  private async jsonCall(
    label: string,
    entry: ServiceEntry,
    call: () => Promise<JsonResult>,
  ): Promise<JsonResult> {
    const started = Date.now();
    try {
      const result = await call();
      this.log.info(`服务 ${label} 请求完成`, {
        service: entry.id,
        status: result.status,
        ms: Date.now() - started,
      });
      return result;
    } catch (error) {
      this.log.info(`服务 ${label} 请求失败`, {
        service: entry.id,
        status: error instanceof ServiceError ? error.status : 502,
        ms: Date.now() - started,
      });
      throw error;
    }
  }

  private jsonRequest(
    entry: ServiceEntry,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): JsonRequest {
    return {
      entry,
      body,
      timeoutMs: this.timeoutMs(),
      signal,
      fetch: this.fetchImpl,
      secret: (name: string) => this.secretOf(name),
      log: this.log,
    };
  }

  private async systemone(request: SystemOneRequest, signal: AbortSignal): Promise<JsonResult> {
    const entry = this.selectJsonEntry('systemone', request.model, 'systemone');
    const status = this.manager.statusOf(entry.id);
    if (!status || status.phase !== 'online') {
      throw ServiceError.unavailable(`service ${entry.id} is not ready`);
    }
    // 外部 systemone 用条目自己的端点；llama.cpp 托管的 StartLux 用伴生 startlux-decide。
    const companionSecret = typeof entry.options?.systemoneSecretName === 'string'
      ? entry.options.systemoneSecretName.trim()
      : '';
    const target: ServiceEntry = entry.type === 'systemone'
      ? entry
      : {
        ...entry,
        type: 'systemone',
        endpoint: systemoneEndpointOf(entry),
        ...(companionSecret ? { secretName: companionSecret } : {}),
      };
    const adapter = adapterOf(target);
    if (!adapter.systemone) {
      throw ServiceError.unsupported(`service ${entry.id} does not support systemone`);
    }
    const call = adapter.systemone;
    return this.jsonCall('systemone', entry, () => call(this.jsonRequest(target, request.body, signal)));
  }

  private async embeddings(request: EmbeddingsRequest, signal: AbortSignal): Promise<JsonResult> {
    const entry = this.selectJsonEntry('embeddings', request.model, 'llamacpp');
    const status = this.manager.statusOf(entry.id);
    if (!status || status.phase !== 'online') {
      throw ServiceError.unavailable(`service ${entry.id} is not ready`);
    }
    const adapter = adapterOf(entry);
    if (!adapter.embeddings) {
      throw ServiceError.unsupported(`service ${entry.id} does not support embeddings`);
    }
    const body = { ...request.body };
    const requested = typeof body.model === 'string' ? body.model.trim() : '';
    if (!request.model && !requested) {
      const model = this.defaultModelFor(entry, 'embeddings');
      if (model) body.model = model;
    }
    const call = adapter.embeddings;
    return this.jsonCall('embeddings', entry, () => call(this.jsonRequest(entry, body, signal)));
  }

  private async rerank(request: RerankRequest, signal: AbortSignal): Promise<JsonResult> {
    const entry = this.selectJsonEntry('rerank', request.model, 'llamacpp');
    const status = this.manager.statusOf(entry.id);
    if (!status || status.phase !== 'online') {
      throw ServiceError.unavailable(`service ${entry.id} is not ready`);
    }
    const adapter = adapterOf(entry);
    if (!adapter.rerank) {
      throw ServiceError.unsupported(`service ${entry.id} does not support rerank`);
    }
    const body = { ...request.body };
    const requested = typeof body.model === 'string' ? body.model.trim() : '';
    if (!request.model && !requested) {
      const model = this.defaultModelFor(entry, 'rerank');
      if (model) body.model = model;
    }
    const call = adapter.rerank;
    return this.jsonCall('rerank', entry, () => call(this.jsonRequest(entry, body, signal)));
  }

  private async refreshCatalogs(): Promise<void> {
    const online = new Set(
      this.manager.status()
        .filter((status) => status.phase === 'online')
        .map((status) => status.entry.id),
    );
    const entries = this.manager.entries()
      .filter((entry) => entry.enabled && protocolOf(entry) !== 'none' && online.has(entry.id));
    await Promise.all(entries.map(async (entry) => {
      try {
        await this.catalog.refresh(entry);
      } catch (error) {
        this.log.warn('模型目录刷新失败', { service: entry.id, err: errorMessage(error) });
      }
    }));
  }

  private async refreshCatalog(entry: ServiceEntry): Promise<void> {
    if (!this.gateway || !entry.enabled || protocolOf(entry) === 'none') return;
    try {
      await this.catalog.refresh(entry);
    } catch (error) {
      this.log.warn('模型目录刷新失败', { service: entry.id, err: errorMessage(error) });
    }
  }

  private report(status: ServiceStatus): void {
    const host = this.host;
    if (!host) return;
    if (status.phase === 'online' && this.gateway) void this.refreshCatalog(status.entry);
    const type = status.phase === 'online' ? 'service.started'
      : status.phase === 'error' ? 'service.failed'
        : status.phase === 'off' ? 'service.stopped' : '';
    if (!type) return;
    const name = status.entry.name;
    const text = status.phase === 'online'
      ? `service ${name} is online at ${status.baseUrl} (${status.backend || status.entry.type}, ${status.models} models).`
      : status.phase === 'error'
        ? `service ${name} failed: ${status.detail}`
        : `service ${name} stopped.`;
    void host.pushEvent({
      type,
      ts: nowIso(this.opts.timezone),
      source: this.id,
      origin: 'internal',
      senderKey: `${this.id}:${status.entry.id}`,
      text,
      meta: { ...status },
    }, { deliver: false }).catch((error: unknown) => {
      this.log.warn('服务状态事件投递失败', { err: errorMessage(error) });
    });
  }
}
