import { describe, expect, it } from 'vitest';
import { panelText } from '../webui/strings.ts';

describe('服务面板文案', () => {
  it('中英文键集一致', () => {
    expect(Object.keys(panelText('zh')).sort()).toEqual(Object.keys(panelText('en')).sort());
  });

  it('顶部标签是「服务」与「网关」', () => {
    const zh = panelText('zh');
    expect(zh.tabServices).toBe('服务');
    expect(zh.tabGateway).toBe('网关');
    expect(zh.add).toBe('添加服务');

    const en = panelText('en');
    expect(en.tabServices).toBe('Services');
    expect(en.tabGateway).toBe('Gateway');
    expect(en.add).toBe('Add service');
  });

  it('分组标题中英文齐全', () => {
    const zh = panelText('zh');
    expect([zh.sectionBasic, zh.sectionRuntime, zh.sectionProcess, zh.advancedTitle])
      .toEqual(['基本', '运行', '进程', '高级']);
    expect([zh.sectionBasic, zh.sectionToken, zh.sectionRequest])
      .toEqual(['基本', '令牌', '请求']);

    const en = panelText('en');
    expect([en.sectionBasic, en.sectionRuntime, en.sectionProcess, en.advancedTitle])
      .toEqual(['Basic', 'Runtime', 'Process', 'Advanced']);
    expect([en.sectionBasic, en.sectionToken, en.sectionRequest])
      .toEqual(['Basic', 'Token', 'Request']);
  });
});
