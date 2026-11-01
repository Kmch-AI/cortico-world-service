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
    kind: 'custom',
    protocol: 'audiocpp',
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

  it('entry.modelProfiles 只覆盖给出的字段,也能新增 profile', () => {
    const overridden = entry({
      modelProfiles: {
        'audiocpp-ming3': { label: 'Ming custom', fields: { text: 'text' } },
        'my-profile': { protocol: 'openai', fields: { text: 'say' } },
      },
    });
    const ming = profilesOf(overridden).find((profile) => profile.id === 'audiocpp-ming3')!;
    expect(ming.label).toBe('Ming custom');
    expect(ming.fields?.text).toBe('text');
    expect(ming.fields?.voice).toBe('voice');
    const custom = resolveProfile(overridden, 'ming3');
    expect(custom.id).toBe('audiocpp-ming3');
    expect(resolveProfile(entry({ modelProfile: 'my-profile', modelProfiles: overridden.modelProfiles }), 'x').id)
      .toBe('my-profile');
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
    const limited = entry({
      modelProfile: 'audiocpp-ming3',
      modelProfiles: { 'audiocpp-ming3': { formats: ['wav'] } },
    });
    expect(() => buildSpeech(resolveProfile(limited, 'ming3'), speech({ format: 'mp3' })))
      .toThrowError(/does not support mp3/);
    expect(() => buildSpeech(resolveProfile(entry(), 'ming3'), speech({ format: 'mp3' })))
      .not.toThrow();
  });

  it('speedLevelOf 没有档位时返回 undefined', () => {
    expect(speedLevelOf(undefined, 1)).toBeUndefined();
    expect(speedLevelOf([{ max: 1, value: 'a' }], 2)).toBe('a');
  });
});

describe('openai and custom request mapping', () => {
  it('openai 映射到标准字段', () => {
    const built = buildSpeech(resolveProfile(entry({ protocol: 'openai' })), speech({
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

  it('custom 按 fields 映射,未映射的字段不塞进去', () => {
    const built = buildSpeech(resolveProfile(entry({
      protocol: 'custom', modelProfile: 'custom',
    })), speech({
      voice: 'v', emotion: 'calm', language: 'zh', format: 'wav',
    }));
    expect(built.body).toEqual({
      text: 'hello', voice: 'v', emotion: 'calm', language: 'zh', format: 'wav',
    });
  });

  it('sing 把正文映射成 lyrics', () => {
    const built = buildSing(resolveSingProfile(entry({ protocol: 'sing' })), {
      model: 'song-1', lyrics: 'la la',
    });
    expect(built.body).toEqual({ lyrics: 'la la', model: 'song-1' });
    expect(built.format).toBe('wav');
  });
});
