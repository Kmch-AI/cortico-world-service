import { describe, expect, it } from 'vitest';
import { ServiceError } from '../src/errors.ts';
import {
  buildSing, buildSpeech, matchesModel, profilesOf, resolveProfile, resolveSingProfile,
  speedLevelOf,
} from '../src/profiles/resolve.ts';
import type { ServiceEntry, SpeechRequest } from '../src/types.ts';

function entry(patch: Partial<ServiceEntry> = {}): ServiceEntry {
  return {
    id: 'svc',
    name: 'svc',
    type: 'audiocpp',
    endpoint: 'http://127.0.0.1:8000',
    enabled: true,
    manage: false,
    autoStart: false,
    restartOnExit: false,
    ...patch,
  };
}

function speech(patch: Partial<SpeechRequest> = {}): SpeechRequest {
  return { input: 'hello', format: 'wav', ...patch };
}

describe('profile resolution', () => {
  it('modelProfile → 模型 id 前缀/通配 → openai', () => {
    expect(resolveProfile(entry(), 'ming3.0').id).toBe('audiocpp-ming3');
    expect(resolveProfile(entry(), 'Ming-3-turbo').id).toBe('audiocpp-ming3');
    expect(resolveProfile(entry(), 'tts-1').id).toBe('openai');
    expect(resolveProfile(entry({ modelProfile: 'openai' }), 'ming3').id).toBe('openai');
    expect(resolveProfile(entry({ modelProfile: 'auto' }), 'ming3').id).toBe('audiocpp-ming3');
    expect(resolveProfile(entry({ modelProfile: 'missing' }), 'nope').id).toBe('openai');
  });

  it('通配与前缀匹配', () => {
    expect(matchesModel('ming3', 'ming3.0')).toBe(true);
    expect(matchesModel('ming3', 'xming3')).toBe(false);
    expect(matchesModel('*ming3*', 'x-ming3-y')).toBe(true);
    expect(matchesModel('*', 'anything')).toBe(true);
    expect(matchesModel('tts-*', 'tts-1')).toBe(true);
  });

  it('内置 profile 固定可枚举;显式 modelProfile 可改选', () => {
    expect(profilesOf().map((profile) => profile.id)).toEqual([
      'audiocpp-ming3', 'audiocpp-indextts2', 'openai', 'custom', 'sing',
    ]);
    expect(resolveProfile(entry({ modelProfile: 'custom' }), 'ming3').id).toBe('custom');
    expect(resolveProfile(entry({ modelProfile: 'nonexistent' }), 'ming3').id).toBe('audiocpp-ming3');
  });
});

