/**
 * 模型 profile 的解析与请求拼装。解析顺序:条目 `modelProfile` → 模型 id 的前缀/通配匹配
 * → `openai` 兜底;`entry.modelProfiles` 里的覆盖只合并进内置 profile,不保存派生结果。
 */
import { ServiceError } from '../errors.ts';
import type {
  AudioFormat, ModelField, ModelProfile, ModelProfileOption, ModelProfileVariant,
  ServiceEntry, SingRequest, SpeechRequest,
} from '../types.ts';
import { BUILTIN_BY_ID, BUILTIN_PROFILES } from './builtin.ts';

type SemanticValue = string | number;

export interface BuiltRequest {
  profile: ModelProfile;
  body: Record<string, unknown>;
  values: Record<string, string>;
  format: AudioFormat;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function mergeProfile(base: ModelProfile, override: Partial<ModelProfile>): ModelProfile {
  return {
    id: base.id,
    label: override.label ?? base.label,
    protocol: override.protocol ?? base.protocol,
    match: override.match ?? base.match,
    fields: override.fields ? { ...base.fields, ...override.fields } : base.fields,
    variants: override.variants ?? base.variants,
    options: override.options ?? base.options,
    defaults: override.defaults ? { ...base.defaults, ...override.defaults } : base.defaults,
    speedLevels: override.speedLevels ?? base.speedLevels,
    tags: override.tags ?? base.tags,
    formats: override.formats ?? base.formats,
  };
}

function profileFromOverride(id: string, entry: ServiceEntry, override: Partial<ModelProfile>): ModelProfile {
  const protocol = override.protocol ?? (entry.protocol === 'none' ? 'openai' : entry.protocol);
  return {
    id,
    label: override.label ?? id,
    protocol,
    match: override.match,
    fields: override.fields,
    variants: override.variants,
    options: override.options,
    defaults: override.defaults,
    speedLevels: override.speedLevels,
    tags: override.tags,
    formats: override.formats,
  };
}

/** 条目可见的全部 profile:内置的带覆盖,外加覆盖里新出现的 id。 */
export function profilesOf(entry: ServiceEntry): ModelProfile[] {
  const overrides = entry.modelProfiles ?? {};
  const profiles = BUILTIN_PROFILES.map((base) => {
    const override = overrides[base.id];
    return override ? mergeProfile(base, override) : base;
  });
  for (const [id, override] of Object.entries(overrides)) {
    if (BUILTIN_BY_ID[id]) continue;
    profiles.push(profileFromOverride(id, entry, override));
  }
  return profiles;
}

export function profileOf(entry: ServiceEntry, id: string): ModelProfile | undefined {
  return profilesOf(entry).find((profile) => profile.id === id);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `*` 是通配;没有通配时按精确或前缀匹配。 */
export function matchesModel(pattern: string, modelId: string): boolean {
  const raw = pattern.trim().toLowerCase();
  const id = modelId.trim().toLowerCase();
  if (!raw || !id) return false;
  if (raw === '*') return true;
  if (!raw.includes('*')) return id === raw || id.startsWith(raw);
  const re = new RegExp(`^${raw.split('*').map(escapeRegExp).join('.*')}$`);
  return re.test(id);
}

/** 解析顺序:显式 profile → 模型 id 匹配 → openai。 */
export function resolveProfile(entry: ServiceEntry, modelId?: string): ModelProfile {
  const profiles = profilesOf(entry);
  const named = entry.modelProfile?.trim() ?? '';
  if (named && named !== 'auto') {
    const profile = profiles.find((item) => item.id === named);
    if (profile) return profile;
  }
  const id = modelId?.trim() ?? '';
  if (id) {
    const matched = profiles.find((profile) => profile.match?.some((pattern) => matchesModel(pattern, id)));
    if (matched) return matched;
  }
  return profiles.find((profile) => profile.id === 'openai') ?? profiles[0]!;
}

/** 唱歌条目没有显式 profile 时用内置 sing;它把正文映射成 `lyrics`。 */
export function resolveSingProfile(entry: ServiceEntry): ModelProfile {
  const named = entry.modelProfile?.trim() ?? '';
  if (named && named !== 'auto') {
    const profile = profilesOf(entry).find((item) => item.id === named);
    if (profile) return profile;
  }
  return profileOf(entry, 'sing') ?? resolveProfile(entry);
}

export function speedLevelOf(levels: ModelProfile['speedLevels'], speed: number | undefined): string | undefined {
  if (!levels?.length || speed === undefined || !Number.isFinite(speed)) return undefined;
  const ordered = [...levels].sort((a, b) => a.max - b.max);
  for (const level of ordered) {
    if (speed <= level.max) return level.value;
  }
  return ordered[ordered.length - 1]?.value;
}

function semanticValues(profile: ModelProfile, req: SpeechRequest): Partial<Record<ModelField, SemanticValue>> {
  const out: Partial<Record<ModelField, SemanticValue>> = { text: req.input, format: req.format };
  if (req.voice?.trim()) out.voice = req.voice.trim();
  if (req.model?.trim()) out.model = req.model.trim();
  if (req.instructions?.trim()) out.instruct = req.instructions.trim();
  if (req.emotion?.trim()) out.emotion = req.emotion.trim();
  if (req.language?.trim()) out.language = req.language.trim();
  if (req.speed !== undefined && Number.isFinite(req.speed)) {
    out.speed = req.speed;
    const level = speedLevelOf(profile.speedLevels, req.speed);
    if (level) out.speedLevel = level;
  }
  return out;
}

function presentValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  return value !== undefined && value !== null && value !== false;
}

function matchesVariant(variant: ModelProfileVariant, semantic: Partial<Record<ModelField, SemanticValue>>): boolean {
  const when = variant.when;
  const has = Array.isArray(when.has) ? when.has.filter((item): item is string => typeof item === 'string') : [];
  const not = Array.isArray(when.not) ? when.not.filter((item): item is string => typeof item === 'string') : [];
  for (const field of has) if (!presentValue(semantic[field as ModelField])) return false;
  for (const field of not) if (presentValue(semantic[field as ModelField])) return false;
  for (const [field, expected] of Object.entries(when)) {
    if (field === 'has' || field === 'not') continue;
    const actual = semantic[field as ModelField];
    if (expected === '*') {
      if (!presentValue(actual)) return false;
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}

function semanticValue(
  semantic: Partial<Record<ModelField, SemanticValue>>,
  key: string,
): SemanticValue | undefined {
  const wanted = key.toLowerCase();
  for (const [field, value] of Object.entries(semantic)) {
    if (field.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function substitute(value: unknown, semantic: Partial<Record<ModelField, SemanticValue>>): unknown {
  if (typeof value === 'string') {
    const whole = /^\{\{\s*([a-zA-Z]+)\s*\}\}$/.exec(value);
    if (whole) {
      return semanticValue(semantic, whole[1]!) ?? '';
    }
    return value.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (_, key: string) => {
      const resolved = semanticValue(semantic, key);
      return resolved === undefined ? '' : String(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, semantic));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = substitute(item, semantic);
    return out;
  }
  return value;
}

/** 配置与请求都来自 JSON;挡住会改原型的键。 */
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.').filter(Boolean);
  if (!segments.length || segments.some((segment) => UNSAFE_KEYS.has(segment))) return;
  let cursor = target;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    if (!isPlainObject(next)) cursor[segment] = {};
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]!] = value;
}

function deepMerge(target: Record<string, unknown>, ...sources: Array<Record<string, unknown>>): Record<string, unknown> {
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (UNSAFE_KEYS.has(key)) continue;
      if (isPlainObject(value) && isPlainObject(target[key])) {
        deepMerge(target[key] as Record<string, unknown>, value);
      } else {
        target[key] = value;
      }
    }
  }
  return target;
}

function validateOption(decl: ModelProfileOption, value: unknown): void {
  const param = `options.${decl.name}`;
  switch (decl.type) {
    case 'enum':
      if (typeof value !== 'string' || (decl.values && !decl.values.includes(value))) {
        throw ServiceError.invalid(
          `${param} must be one of ${decl.values?.join(', ') ?? 'the allowed values'}`,
          param,
        );
      }
      return;
    case 'string':
      if (typeof value !== 'string') throw ServiceError.invalid(`${param} must be a string`, param);
      return;
    case 'bool':
      if (typeof value !== 'boolean') throw ServiceError.invalid(`${param} must be a boolean`, param);
      return;
    case 'int':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw ServiceError.invalid(`${param} must be an integer`, param);
      }
      return;
    case 'float':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw ServiceError.invalid(`${param} must be a number`, param);
      }
      return;
  }
}

