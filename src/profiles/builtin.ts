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
    // 这三个由语音的朗读风格写入;不在模型参数面板里重复暴露。
    { name: 'instruct', type: 'string', ui: false },
    { name: 'emotion', type: 'string', ui: false },
    { name: 'speed', type: 'enum', values: ['慢速', '中速', '快速'], ui: false },
    {
      name: 'template_name',
      type: 'enum',
      values: ['tts', 'multilingual', 'basic', 'emotion', 'dialect', 'ip', 'voice_design', 'freeform'],
      description: '留空时由朗读风格自动选择 freeform / emotion / basic;手动选择会覆盖自动结果。',
    },
    {
      name: 'language',
      type: 'string',
      description: 'multilingual 模板的目标语言名或代码;其他模板通常忽略。',
    },
    {
      name: 'instruction_schema',
      type: 'enum',
      values: ['en', 'zh'],
      description: '结构化指令字段的语言;默认 zh,方言模板默认 en。',
    },
    {
      name: 'pitch',
      type: 'enum',
      values: ['低', '中', '高'],
      description: 'basic 模板的音高;其他模板忽略。',
    },
    {
      name: 'volume',
      type: 'enum',
      values: ['低', '中', '高'],
      description: 'basic 模板的音量;其他模板忽略。',
    },
    {
      name: 'max_tokens',
      type: 'int',
      min: 1,
      description: '每个文本块最多生成的声学 patch 数;还受 512 位置上下文限制。',
    },
    {
      name: 'guidance_scale',
      type: 'float',
      min: 0,
      description: 'Flow 引导强度;越大越贴近条件,2 为服务默认值。',
    },
    {
      name: 'sigma',
      type: 'float',
      min: 0,
      description: 'Flow SDE 噪声尺度;0.25 为服务默认值。',
    },
    {
      name: 'temperature',
      type: 'float',
      min: 0,
      description: 'Flow 采样温度;0 仍使用带种子的初始噪声。',
    },
    {
      name: 'seed',
      type: 'int',
      min: 0,
      description: '参考后验与生成噪声的种子;固定它便于复现。',
    },
    {
      name: 'raw_text',
      type: 'bool',
      description: '把整段文本作为一个合成片段发送,不做前端切块。',
    },
    {
      name: 'text_chunk_size',
      type: 'int',
      min: 1,
      description: '长文本分块的 Unicode 码点数;留空由服务按文字种类决定。',
    },
    {
      name: 'text_chunk_mode',
      type: 'enum',
      values: ['default', 'tag_aware', 'japanese', 'endline'],
      description: '框架的长文本分块策略;默认 tag_aware。',
    },
    {
      name: 'trim_silence',
      type: 'bool',
      description: '裁掉每个片段末尾的低能量静音,保留约 300 ms 尾巴。',
    },
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
      description: '由语音的情绪/表演指令自动置为 true;不在模型参数面板里单独暴露。',
      default: false,
      ui: false,
    },
    {
      name: 'emotion_text',
      type: 'string',
      description: '由语音的默认情绪、默认表演指令或单句 emotion/instruct 写入;不在模型参数面板里单独暴露。',
      ui: false,
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