describe('audiocpp Ming 3.0 request mapping', () => {
  it('有 instructions → freeform', () => {
    const built = buildSpeech(resolveProfile(entry(), 'ming3'), speech({
      voice: 'v1', instructions: 'speak softly',
    }));
    expect(built.body).toEqual({
      input: 'hello',
      voice: 'v1',
      response_format: 'wav',
      options: { template_name: 'freeform', instruct: 'speak softly' },
    });
    expect(built.body.instructions).toBeUndefined();
  });

  it('有 emotion 且无 instructions → emotion', () => {
    const built = buildSpeech(resolveProfile(entry(), 'ming3'), speech({ emotion: 'happy' }));
    expect(built.body.options).toEqual({ template_name: 'emotion', emotion: 'happy' });
  });

  it('只有 speed → basic,按 speedLevels 映射', () => {
    const slow = buildSpeech(resolveProfile(entry(), 'ming3'), speech({ speed: 0.5 }));
    expect(slow.body.options).toEqual({
      template_name: 'basic', speed: '慢速', pitch: '中', volume: '中',
    });
    const normal = buildSpeech(resolveProfile(entry(), 'ming3'), speech({ speed: 1 }));
    expect(normal.body.options).toEqual({
      template_name: 'basic', speed: '中速', pitch: '中', volume: '中',
    });
    const fast = buildSpeech(resolveProfile(entry(), 'ming3'), speech({ speed: 1.5 }));
    expect(fast.body.options).toEqual({
      template_name: 'basic', speed: '快速', pitch: '中', volume: '中',
    });
    expect(slow.body.speed).toBeUndefined();
  });

  it('instructions 优先于 emotion 与 speed;emotion 优先于 speed', () => {
    const both = buildSpeech(resolveProfile(entry(), 'ming3'), speech({
      instructions: 'whisper', emotion: 'sad', speed: 1.5,
    }));
    expect(both.body.options).toMatchObject({ template_name: 'freeform', instruct: 'whisper' });
    const emotion = buildSpeech(resolveProfile(entry(), 'ming3'), speech({ emotion: 'sad', speed: 1.5 }));
    expect(emotion.body.options).toMatchObject({ template_name: 'emotion', emotion: 'sad' });
  });

  it('选项优先级:请求 options > variant > 条目 options > 声明默认值', () => {
    const built = buildSpeech(
      resolveProfile(entry(), 'ming3'),
      speech({ speed: 1.5, options: { pitch: '高' } }),
      { pitch: '低', volume: '低' },
    );
    expect(built.body.options).toEqual({
      template_name: 'basic',
      speed: '快速',
      pitch: '高',
      volume: '中',
    });
  });

  it('显式 template_name 覆盖 variant,但 variant 仍补 instruct', () => {
    const built = buildSpeech(resolveProfile(entry(), 'ming3'), speech({
      instructions: 'softly', options: { template_name: 'basic' },
    }));
    expect(built.body.options).toEqual({
      template_name: 'basic',
      instruct: 'softly',
    });
  });

  it('非法枚举与 profile 声明的格式限制都是 400', () => {
    expect(() => buildSpeech(resolveProfile(entry(), 'ming3'), speech({
      options: { pitch: '怪' },
    }))).toThrowError(ServiceError);
    expect(() => buildSpeech(resolveProfile(entry(), 'ming3'), speech({ format: 'mp3' })))
      .not.toThrow();
    expect(() => buildSpeech(resolveProfile(entry({ modelProfile: 'sing' }), 'ming3'), speech({ format: 'mp3' })))
      .toThrowError(/does not support mp3/);
  });

  it('speedLevelOf 没有档位时返回 undefined', () => {
    expect(speedLevelOf(undefined, 1)).toBeUndefined();
    expect(speedLevelOf([{ max: 1, value: 'a' }], 2)).toBe('a');
  });
});

