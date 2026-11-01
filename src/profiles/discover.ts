/**
 * 服务目录发现:`GET /v1/models`,`GET /v1/audio/voices?model=`,audiocpp 另外读
 * `server.json` 与 `model_specs/*.json`(只读、单文件上限 2 MiB、schema_version=1、
 * category=tts)。读不到时保留上次目录并标 stale,不让整个服务失败。
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';
import { errorMessage } from '../errors.ts';
import {
  apiUrl, authHeaders, errorSnippet, parseJson, parseVoices, timedFetch,
} from '../protocol/http.ts';
import { serviceBaseUrl } from '../supervisor.ts';
import type {
  ModelRecord, ServiceCatalog, ServiceEntry, VoiceOption,
} from '../types.ts';

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
  return parseVoices(list).map((voice) => voice.value);
}

function recordOf(item: unknown, entry: ServiceEntry, source: ModelRecord['source']): ModelRecord | null {
  if (typeof item === 'string') {
    const id = item.trim();
    return id ? {
      id, voices: [], tasks: entry.protocol === 'sing' ? [TASK_SING] : [TASK_TTS], service: entry.id, source,
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
  return {
    id: id.slice(0, 200),
    ...(label ? { label: label.slice(0, 200) } : {}),
    voices: voicesOf(item),
    tasks: tasksOf(item, entry.protocol === 'sing' ? [TASK_SING] : [TASK_TTS]),
    service: entry.id,
    source,
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
      voices: [...new Set([...existing.voices, ...model.voices])],
      tasks: [...new Set([...existing.tasks, ...model.tasks])],
      source: existing.source === 'api' ? existing.source : model.source,
    });
  }
  return [...byId.values()];
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
    if (entry.protocol === 'none') {
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
      let models = entry.models?.length ? seeded : await this.fetchModels(entry);
      if (entry.kind === 'audiocpp' || entry.protocol === 'audiocpp') {
        models = mergeModels(models, await this.readAudiocppSpecs(entry));
        models = await this.attachVoices(entry, models);
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
    const data = await timedFetch(this.io.fetch, apiUrl(serviceBaseUrl(entry), '/models'), {
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
          const url = new URL(apiUrl(serviceBaseUrl(entry), '/audio/voices'));
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

  /** server.json + model_specs/*.json;任何文件读失败都只跳过它。 */
  private async readAudiocppSpecs(entry: ServiceEntry): Promise<ModelRecord[]> {
    const serverDir = entry.serverDir?.trim() ?? '';
    const configPath = entry.configPath?.trim() ?? '';
    const baseDir = serverDir || (configPath ? dirname(configPath) : '');
    if (!baseDir) return [];

    const found: ModelRecord[] = [];
    const serverPath = configPath || join(baseDir, 'server.json');
    const serverText = await this.readGuarded(serverPath);
    if (serverText) found.push(...this.modelsFromServerJson(entry, parseJson(serverText)));

    const specsDir = join(baseDir, 'model_specs');
    let files: string[] = [];
    try {
      files = await this.io.readdir(specsDir);
    } catch {
      files = [];
    }
    for (const name of files) {
      if (extname(name).toLowerCase() !== '.json') continue;
      const path = join(specsDir, name);
      const text = await this.readGuarded(path);
      if (!text) continue;
      found.push(...this.modelsFromSpec(entry, parseJson(text), name));
    }
    return found;
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

  private modelsFromSpec(entry: ServiceEntry, data: unknown, fileName: string): ModelRecord[] {
    if (!isPlainObject(data)) return [];
    if (data.schema_version !== 1 || data.category !== 'tts') return [];
    const fallbackId = basename(fileName, extname(fileName));
    const models: ModelRecord[] = [];
    if (Array.isArray(data.models)) {
      for (const item of data.models) {
        const record = recordOf(item, entry, 'spec');
        if (record) models.push(record);
      }
    }
    const nested = data.model;
    const topIsModel = typeof data.id === 'string' || typeof data.name === 'string'
      || typeof data.model === 'string' || (!Array.isArray(data.models) && !isPlainObject(nested));
    if (topIsModel) {
      const id = typeof data.id === 'string'
        ? data.id
        : typeof data.model === 'string' ? data.model : fallbackId;
      const top = recordOf({ ...data, id }, entry, 'spec');
      if (top) models.push(top);
    }
    if (isPlainObject(nested)) {
      const record = recordOf({ ...nested, id: nested.id ?? data.id ?? fallbackId }, entry, 'spec');
      if (record) models.push(record);
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