function validateOptions(profile: ModelProfile, options: Record<string, unknown>): void {
  for (const decl of profile.options ?? []) {
    if (options[decl.name] === undefined) continue;
    validateOption(decl, options[decl.name]);
  }
}

function stringValues(semantic: Partial<Record<ModelField, SemanticValue>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(semantic)) {
    if (value !== undefined) out[key] = String(value);
  }
  out.speed ??= '1';
  return out;
}

/** 按 profile 拼出上游请求体;options 的优先级:选项默认值 < 条目 options < variant < 请求 options。 */
export function buildSpeech(
  profile: ModelProfile,
  req: SpeechRequest,
  entryOptions: Record<string, unknown> = {},
): BuiltRequest {
  if (profile.formats?.length && !profile.formats.includes(req.format)) {
    throw ServiceError.invalid(`model ${profile.id} does not support ${req.format}`, 'response_format');
  }
  const semantic = semanticValues(profile, req);
  const body: Record<string, unknown> = {};
  if (profile.defaults) {
    for (const [path, raw] of Object.entries(profile.defaults)) {
      setPath(body, path, substitute(raw, semantic));
    }
  }

  for (const [field, path] of Object.entries(profile.fields ?? {})) {
    const value = semantic[field as ModelField];
    if (!presentValue(value)) continue;
    setPath(body, path!, value);
  }

  const variant = profile.variants?.find((item) => matchesVariant(item, semantic));
  const variantBody: Record<string, unknown> = {};
  const variantOptions: Record<string, unknown> = {};
  if (variant) {
    for (const [path, raw] of Object.entries(variant.set)) {
      const value = substitute(raw, semantic);
      if (path === 'options' && isPlainObject(value)) {
        deepMerge(variantOptions, value);
      } else if (path.startsWith('options.')) {
        setPath(variantOptions, path.slice('options.'.length), value);
      } else {
        setPath(variantBody, path, value);
      }
    }
  }
  deepMerge(body, variantBody);

  const declared = new Set((profile.options ?? []).map((decl) => decl.name));
  const optionDefaults: Record<string, unknown> = {};
  for (const decl of profile.options ?? []) {
    if (decl.default !== undefined) optionDefaults[decl.name] = decl.default;
  }
  // 条目 options 混着进程参数与协议设置(backend、headers、path 等),只取 profile 声明过的名字。
  const serviceOptions: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(entryOptions)) {
    if (declared.has(name)) serviceOptions[name] = value;
  }
  const baseOptions = isPlainObject(body.options) ? body.options : {};
  delete body.options;
  const options = deepMerge({}, baseOptions, optionDefaults, serviceOptions, variantOptions, req.options ?? {});
  validateOptions(profile, options);
  if (Object.keys(options).length > 0) body.options = options;

  return { profile, body, values: stringValues(semantic), format: req.format };
}

/** 唱歌请求复用同一套拼装:正文走 `text`,最后由 sing 的字段映射成 `lyrics`。 */
export function buildSing(
  profile: ModelProfile,
  req: SingRequest,
  entryOptions: Record<string, unknown> = {},
): BuiltRequest {
  return buildSpeech(profile, {
    model: req.model,
    input: req.lyrics,
    format: 'wav',
  }, entryOptions);
}
