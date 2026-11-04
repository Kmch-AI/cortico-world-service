/**
 * 服务目录发现:只列真实存在的模型。audiocpp 用 `server.json` 声明的模型加
 * `GET /v1/models`;其余协议只用 `GET /v1/models` 或条目里配置的 models。
 * `model_specs/*.json` 只按 family/id 补元数据(标签、任务、音色、请求参数),
 * 永远不新增模型。读不到时保留上次目录并标 stale,不让整个服务失败。
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';
import { endpointUrl, protocolOf, serverJsonPath } from '../entry.ts';
import { errorMessage } from '../errors.ts';
import {
  apiUrl, authHeaders, errorSnippet, parseJson, parseVoices, timedFetch,
} from '../protocol/http.ts';
import type {
  ModelParameter, ModelParameterType, ModelRecord, ServiceCatalog, ServiceEntry, VoiceOption,
} from '../types.ts';
import { resolveProfile } from './resolve.ts';

export interface DiscoveryIo {
  fetch: typeof fetch;
  readFile(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ size: number }>;
  now(): number;
}

export interface CatalogOptions {
  fetch?: typeof fetch;
  readFile?(path: string): Promise<string>;
  readdir?(path: string): Promise<string[]>;
  stat?(path: string): Promise<{ size: number }>;
  now?(): number;
  secret?(name: string): string;
  log?: Logger;
  /** 单次发现请求的超时;默认 8 秒。 */
  timeoutMs?: number;
  /** 单个发现文件的上限;默认 2 MiB。 */
  maxFileBytes?: number;
  /** 一次最多收下的模型数;默认 200。 */
  maxModels?: number;
  /** 查询音色的模型数上限;默认 50。 */
  maxVoiceModels?: number;
}

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_MODELS = 200;
const DEFAULT_MAX_VOICE_MODELS = 50;
const VOICE_BATCH = 8;
const TASK_TTS = 'tts';
const TASK_SING = 'sing';
const PARAMETER_TYPES: ReadonlySet<string> = new Set<ModelParameterType>([
  'string', 'enum', 'bool', 'int', 'float', 'string_list', 'path', 'path_list',
]);
/** 这几个字段由插件自己填,不进模型的 UI 参数表。 */
const SUPPLIED_PARAMETERS: ReadonlySet<string> = new Set(['text', 'prompt', 'input', 'language']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function defaultIo(opts: CatalogOptions): DiscoveryIo {
  return {
    fetch: opts.fetch ?? ((input, init) => fetch(input, init)),
    readFile: opts.readFile ?? ((path) => readFile(path, 'utf8')),
    readdir: opts.readdir ?? ((path) => readdir(path)),
    stat: opts.stat ?? (async (path) => {
      const info = await stat(path);
      return { size: info.size };
    }),
    now: opts.now ?? (() => Date.now()),
  };
}

/** 上游没声明 tasks 时按协议给默认值;llamacpp 与 systemone 不是语音模型。 */
function defaultTasksOf(entry: ServiceEntry): string[] {
  switch (protocolOf(entry)) {
    case 'sing': return [TASK_SING];
    case 'llamacpp': return ['embeddings', 'rerank'];
    case 'systemone': return ['chat'];
    default: return [TASK_TTS];
  }
}

function tasksOf(raw: Record<string, unknown>, fallback: string[]): string[] {
  const source = Array.isArray(raw.tasks) ? raw.tasks
    : Array.isArray(raw.capabilities) ? raw.capabilities
      : typeof raw.category === 'string' ? [raw.category] : [];
  const tasks = source.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    .map((item) => item.trim());
  return tasks.length ? tasks : fallback;
}

function voicesOf(raw: Record<string, unknown>): string[] {
  const list = Array.isArray(raw.voices) ? raw.voices
    : Array.isArray(raw.data) ? raw.data
      : [];
  const voices = parseVoices(list).map((voice) => voice.value);
  // audiocpp 的 server.json 用 voice_presets 的对象键声明音色;默认音色排在最前。
  if (isPlainObject(raw.voice_presets)) {
    const presets = raw.voice_presets;
    const preferred = typeof raw.default_voice_preset === 'string' ? raw.default_voice_preset.trim() : '';
    if (preferred && Object.prototype.hasOwnProperty.call(presets, preferred)) voices.push(preferred);
    for (const key of Object.keys(presets)) {
      if (key !== preferred) voices.push(key);
    }
  }
  return [...new Set(voices)];
}

/** 上游 `options.request` 里可展示的参数;跳过插件自填的正文/语言字段。 */
function parametersOf(raw: unknown): ModelParameter[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ModelParameter[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isPlainObject(item)) continue;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const type = typeof item.type === 'string' ? item.type : '';
    if (!name || seen.has(name) || SUPPLIED_PARAMETERS.has(name) || !PARAMETER_TYPES.has(type)) continue;
    const parameter: ModelParameter = { name, type: type as ModelParameterType };
    if (typeof item.description === 'string' && item.description.trim()) {
      parameter.description = item.description.trim();
    }
    const values = Array.isArray(item.values)
      ? item.values.filter((value): value is string => typeof value === 'string')
      : [];
    if (values.length) parameter.values = values;
    if (item.default !== undefined) parameter.default = item.default;
    if (typeof item.min === 'number' && Number.isFinite(item.min)) parameter.min = item.min;
    if (typeof item.max === 'number' && Number.isFinite(item.max)) parameter.max = item.max;
    seen.add(name);
    out.push(parameter);
  }
  return out.length ? out : undefined;
}