describe('audiocpp IndexTTS2 request mapping', () => {
  const indexProfile = () => resolveProfile(entry(), 'index-tts2');
  const defaults = {
    emotion_alpha: 1,
    use_emotion_text: false,
    use_random_emotion: false,
    interval_silence_ms: 200,
    do_sample: true,
    top_p: 0.8,
    top_k: 30,
    temperature: 0.8,
    length_penalty: 0,
    num_beams: 3,
    repetition_penalty: 10,
    max_tokens: 1500,
    duration_scale: 1,
    text_chunk_mode: 'default',
  };

  it('按模型 id 选中 index-tts2 profile(含 2.5 与下划线写法)', () => {
    expect(indexProfile().id).toBe('audiocpp-indextts2');
    expect(resolveProfile(entry(), 'index_tts2').id).toBe('audiocpp-indextts2');
    expect(resolveProfile(entry(), 'index-tts2.5').id).toBe('audiocpp-indextts2');
    expect(resolveProfile(entry(), 'index_tts2_5').id).toBe('audiocpp-indextts2');
    expect(indexProfile().label).toBe('audiocpp IndexTTS2');
    expect(indexProfile().tags).toBe(false);
    expect(indexProfile().formats).toEqual(['wav']);
  });

  it('字段映射到 input/voice/response_format,默认参数来自 spec', () => {
    const built = buildSpeech(indexProfile(), speech({ voice: '4016' }));
    expect(built.body).toEqual({
      input: 'hello',
      voice: '4016',
      response_format: 'wav',
      options: defaults,
    });
  });

  it('instructions 与 emotion 都走 emotion_text,instructions 优先', () => {
    const instruct = buildSpeech(indexProfile(), speech({ instructions: 'speak softly' }));
    expect(instruct.body.options).toMatchObject({
      use_emotion_text: true, emotion_text: 'speak softly',
    });
    const emotion = buildSpeech(indexProfile(), speech({ emotion: 'happy' }));
    expect(emotion.body.options).toMatchObject({ use_emotion_text: true, emotion_text: 'happy' });
    const both = buildSpeech(indexProfile(), speech({ instructions: 'whisper', emotion: 'sad' }));
    expect(both.body.options).toMatchObject({ use_emotion_text: true, emotion_text: 'whisper' });
  });

  it('speed 不映射到 duration_scale', () => {
    const built = buildSpeech(indexProfile(), speech({ speed: 1.5 }));
    expect(built.body.speed).toBeUndefined();
    expect(built.body.options).toMatchObject({ duration_scale: 1 });
  });

  it('请求 options 通过校验并覆盖默认值', () => {
    const built = buildSpeech(indexProfile(), speech({
      options: {
        emotion_alpha: 0.5,
        emotion_vector: '0,0,0,0,0.5,0,0,0',
        use_random_emotion: true,
        interval_silence_ms: 0,
        do_sample: false,
        top_p: 0.9,
        top_k: 10,
        temperature: 0.7,
        length_penalty: 0.5,
        num_beams: 1,
        repetition_penalty: 2,
        max_tokens: 100,
        duration_scale: 1.1,
        seed: 42,
        text_chunk_size: 80,
        text_chunk_mode: 'tag_aware',
      },
    }));
    expect(built.body.options).toMatchObject({
      emotion_alpha: 0.5,
      use_random_emotion: true,
      do_sample: false,
      seed: 42,
      text_chunk_size: 80,
      text_chunk_mode: 'tag_aware',
    });
  });

  it('use_emotion_text 与 emotion_text 由语音语义管理,旧 options 不会覆盖', () => {
    const built = buildSpeech(indexProfile(), speech({
      instructions: 'speak softly',
      options: { use_emotion_text: false, emotion_text: 'old' },
    }));
    expect(built.body.options).toMatchObject({
      use_emotion_text: true,
      emotion_text: 'speak softly',
    });
  });

  it('非法类型、枚举与越界值是 400', () => {
    expect(() => buildSpeech(indexProfile(), speech({ options: { emotion_alpha: 2 } })))
      .toThrowError(/<= 1/);
    expect(() => buildSpeech(indexProfile(), speech({ options: { top_k: 0 } })))
      .toThrowError(/>= 1/);
    expect(() => buildSpeech(indexProfile(), speech({ options: { seed: 1.5 } })))
      .toThrowError(/integer/);
    expect(() => buildSpeech(indexProfile(), speech({ options: { do_sample: 'yes' } })))
      .toThrowError(/boolean/);
    expect(() => buildSpeech(indexProfile(), speech({ options: { text_chunk_mode: 'bogus' } })))
      .toThrowError(/one of/);
    expect(() => buildSpeech(indexProfile(), speech({ format: 'mp3' })))
      .toThrowError(/does not support mp3/);
  });
});

describe('openai and custom request mapping', () => {
  it('openai 映射到标准字段', () => {
    const built = buildSpeech(resolveProfile(entry({ type: 'openai' })), speech({
      model: 'tts-1',
      voice: 'alloy',
      speed: 1.2,
      instructions: 'calm',
      format: 'mp3',
    }));
    expect(built.body).toEqual({
      input: 'hello',
      model: 'tts-1',
      voice: 'alloy',
      speed: 1.2,
      instructions: 'calm',
      response_format: 'mp3',
    });
    expect(built.body.options).toBeUndefined();
  });

  it('custom profile 映射,未映射的字段不塞进去', () => {
    const built = buildSpeech(resolveProfile(entry({ type: 'openai', modelProfile: 'custom' })), speech({
      voice: 'v', emotion: 'calm', language: 'zh', format: 'wav',
    }));
    expect(built.body).toEqual({
      text: 'hello', voice: 'v', emotion: 'calm', language: 'zh', format: 'wav',
    });
  });

  it('sing 把正文映射成 lyrics', () => {
    const built = buildSing(resolveSingProfile(entry({ type: 'sing' })), {
      model: 'song-1', lyrics: 'la la',
    });
    expect(built.body).toEqual({ lyrics: 'la la', model: 'song-1' });
    expect(built.format).toBe('wav');
  });
});
