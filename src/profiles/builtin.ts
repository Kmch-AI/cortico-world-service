/**
 * 内置模型 profile。新增模型只加数据,不改代码;面板里的覆盖存
 * `entry.modelProfiles`,解析见 resolve.ts。
 */
import type { ModelProfile } from '../types.ts';

/** Ming 3.0 的三个控制模板;有 instructions 走 freeform,否则 emotion,再否则按 speedLevel 走 basic。 */
export const AUDIOCPP_MING3: ModelProfile = {
  id: 'audiocpp-ming3',
  label: 'audiocpp Ming 3.0',
  protocol: 'audiocpp',
  match: ['ming3', 'ming-3', 'ming_3', '*ming3*', '*ming-3*', '*ming_3*'],
  fields: {
    text: 'input',
    voice: 'voice',
    model: 'model',
    format: 'response_format',
  },
  variants: [
    {
      id: 'freeform',
      when: { has: ['instruct'] },
      set: {
        'options.template_name': 'freeform',
        'options.instruct': '{{instruct}}',
      },
    },
    {
      id: 'emotion',
      when: { has: ['emotion'], not: ['instruct'] },
      set: {
        'options.template_name': 'emotion',
        'options.emotion': '{{emotion}}',
      },
    },
    {
      id: 'basic',
      when: { has: ['speedLevel'] },
      set: {
        'options.template_name': 'basic',
        'options.speed': '{{speedLevel}}',
        'options.pitch': '中',
        'options.volume': '中',
      },
    },
  ],
  options: [
    { name: 'template_name', type: 'enum', values: ['freeform', 'emotion', 'basic'] },
    { name: 'instruct', type: 'string' },
    { name: 'emotion', type: 'string' },
    { name: 'speed', type: 'enum', values: ['慢速', '中速', '快速'] },
    { name: 'pitch', type: 'enum', values: ['低', '中', '高'] },
    { name: 'volume', type: 'enum', values: ['低', '中', '高'] },
  ],
  speedLevels: [
    { max: 0.85, value: '慢速' },
    { max: 1.15, value: '中速' },
    { max: 100, value: '快速' },
  ],
  tags: true,
};

export const OPENAI: ModelProfile = {
  id: 'openai',
  label: 'OpenAI compatible',
  protocol: 'openai',
  fields: {
    text: 'input',
    voice: 'voice',
    model: 'model',
    format: 'response_format',
    speed: 'speed',
    instruct: 'instructions',
  },
  formats: ['wav', 'mp3'],
};

export const CUSTOM: ModelProfile = {
  id: 'custom',
  label: 'custom JSON',
  protocol: 'custom',
  fields: {
    text: 'text',
    voice: 'voice',
    model: 'model',
    format: 'format',
    speed: 'speed',
    instruct: 'instruct',
    emotion: 'emotion',
    language: 'language',
  },
  formats: ['wav', 'mp3'],
};

export const SING: ModelProfile = {
  id: 'sing',
  label: 'singing service',
  protocol: 'sing',
  fields: {
    text: 'lyrics',
    model: 'model',
  },
  formats: ['wav'],
};

export const BUILTIN_PROFILES: readonly ModelProfile[] = [
  AUDIOCPP_MING3, OPENAI, CUSTOM, SING,
];

export const BUILTIN_BY_ID: Readonly<Record<string, ModelProfile>> = {
  'audiocpp-ming3': AUDIOCPP_MING3,
  openai: OPENAI,
  custom: CUSTOM,
  sing: SING,
};