function recordOf(item: unknown, entry: ServiceEntry, source: ModelRecord['source']): ModelRecord | null {
  if (typeof item === 'string') {
    const id = item.trim();
    return id ? {
      id, voices: [], tasks: defaultTasksOf(entry), service: entry.id, source,
    } : null;
  }
  if (!isPlainObject(item)) return null;
  const id = typeof item.id === 'string' ? item.id.trim()
    : typeof item.name === 'string' ? item.name.trim()
      : typeof item.model === 'string' ? item.model.trim() : '';
  if (!id) return null;
  const label = typeof item.display_name === 'string' ? item.display_name.trim()
    : typeof item.displayName === 'string' ? item.displayName.trim()
      : typeof item.label === 'string' ? item.label.trim()
        : typeof item.title === 'string' ? item.title.trim()
          : typeof item.name === 'string' ? item.name.trim() : '';
  const family = typeof item.family === 'string' ? item.family.trim() : '';
  const parameters = parametersOf(item.parameters);
  return {
    id: id.slice(0, 200),
    ...(label ? { label: label.slice(0, 200) } : {}),
    voices: voicesOf(item),
    tasks: tasksOf(item, defaultTasksOf(entry)),
    service: entry.id,
    source,
    ...(family ? { family: family.slice(0, 200) } : {}),
    ...(parameters ? { parameters } : {}),
  };
}

function mergeModels(current: ModelRecord[], incoming: ModelRecord[]): ModelRecord[] {
  const byId = new Map<string, ModelRecord>();
  for (const model of current) byId.set(model.id, model);
  for (const model of incoming) {
    const existing = byId.get(model.id);
    if (!existing) {
      byId.set(model.id, model);
      continue;
    }
    byId.set(model.id, {
      ...existing,
      ...(model.label ? { label: model.label } : {}),
      ...(model.family ? { family: model.family } : {}),
      ...(model.parameters ? { parameters: model.parameters } : {}),
      voices: [...new Set([...existing.voices, ...model.voices])],
      tasks: [...new Set([...existing.tasks, ...model.tasks])],
      source: existing.source === 'api' ? existing.source : model.source,
    });
  }
  return [...byId.values()];
}

