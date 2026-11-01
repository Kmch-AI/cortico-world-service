import { describe, expect, it } from 'vitest';
import {
  endpointUrl, healthPathOf, healthUrl, hostPort, protocolOf, serverJsonPath, serviceIdFor, slugify,
} from '../src/entry.ts';
import { normalizeEntry, validateServices } from '../src/validate.ts';
import type { ServiceEntry, ServiceType } from '../src/types.ts';

function entry(patch: Partial<ServiceEntry> = {}): ServiceEntry {
  return {
    id: 'svc',
    name: 'svc',
    type: 'custom',
    endpoint: 'http://127.0.0.1:9000',
    enabled: true,
    manage: false,
    autoStart: false,
    restartOnExit: false,
    ...patch,
  };
}

describe('type → protocol', () => {
  it.each([
    ['audiocpp', 'audiocpp'],
    ['openai', 'openai'],
    ['sing', 'sing'],
    ['svc', 'sing'],
    ['llamacpp', 'none'],
    ['systemone', 'openai'],
    ['custom', 'custom'],
  ] as Array<[ServiceType, string]>)('protocolOf(%s) = %s', (type, protocol) => {
    expect(protocolOf(type)).toBe(protocol);
    expect(protocolOf({ type })).toBe(protocol);
  });
});

describe('endpointUrl', () => {
  it('无协议按 http,缺主机用 127.0.0.1', () => {
    expect(endpointUrl(entry({ endpoint: '' }))).toBe('http://127.0.0.1');
    expect(endpointUrl(entry({ endpoint: 'localhost' }))).toBe('http://localhost');
  });

  it('按类型补默认端口', () => {
    expect(endpointUrl(entry({ type: 'audiocpp', endpoint: '' }))).toBe('http://127.0.0.1:8000');
    expect(endpointUrl(entry({ type: 'audiocpp', endpoint: 'http://127.0.0.1' }))).toBe('http://127.0.0.1:8000');
    expect(endpointUrl(entry({ type: 'sing', endpoint: '127.0.0.1' }))).toBe('http://127.0.0.1:9882');
    expect(endpointUrl(entry({ type: 'svc', endpoint: 'http://127.0.0.1' }))).toBe('http://127.0.0.1:9882');
    expect(endpointUrl(entry({ type: 'openai', endpoint: 'https://host' }))).toBe('https://host');
    expect(endpointUrl(entry({ type: 'openai', endpoint: 'http://host' }))).toBe('http://host');
  });

  it('保留路径并去掉末尾斜杠', () => {
    expect(endpointUrl(entry({ type: 'openai', endpoint: 'https://host/v1/' }))).toBe('https://host/v1');
    expect(endpointUrl(entry({ type: 'custom', endpoint: 'http://host:9010/api' }))).toBe('http://host:9010/api');
  });
});

describe('hostPort', () => {
  it('给启动参数取主机与端口', () => {
    expect(hostPort(entry({ type: 'audiocpp', endpoint: 'http://127.0.0.1' })))
      .toEqual({ host: '127.0.0.1', port: 8000 });
    expect(hostPort(entry({ type: 'sing', endpoint: 'http://0.0.0.0:9999' })))
      .toEqual({ host: '0.0.0.0', port: 9999 });
    expect(hostPort(entry({ type: 'openai', endpoint: 'https://api.example.com/v1' })))
      .toEqual({ host: 'api.example.com', port: 443 });
    expect(hostPort(entry({ type: 'openai', endpoint: 'http://api.example.com' })))
      .toEqual({ host: 'api.example.com', port: 80 });
  });
});

describe('healthPathOf', () => {
  it('只有 llamacpp / none 没有健康路径', () => {
    expect(healthPathOf('audiocpp')).toBe('/health');
    expect(healthPathOf('openai')).toBe('/health');
    expect(healthPathOf('sing')).toBe('/health');
    expect(healthPathOf('custom')).toBe('/health');
    expect(healthPathOf('llamacpp')).toBeNull();
    expect(healthUrl(entry({ type: 'llamacpp', endpoint: 'http://127.0.0.1:8080' }))).toBeNull();
    expect(healthUrl(entry({ type: 'custom', endpoint: 'http://127.0.0.1:9010/v1' })))
      .toBe('http://127.0.0.1:9010/health');
  });
});

