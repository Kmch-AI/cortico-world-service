/** 内置模型 profile。新增模型只加数据,不改代码;解析见 resolve.ts。 */
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
    { name: 'template_name', type: 'enum', values: ['freeform', 'emotion', 'basic'], ui: false },
    { name: 'instruct', type: 'string', ui: false },
    { name: 'emotion', type: 'string', ui: false },
    { name: 'speed', type: 'enum', values: ['慢速', '中速', '快速'], ui: false },
    { name: 'pitch', type: 'enum', values: ['低', '中', '高'], ui: false },
    { name: 'volume', type: 'enum', values: ['低', '中', '高'], ui: false },
  ],
  speedLevels: [
    { max: 0.85, value: '慢速' },
    { max: 1.15, value: '中速' },
    { max: 100, value: '快速' },
  ],
  tags: true,
};

/**
 * IndexTTS2 与 IndexTTS2.5。情绪走文本条件:`instructions` 或 `emotion` 映射到
 * `emotion_text`;`speed` 不映射到 `duration_scale`(那个字段是时长缩放,不是语速)。
 */
export const AUDIOCPP_INDEXTTS2: ModelProfile = {
  id: 'audiocpp-indextts2',
  label: 'audiocpp IndexTTS2',
  protocol: 'audiocpp',
  match: ['index-tts2', 'index_tts2', 'index-tts2.5', 'index_tts2_5', '*index-tts2*', '*index_tts2*'],
  fields: {
    text: 'input',
    voice: 'voice',
    model: 'model',
    format: 'response_format',
  },
  variants: [
    {
      id: 'instruct-emotion-text',
      when: { has: ['instruct'] },
      set: {
        'options.use_emotion_text': true,
        'options.emotion_text': '{{instruct}}',
      },
    },
    {
      id: 'emotion-text',
      when: { has: ['emotion'], not: ['instruct'] },
      set: {
        'options.use_emotion_text': true,
        'options.emotion_text': '{{emotion}}',
      },
    },
  ],
  options: [
    {
      name: 'emotion_alpha',
      type: 'float',
      description: 'Emotion conditioning blend strength.',
      default: 1,
      min: 0,
      max: 1,
    },
    {
      name: 'emotion_vector',
      type: 'string',
      description: 'Eight comma-separated finite emotion strengths.',
    },
    {
      name: 'use_emotion_text',
      type: 'bool',
      description: 'Use text-derived emotion conditioning.',
      default: false,
    },
    {
      name: 'emotion_text',
      type: 'string',
      description: 'Emotion description.',
    },
    {
      name: 'use_random_emotion',
      type: 'bool',
      description: 'Use random emotion conditioning.',
      default: false,
    },
    {
      name: 'interval_silence_ms',
      type: 'int',
      description: 'Silence between generated segments in milliseconds.',
      default: 200,
      min: 0,
    },
    {
      name: 'do_sample',
      type: 'bool',
      description: 'Enable sampling.',
      default: true,
    },
    {
      name: 'top_p',
      type: 'float',
      description: 'Nucleus sampling probability. Must be in (0, 1].',
      default: 0.8,
    },
    {
      name: 'top_k',
      type: 'int',
      description: 'Top-k sampling limit.',
      default: 30,
      min: 1,
    },
    {
      name: 'temperature',
      type: 'float',
      description: 'Sampling temperature. Must be positive.',
      default: 0.8,
    },
    {
      name: 'length_penalty',
      type: 'float',
      description: 'Beam search length penalty.',
      default: 0,
    },
    {
      name: 'num_beams',
      type: 'int',
      description: 'Beam search width.',
      default: 3,
      min: 1,
    },
    {
      name: 'repetition_penalty',
      type: 'float',
      description: 'Sampling repetition penalty.',
      default: 10,
    },
    {
      name: 'max_tokens',
      type: 'int',
      description: 'Maximum generated mel tokens.',
      default: 1500,
      min: 1,
    },
    {
      name: 'duration_scale',
      type: 'float',
      description: 'Positive waveform duration rescaling, supported by both IndexTTS2 and IndexTTS2.5.',
      default: 1,
    },
    {
      name: 'seed',
      type: 'int',
      description: 'Sampling seed; omitted chooses a random seed.',
      min: 0,
      max: 4294967295,
    },
    {
      name: 'text_chunk_size',
      type: 'int',
      description: 'Optional framework long-form text chunk size; omitted keeps the full input together. Must be positive.',
    },
    {
      name: 'text_chunk_mode',
      type: 'enum',
      description: 'Framework text chunking mode.',
      values: ['default', 'tag_aware', 'japanese', 'endline'],
      default: 'default',
    },
  ],
  tags: false,
  formats: ['wav'],
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
  AUDIOCPP_MING3, AUDIOCPP_INDEXTTS2, OPENAI, CUSTOM, SING,
];

export const BUILTIN_BY_ID: Readonly<Record<string, ModelProfile>> = {
  'audiocpp-ming3': AUDIOCPP_MING3,
  'audiocpp-indextts2': AUDIOCPP_INDEXTTS2,
  openai: OPENAI,
  custom: CUSTOM,
  sing: SING,
};