/** family/id 归一到只留字母数字,用来匹配 spec 文件名与 server.json 的 family。 */
function modelKey(value: string | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

interface SpecMeta {
  family: string;
  label?: string;
  tasks: string[];
  voices: string[];
  parameters?: ModelParameter[];
}

function specMetaOf(data: unknown): SpecMeta | null {
  if (!isPlainObject(data)) return null;
  // 0.9.3 的 spec 有的带 schema_version=1,有的没有;只拒绝明确不同的版本与非 TTS。
  if (data.schema_version !== undefined && data.schema_version !== 1) return null;
  if (typeof data.category === 'string' && data.category !== 'tts') return null;
  const family = typeof data.family === 'string' ? data.family.trim() : '';
  const label = typeof data.display_name === 'string' ? data.display_name.trim() : '';
  const options = isPlainObject(data.options) ? data.options : {};
  const parameters = parametersOf(options.request);
  return {
    family,
    ...(label ? { label: label.slice(0, 200) } : {}),
    tasks: tasksOf(data, [TASK_TTS]),
    voices: voicesOf(data),
    ...(parameters ? { parameters } : {}),
  };
}

function specMatches(meta: SpecMeta, model: ModelRecord): boolean {
  if (!meta.family) return true;
  const family = modelKey(meta.family);
  if (!family) return true;
  return [model.family, model.id].some((value) => {
    const key = modelKey(value);
    return key !== '' && (key === family || key.startsWith(family) || family.startsWith(key));
  });
}

/**
 * 面板只展示 profile 真正接受的参数;spec 只补说明与默认值。
 * `ui:false` 留给由语音朗读风格控制的字段,其余 Ming / IndexTTS2 参数照常进入模型页,
 * 也避免语音发出会被服务拒绝的 options。
 */
function profileParameters(
  entry: ServiceEntry,
  model: ModelRecord,
  meta: SpecMeta | undefined,
): ModelParameter[] | undefined {
  const profile = resolveProfile(entry, model.id);
  const options = (profile.options ?? []).filter((option) => option.ui !== false);
  if (!options.length) return undefined;
  const spec = new Map((meta?.parameters ?? []).map((parameter) => [parameter.name, parameter]));
  return options.map((option) => {
    const parameter: ModelParameter = { name: option.name, type: option.type };
    const description = option.description ?? spec.get(option.name)?.description;
    if (description) parameter.description = description;
    const values = option.values ?? spec.get(option.name)?.values;
    if (values?.length) parameter.values = values;
    const fallback = spec.get(option.name);
    const value = option.default ?? fallback?.default;
    if (value !== undefined) parameter.default = value;
    const min = option.min ?? fallback?.min;
    if (min !== undefined) parameter.min = min;
    const max = option.max ?? fallback?.max;
    if (max !== undefined) parameter.max = max;
    return parameter;
  });
}

function enrichModel(entry: ServiceEntry, model: ModelRecord, meta: SpecMeta | undefined): ModelRecord {
  const parameters = profileParameters(entry, model, meta);
  const next: ModelRecord = {
    ...model,
    ...(meta?.label ? { label: meta.label } : {}),
    ...(meta && meta.tasks.length ? { tasks: meta.tasks } : {}),
    voices: [...new Set([...model.voices, ...(meta?.voices ?? [])])],
  };
  if (parameters) next.parameters = parameters;
  else delete next.parameters;
  return next;
}

function configuredModels(entry: ServiceEntry): ModelRecord[] {
  return (entry.models ?? [])
    .map((id) => recordOf(id, entry, 'config'))
    .filter((model): model is ModelRecord => model !== null);
}

export class ModelCatalog {
  private readonly io: DiscoveryIo;
  private readonly log?: Logger;
  private readonly secret: (name: string) => string;
  private readonly timeoutMs: number;
  private readonly maxFileBytes: number;
  private readonly maxModels: number;
  private readonly maxVoiceModels: number;
  private readonly byService = new Map<string, ServiceCatalog>();
  private readonly inflight = new Map<string, Promise<ServiceCatalog>>();

  constructor(opts: CatalogOptions = {}) {
    this.io = defaultIo(opts);
    this.log = opts.log;
    this.secret = opts.secret ?? (() => '');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxModels = opts.maxModels ?? DEFAULT_MAX_MODELS;
    this.maxVoiceModels = opts.maxVoiceModels ?? DEFAULT_MAX_VOICE_MODELS;
  }

  /** 先给每个条目一份只含配置模型的目录,发现失败时也有东西可报。 */
  seed(entries: readonly ServiceEntry[]): void {
    const live = new Set(entries.map((entry) => entry.id));
    for (const id of [...this.byService.keys()]) {
      if (!live.has(id)) this.byService.delete(id);
    }
    for (const entry of entries) {
      const existing = this.byService.get(entry.id);
      const models = existing?.models?.length ? existing.models : configuredModels(entry);
      if (existing) {
        existing.service = entry.id;
        if (!existing.models.length && models.length) existing.models = models;
        continue;
      }
      this.byService.set(entry.id, {
        service: entry.id,
        models,
        stale: false,
        detail: models.length ? 'configured models' : 'not discovered',
        updatedAt: 0,
      });
    }
  }

  get(service: string): ServiceCatalog | undefined {
    return this.byService.get(service);
  }

  clear(): void {
    this.byService.clear();
    this.inflight.clear();
  }

  /** 刷新一个条目;失败时保留上次结果。 */
  refresh(entry: ServiceEntry): Promise<ServiceCatalog> {
    const running = this.inflight.get(entry.id);
    if (running) return running;
    const task = this.refreshOnce(entry).finally(() => { this.inflight.delete(entry.id); });
    this.inflight.set(entry.id, task);
    return task;
  }

  private async refreshOnce(entry: ServiceEntry): Promise<ServiceCatalog> {
    const previous = this.byService.get(entry.id);
    const seeded = configuredModels(entry);
    if (!entry.enabled) {
      const catalog: ServiceCatalog = {
        service: entry.id,
        models: previous?.models ?? seeded,
        stale: false,
        detail: 'disabled',
        updatedAt: this.io.now(),
      };
      this.byService.set(entry.id, catalog);
      return catalog;
    }
    if (protocolOf(entry) === 'none') {
      const catalog: ServiceCatalog = {
        service: entry.id,
        models: previous?.models ?? seeded,
        stale: false,
        detail: 'no HTTP protocol',
        updatedAt: this.io.now(),
      };
      this.byService.set(entry.id, catalog);
      return catalog;
    }

    try {
      let models: ModelRecord[];
      if (protocolOf(entry) === 'audiocpp') {
        models = await this.collectAudiocppModels(entry);
        models = await this.attachVoices(entry, models);
      } else {
        // openai/custom/sing 只认真实回应;条目显式配置的 models 代替 /v1/models。
        models = entry.models?.length ? seeded : await this.fetchModels(entry);
      }
      models = models.slice(0, this.maxModels);
      const catalog: ServiceCatalog = {
        service: entry.id,
        models,
        stale: false,
        detail: `${models.length} models`,
        updatedAt: this.io.now(),
      };
      this.byService.set(entry.id, catalog);
      return catalog;
    } catch (error) {
      const detail = `discovery failed: ${errorMessage(error)}`;
      this.log?.warn('模型目录发现失败,保留上次结果', { service: entry.id, err: errorMessage(error) });
      const catalog: ServiceCatalog = {
        service: entry.id,
        models: previous?.models ?? seeded,
        stale: true,
        detail,
        updatedAt: this.io.now(),
      };
      this.byService.set(entry.id, catalog);
      return catalog;
    }
  }

  private secretOf(entry: ServiceEntry): string {
    return entry.secretName?.trim() ? this.secret(entry.secretName.trim()) : '';
  }

  private async fetchModels(entry: ServiceEntry): Promise<ModelRecord[]> {
    const data = await timedFetch(this.io.fetch, apiUrl(endpointUrl(entry), '/models'), {
      method: 'GET',
      headers: authHeaders(this.secretOf(entry)),
    }, this.timeoutMs, undefined, async (res) => {
      if (!res.ok) throw new Error(await errorSnippet(res));
      return parseJson(await res.text());
    });
    const list = Array.isArray(data)
      ? data
      : isPlainObject(data) && Array.isArray(data.data) ? data.data
        : isPlainObject(data) && Array.isArray(data.models) ? data.models
          : isPlainObject(data) && Array.isArray(data.items) ? data.items
            : null;
    if (!list) throw new Error('model list is not an array');
    return list
      .slice(0, this.maxModels)
      .map((item) => recordOf(item, entry, 'api'))
      .filter((model): model is ModelRecord => model !== null);
  }

  private async attachVoices(entry: ServiceEntry, models: ModelRecord[]): Promise<ModelRecord[]> {
    if (!models.length || this.maxVoiceModels <= 0) return models;
    const targets = models.slice(0, this.maxVoiceModels);
    const updated = new Map(targets.map((model) => [model.id, model]));
    for (let start = 0; start < targets.length; start += VOICE_BATCH) {
      const batch = targets.slice(start, start + VOICE_BATCH);
      await Promise.all(batch.map(async (model) => {
        try {
          const url = new URL(apiUrl(endpointUrl(entry), '/audio/voices'));
          url.searchParams.set('model', model.id);
          const voices = await timedFetch(this.io.fetch, url.toString(), {
            method: 'GET',
            headers: authHeaders(this.secretOf(entry)),
          }, Math.min(this.timeoutMs, 8000), undefined, async (res) => {
            if (!res.ok) return [] as string[];
            return parseVoices(parseJson(await res.text())).map((voice) => voice.value);
          });
          if (voices.length) updated.set(model.id, { ...model, voices });
        } catch {
          // 音色是补充信息,失败时保留模型列表。
        }
      }));
    }
    return models.map((model) => updated.get(model.id) ?? model);
  }

  /**
   * audiocpp 的真实模型 = server.json 声明的模型 ∪ /v1/models 的 id。
   * 两边都失败才报错;只有一边可用时用那一边。spec 只补元数据。
   */
  private async collectAudiocppModels(entry: ServiceEntry): Promise<ModelRecord[]> {
    let models: ModelRecord[] = [];
    let sourceOk = false;
    let failure: unknown;

    const serverPath = serverJsonPath(entry);
    if (serverPath) {
      const serverText = await this.readGuarded(serverPath);
      const serverData = serverText ? parseJson(serverText) : null;
      if (isPlainObject(serverData)) {
        sourceOk = true;
        models = mergeModels(models, this.modelsFromServerJson(entry, serverData));
      }
    }
    try {
      models = mergeModels(models, await this.fetchModels(entry));
      sourceOk = true;
    } catch (error) {
      failure = error;
    }
    if (!sourceOk) throw failure ?? new Error('no model source');

    const specs = await this.loadSpecs(entry, models);
    return models.map((model) => enrichModel(entry, model, specs.get(model.id)));
  }

  /** 只读实际模型对应的 spec;按 family 或 id 匹配文件名,不枚举成模型。 */
  private async loadSpecs(
    entry: ServiceEntry,
    models: readonly ModelRecord[],
  ): Promise<Map<string, SpecMeta>> {
    const found = new Map<string, SpecMeta>();
    const baseDir = entry.serverDir?.trim() ?? '';
    if (!baseDir || !models.length) return found;

    const specsDir = join(baseDir, 'model_specs');
    let files: string[];
    try {
      files = (await this.io.readdir(specsDir))
        .filter((name) => extname(name).toLowerCase() === '.json');
    } catch {
      return found;
    }
    const byKey = new Map<string, string>();
    for (const name of files) {
      const key = modelKey(basename(name, extname(name)));
      if (key && !byKey.has(key)) byKey.set(key, name);
    }
    if (!byKey.size) return found;

    const cache = new Map<string, SpecMeta | null>();
    for (const model of models) {
      const candidates: string[] = [];
      for (const value of [model.family, model.id]) {
        const key = modelKey(value);
        if (!key) continue;
        const exact = byKey.get(key);
        if (exact) {
          candidates.push(exact);
          continue;
        }
        for (const [fileKey, name] of byKey) {
          // index-tts2.5 这类 id 在还没有专属 spec 时退化到同族 spec。
          if (fileKey.startsWith(key) || key.startsWith(fileKey)) candidates.push(name);
        }
      }
      for (const name of new Set(candidates)) {
        if (!cache.has(name)) cache.set(name, await this.readSpecMeta(join(specsDir, name)));
        const meta = cache.get(name);
        if (meta && specMatches(meta, model)) {
          found.set(model.id, meta);
          break;
        }
      }
    }
    return found;
  }

  private async readSpecMeta(path: string): Promise<SpecMeta | null> {
    const text = await this.readGuarded(path);
    return text ? specMetaOf(parseJson(text)) : null;
  }

  private async readGuarded(path: string): Promise<string | null> {
    try {
      const info = await this.io.stat(path);
      if (info.size > this.maxFileBytes) return null;
    } catch {
      // 没有 stat 或文件不存在;交给 readFile 决定。
    }
    try {
      const text = await this.io.readFile(path);
      if (Buffer.byteLength(text, 'utf8') > this.maxFileBytes) return null;
      return text;
    } catch {
      return null;
    }
  }

  private modelsFromServerJson(entry: ServiceEntry, data: unknown): ModelRecord[] {
    if (!isPlainObject(data)) return [];
    const models: ModelRecord[] = [];
    const globalVoices = voicesOf(data);
    if (Array.isArray(data.models)) {
      for (const item of data.models) {
        const record = recordOf(item, entry, 'spec');
        if (record) models.push(record);
      }
    }
    for (const key of ['model', 'default_model', 'model_name'] as const) {
      const value = data[key];
      if (typeof value === 'string' || isPlainObject(value)) {
        const record = recordOf(value, entry, 'spec');
        if (record) models.push(record);
      }
    }
    if (globalVoices.length) {
      if (!models.length && typeof data.default_model === 'string') {
        models.push({
          id: data.default_model,
          voices: globalVoices,
          tasks: [TASK_TTS],
          service: entry.id,
          source: 'spec',
        });
      } else if (models[0]) {
        models[0] = { ...models[0], voices: [...new Set([...models[0].voices, ...globalVoices])] };
      }
    }
    return models;
  }

  /** 某个条目当前可见的模型;没刷新过的条目按配置模型现取。 */
  models(entries: readonly ServiceEntry[]): ModelRecord[] {
    const out: ModelRecord[] = [];
    for (const entry of entries) {
      if (!entry.enabled) continue;
      const catalog = this.byService.get(entry.id);
      const models = catalog?.models ?? configuredModels(entry);
      for (const model of models) out.push({ ...model, service: entry.id });
    }
    return out;
  }

  find(modelId: string, entries: readonly ServiceEntry[]): { model: ModelRecord; entry: ServiceEntry } | undefined {
    const wanted = modelId.trim();
    if (!wanted) return undefined;
    const models = this.models(entries);
    const exact = models.find((model) => model.id === wanted)
      ?? models.find((model) => model.id.toLowerCase() === wanted.toLowerCase());
    if (!exact) return undefined;
    const entry = entries.find((item) => item.id === exact.service);
    return entry ? { model: exact, entry } : undefined;
  }

  /** 把一次实时音色查询写回目录。 */
  setVoices(service: string, modelId: string, voices: VoiceOption[]): void {
    const catalog = this.byService.get(service);
    if (!catalog || !voices.length) return;
    catalog.models = catalog.models.map((model) => (
      model.id === modelId
        ? { ...model, voices: [...new Set(voices.map((voice) => voice.value))] }
        : model
    ));
  }
}
