import { describe, expect, it } from 'vitest';
import { panelText } from '../webui/strings.ts';

describe('服务面板文案', () => {
  it('中英文键集一致', () => {
    expect(Object.keys(panelText('zh')).sort()).toEqual(Object.keys(panelText('en')).sort());
  });

  it('新建按钮与列表说明符合供应商页布局', () => {
    const zh = panelText('zh');
    expect(zh.add).toBe('+ 新建服务');
    expect(zh.listNote).toBe('一个卡片就是一组服务配置');
    expect(zh.draft).toBe('草稿');
    expect(zh.draftName).toBe('未命名服务');

    const en = panelText('en');
    expect(en.add).toBe('+ New service');
    expect(en.listNote).toBe('One card is one group of service settings.');
    expect(en.draft).toBe('Draft');
  });

  it('服务编辑器的分区标题中英文齐全', () => {
    const zh = panelText('zh');
    expect([zh.sectionIdentity, zh.sectionAddress, zh.sectionRuntime, zh.sectionModels, zh.advancedTitle])
      .toEqual(['基本信息', '服务地址', '运行时', '模型', '高级']);
    expect([zh.sectionBasic, zh.sectionToken, zh.sectionRequest])
      .toEqual(['基本', '令牌', '请求']);
    expect([zh.phaseStarting, zh.phaseOnline, zh.phaseError, zh.disabled])
      .toEqual(['启动中', '在线', '错误', '已停用']);

    const en = panelText('en');
    expect([en.sectionIdentity, en.sectionAddress, en.sectionRuntime, en.sectionModels, en.advancedTitle])
      .toEqual(['Basic information', 'Service address', 'Runtime', 'Models', 'Advanced']);
    expect([en.sectionBasic, en.sectionToken, en.sectionRequest])
      .toEqual(['Basic', 'Token', 'Request']);
    expect([en.phaseStarting, en.phaseOnline, en.phaseError, en.disabled])
      .toEqual(['Starting', 'Online', 'Error', 'Disabled']);
  });

  it('卡片药丸与测试连接有文案', () => {
    const zh = panelText('zh');
    expect([zh.cardType, zh.cardModel]).toEqual(['类型', '模型']);
    expect(zh.testConnection).toBe('测试连接');
    expect(zh.unsaved).toBe('有未保存的改动');
  });
});