describe('serverJsonPath', () => {
  it('固定在 serverDir 下;没有 serverDir 时为空', () => {
    expect(serverJsonPath({ serverDir: 'C:/svc' })).toBe('C:/svc/server.json');
    expect(serverJsonPath({ serverDir: 'C:/svc/' })).toBe('C:/svc/server.json');
    expect(serverJsonPath({ serverDir: '' })).toBeNull();
  });
});

describe('service id generation', () => {
  it('ASCII 名字取 slug,重名追加序号', () => {
    expect(slugify('My TTS Server')).toBe('my-tts-server');
    expect(serviceIdFor('My TTS', 'custom')).toBe('my-tts');
    expect(serviceIdFor('My TTS', 'custom', ['my-tts'])).toBe('my-tts-2');
    expect(serviceIdFor('My TTS', 'custom', ['my-tts', 'my-tts-2'])).toBe('my-tts-3');
  });

  it('中文或空名字取 type + 序号', () => {
    expect(serviceIdFor('本地语音', 'custom')).toBe('custom-1');
    expect(serviceIdFor('本地语音', 'custom', ['custom-1'])).toBe('custom-2');
    expect(serviceIdFor('', 'audiocpp')).toBe('audiocpp-1');
  });
});

describe('normalizeEntry', () => {
  it('创建时忽略用户给的 id', () => {
    const created = normalizeEntry({
      id: 'user-id', name: 'My TTS', type: 'openai', endpoint: 'https://host/v1',
    });
    expect(created.id).toBe('my-tts');
    expect(created.name).toBe('My TTS');
    expect(created.type).toBe('openai');
    expect(created.endpoint).toBe('https://host/v1');
    expect(created.enabled).toBe(true);
    expect(created.manage).toBe(true);
  });

  it('更新时保留 id,拒绝改 id', () => {
    const base = entry();
    const updated = normalizeEntry({ name: 'New name' }, base);
    expect(updated.id).toBe('svc');
    expect(updated.name).toBe('New name');
    expect(() => normalizeEntry({ id: 'other' }, base)).toThrow(/id cannot/);
  });

  it('name 与 endpoint 必填;type 必须已知', () => {
    expect(() => normalizeEntry({ endpoint: 'http://127.0.0.1:9000' })).toThrow(/name/);
    expect(() => normalizeEntry({ name: 'x' })).toThrow(/endpoint/);
    expect(() => normalizeEntry({ name: 'x', endpoint: 'ftp://host' })).toThrow(/http/);
    expect(() => normalizeEntry({ name: 'x', endpoint: 'http://host', type: 'nope' })).toThrow(/type must/);
    expect(() => normalizeEntry({ name: 'x'.repeat(121), endpoint: 'http://host' })).toThrow(/120/);
  });

  it('可选字段只保留白名单', () => {
    const created = normalizeEntry({
      name: 'x',
      endpoint: 'http://host',
      serverDir: 'C:/svc',
      binary: 'run.exe',
      args: '--port 1',
      secretName: 'TOKEN',
      modelProfile: 'openai',
      models: ['a', 'b'],
      options: { backend: 'cpu' },
      unknownKey: 'ignored',
      anotherUnknown: 1,
    });
    expect(created).toEqual({
      id: 'x',
      name: 'x',
      type: 'custom',
      enabled: true,
      endpoint: 'http://host',
      manage: true,
      autoStart: true,
      restartOnExit: true,
      serverDir: 'C:/svc',
      binary: 'run.exe',
      args: '--port 1',
      secretName: 'TOKEN',
      modelProfile: 'openai',
      models: ['a', 'b'],
      options: { backend: 'cpu' },
    });
  });
});

describe('validateServices', () => {
  it('重复 id 被拒绝', () => {
    expect(() => validateServices([
      entry({ id: 'same' }),
      entry({ id: 'same', name: 'other' }),
    ])).toThrow(/duplicate service id/);
    expect(() => validateServices([entry({ id: 'a' }), entry({ id: 'b', name: 'b' })])).not.toThrow();
  });
});
