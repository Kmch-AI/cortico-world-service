import { describe, expect, it } from 'vitest';
import {
  endpointUrl, healthPathOf, healthUrl, hostPort, llamacppLaunchMode,
  protocolOf, serverJsonPath, serviceIdFor, slugify, tasksOfEntry,
} from '../src/entry.ts';
import { normalizeEntry, validateServices } from '../src/validate.ts';
import type { ServiceEntry, ServiceType } from '../src/types.ts';

function entry(patch: Partial<ServiceEntry> = {}): ServiceEntry {
  return {
    id: 'openai',
    name: 'openai',
    type: 'openai',
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
    ['sing', 'sing'],
    ['openai', 'openai'],
    ['llamacpp', 'llamacpp'],
    ['startlux', 'systemone'],
    ['systemone', 'systemone'],
  ] as Array<[ServiceType, string]>)('protocolOf(%s) = %s', (type, protocol) => {
    expect(protocolOf(type)).toBe(protocol);
    expect(protocolOf({ type })).toBe(protocol);
  });

  it('0.8 及更早的 svc/custom 配置仍按原方言处理', () => {
    expect(protocolOf('svc' as ServiceType)).toBe('sing');
    expect(protocolOf('custom' as ServiceType)).toBe('custom');
  });
});

describe('model tasks', () => {
  it('按类型给默认任务，显式 tasks 优先', () => {
    expect(tasksOfEntry(entry({ type: 'llamacpp' }))).toEqual(['embeddings', 'rerank']);
    expect(tasksOfEntry(entry({ type: 'startlux' }))).toEqual(['systemone']);
    expect(tasksOfEntry(entry({ type: 'systemone' }))).toEqual(['systemone']);
    expect(tasksOfEntry(entry({ type: 'audiocpp' }))).toEqual(['tts']);
    expect(tasksOfEntry(entry({ type: 'llamacpp', tasks: ['chat'] }))).toEqual(['chat']);
    expect(tasksOfEntry(entry({ type: 'llamacpp', tasks: ['embeddings'] }))).toEqual(['embeddings']);
  });

  it('llama.cpp 启动方式：显式优先，旧 serve 配置按多模型处理', () => {
    expect(llamacppLaunchMode(entry({ type: 'llamacpp' }))).toBe('router');
    expect(llamacppLaunchMode(entry({ type: 'llamacpp', options: { launchMode: 'router' } })))
      .toBe('router');
    expect(llamacppLaunchMode(entry({ type: 'llamacpp', options: { launchMode: 'single' } })))
      .toBe('single');
    expect(llamacppLaunchMode(entry({ type: 'llamacpp', options: { launchMode: 'serve' } })))
      .toBe('router');
    expect(llamacppLaunchMode(entry({ type: 'llamacpp', args: 'serve --models-dir D:/models' })))
      .toBe('router');
    expect(llamacppLaunchMode(entry({ type: 'llamacpp', args: '--models-dir D:/models' })))
      .toBe('router');
    expect(llamacppLaunchMode(entry({ type: 'llamacpp', args: '-m D:/models/a.gguf' })))
      .toBe('single');
    expect(llamacppLaunchMode(entry({ type: 'audiocpp' }))).toBe('single');
  });
});

describe('endpointUrl', () => {
  it('无协议按 http,缺主机用 127.0.0.1', () => {
    expect(endpointUrl(entry({ endpoint: '' }))).toBe('http://127.0.0.1');
    expect(endpointUrl(entry({ endpoint: 'localhost' }))).toBe('http://localhost');
  });

  it('按类型补默认端口', () => {
    expect(endpointUrl(entry({ type: 'audiocpp', endpoint: '' }))).toBe('http://127.0.0.1:8080');
    expect(endpointUrl(entry({ type: 'audiocpp', endpoint: 'http://127.0.0.1' }))).toBe('http://127.0.0.1:8080');
    expect(endpointUrl(entry({ type: 'sing', endpoint: '127.0.0.1' }))).toBe('http://127.0.0.1:9882');
    expect(endpointUrl(entry({ type: 'startlux', endpoint: 'http://127.0.0.1' })))
      .toBe('http://127.0.0.1:8091');
    expect(endpointUrl(entry({ type: 'systemone', endpoint: 'http://127.0.0.1' })))
      .toBe('http://127.0.0.1:8091');
    expect(endpointUrl(entry({ type: 'llamacpp', endpoint: 'http://127.0.0.1' })))
      .toBe('http://127.0.0.1:8081');
    // 外部域名不套本地预设端口,仍按协议取 80/443。
    expect(endpointUrl(entry({ type: 'systemone', endpoint: 'https://api.example.com' })))
      .toBe('https://api.example.com');
    expect(endpointUrl(entry({ type: 'llamacpp', endpoint: 'http://api.example.com' })))
      .toBe('http://api.example.com');
    expect(endpointUrl(entry({ type: 'openai', endpoint: 'https://host' }))).toBe('https://host');
    expect(endpointUrl(entry({ type: 'openai', endpoint: 'http://host' }))).toBe('http://host');
  });

  it('保留路径并去掉末尾斜杠', () => {
    expect(endpointUrl(entry({ type: 'openai', endpoint: 'https://host/v1/' }))).toBe('https://host/v1');
  });
});

describe('hostPort', () => {
  it('给启动参数取主机与端口', () => {
    expect(hostPort(entry({ type: 'audiocpp', endpoint: 'http://127.0.0.1' })))
      .toEqual({ host: '127.0.0.1', port: 8080 });
    expect(hostPort(entry({ type: 'sing', endpoint: 'http://0.0.0.0:9999' })))
      .toEqual({ host: '0.0.0.0', port: 9999 });
    expect(hostPort(entry({ type: 'startlux', endpoint: 'http://127.0.0.1' })))
      .toEqual({ host: '127.0.0.1', port: 8091 });
    expect(hostPort(entry({ type: 'systemone', endpoint: 'http://127.0.0.1' })))
      .toEqual({ host: '127.0.0.1', port: 8091 });
    expect(hostPort(entry({ type: 'llamacpp', endpoint: 'http://127.0.0.1' })))
      .toEqual({ host: '127.0.0.1', port: 8081 });
    expect(hostPort(entry({ type: 'openai', endpoint: 'https://api.example.com/v1' })))
      .toEqual({ host: 'api.example.com', port: 443 });
    expect(hostPort(entry({ type: 'openai', endpoint: 'http://api.example.com' })))
      .toEqual({ host: 'api.example.com', port: 80 });
  });
});

describe('healthPathOf', () => {
  it('所有带 HTTP 协议的类型都探 /health', () => {
    expect(healthPathOf('audiocpp')).toBe('/health');
    expect(healthPathOf('openai')).toBe('/health');
    expect(healthPathOf('sing')).toBe('/health');
    expect(healthPathOf('startlux')).toBe('/health');
    expect(healthPathOf('systemone')).toBe('/health');
    expect(healthPathOf('llamacpp')).toBe('/health');
    expect(healthUrl(entry({ type: 'llamacpp', endpoint: 'http://127.0.0.1:8080' })))
      .toBe('http://127.0.0.1:8080/health');
    expect(healthUrl(entry({ type: 'startlux', endpoint: 'http://127.0.0.1:9010/v1' })))
      .toBe('http://127.0.0.1:9010/health');
    expect(healthUrl(entry({ type: 'systemone', endpoint: 'http://127.0.0.1:9010/v1' })))
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
    expect(serviceIdFor('My TTS', 'openai')).toBe('my-tts');
    expect(serviceIdFor('My TTS', 'openai', ['my-tts'])).toBe('my-tts-2');
    expect(serviceIdFor('My TTS', 'openai', ['my-tts', 'my-tts-2'])).toBe('my-tts-3');
  });

  it('中文或空名字取 type + 序号', () => {
    expect(serviceIdFor('本地语音', 'openai')).toBe('openai-1');
    expect(serviceIdFor('本地语音', 'openai', ['openai-1'])).toBe('openai-2');
    expect(serviceIdFor('', 'audiocpp')).toBe('audiocpp-1');
    expect(serviceIdFor('', 'startlux')).toBe('startlux-1');
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

  it('systemone 默认不托管；startlux 默认托管；tasks 校验并去重', () => {
    const external = normalizeEntry({ name: 'Ext', type: 'systemone', endpoint: 'https://jev.example.com' });
    expect(external.manage).toBe(false);
    const local = normalizeEntry({ name: 'Lux', type: 'startlux', endpoint: 'http://127.0.0.1:8091' });
    expect(local.manage).toBe(true);
    const tasks = normalizeEntry({
      name: 'x', type: 'llamacpp', endpoint: 'http://host',
      tasks: ['chat', 'chat', 'embeddings'],
    });
    expect(tasks.tasks).toEqual(['chat', 'embeddings']);
    expect(() => normalizeEntry({
      name: 'x', type: 'llamacpp', endpoint: 'http://host', tasks: ['systemone'],
    })).toThrow(/StartLux Decision/);
    expect(() => normalizeEntry({
      name: 'x', type: 'llamacpp', endpoint: 'http://host', tasks: ['asr'],
    })).toThrow(/unknown model task/);
  });

  it('单模型只接受一个模型', () => {
    const one = normalizeEntry({
      name: 'x', type: 'llamacpp', endpoint: 'http://host',
      models: ['a'], options: { launchMode: 'single' },
    });
    expect(one.models).toEqual(['a']);
    expect(() => normalizeEntry({
      name: 'x', type: 'llamacpp', endpoint: 'http://host',
      models: ['a', 'b'], options: { launchMode: 'single' },
    })).toThrow(/exactly one model/);
  });

  it('更新时保留 id,拒绝改 id', () => {
    const base = entry();
    const updated = normalizeEntry({ name: 'New name' }, base);
    expect(updated.id).toBe('openai');
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
      type: 'openai',
      serverDir: 'C:/svc',
      binary: 'run.exe',
      args: '--port 1',
      secretName: 'TOKEN',
      modelProfile: 'openai',
      models: ['a', 'b'],
      tasks: ['chat'],
      options: { backend: 'cpu' },
      unknownKey: 'ignored',
      anotherUnknown: 1,
    });
    expect(created).toEqual({
      id: 'x',
      name: 'x',
      type: 'openai',
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
      tasks: ['chat'],
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
