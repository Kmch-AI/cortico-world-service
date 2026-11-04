/**
 * jsdom mount smoke for dist/webui.js。
 *
 * 验证结构:两个页面面板、服务卡片、草稿、轮询保留输入、类型切换与编号折叠区;
 * 另核对左栏吸顶所需的样式合同。jsdom 不排版,真实布局仍要在浏览器里看。
 * 运行前先 `pnpm build:webui`。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = fileURLToPath(new URL('../', import.meta.url));
readFileSync(`${root}dist/webui.js`);

const dom = new JSDOM('<!doctype html><html><body><div id="services"></div><div id="gateway"></div></body></html>', {
  url: 'http://127.0.0.1/',
});
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.Event = window.Event;
globalThis.MouseEvent = window.MouseEvent;
globalThis.Node = window.Node;
globalThis.AbortSignal = window.AbortSignal;
globalThis.AbortController = window.AbortController;

const bundle = (await import(new URL('../dist/webui.js', import.meta.url))).default;
assert.deepEqual(Object.keys(bundle.panels), ['services', 'gateway'], 'bundle exports exactly two panels');
assert.equal(bundle.config, undefined, 'bundle has no config page');

// 左栏吸顶:服务列表与右侧配置共用一个 .panelslot 滚动端口,左栏必须 sticky,
// 单列布局再恢复 static。只查构建产物里的声明,不代替真实浏览器排版。
const css = readFileSync(`${root}dist/webui.css`, 'utf8');
const sideRule = css.match(/\.svc-side\{[^}]*\}/)?.[0] ?? '';
assert.match(sideRule, /position:sticky/, 'service side is sticky');
assert.match(sideRule, /top:24px/, 'service side keeps the panel top gap');
assert.match(sideRule, /align-self:start/, 'service side stays content-height for sticky');
const narrow = css.indexOf('@container webui-content (max-width: 760px)');
const staticSide = css.indexOf('.svc-side{position:static}');
assert.ok(narrow >= 0 && staticSide > narrow && staticSide - narrow < 300,
  'single-column layout restores static side');

const document = window.document;

// ---------------------------------------------------------------------------
// ctx.ui 的测试替身:真实 DOM 节点,框架的类名照抄,行为尽量简单。
// ---------------------------------------------------------------------------

let segmentedCalls = 0;
let drawerCalls = 0;
let confirmCalls = 0;

function h(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== null && text !== undefined) node.textContent = String(text);
  return node;
}

function input(opts = {}) {
  const node = document.createElement('input');
  node.className = 'field';
  if (opts.type) node.type = opts.type;
  if (opts.value !== undefined) node.value = opts.value;
  if (opts.placeholder !== undefined) node.placeholder = opts.placeholder;
  if (opts.disabled) node.disabled = true;
  if (opts.cls) node.classList.add(...opts.cls.split(/\s+/).filter(Boolean));
  return node;
}

function select(opts = {}) {
  const node = document.createElement('select');
  node.className = 'field';
  for (const item of opts.options ?? []) {
    const option = document.createElement('option');
    const value = typeof item === 'string' ? item : item.value;
    option.value = value;
    option.textContent = typeof item === 'string' ? item : item.label ?? value;
    node.append(option);
  }
  if (opts.value !== undefined) node.value = opts.value;
  return node;
}

function checkbox(label, opts = {}) {
  const wrap = document.createElement('label');
  wrap.className = 'check';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = Boolean(opts.checked);
  if (opts.disabled) box.disabled = true;
  wrap.append(box, document.createTextNode(label));
  return {
    el: wrap,
    input: box,
    get checked() { return box.checked; },
    setChecked(value) { box.checked = value; },
  };
}

function field(label, control) {
  const wrap = document.createElement('label');
  wrap.className = 'fieldrow';
  const caption = document.createElement('span');
  caption.className = 'fieldlabel';
  caption.textContent = label;
  wrap.append(caption, control);
  return wrap;
}

function button(label, opts = {}) {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = `btn${opts.variant ? ` ${opts.variant}` : ''}${opts.size ? ` ${opts.size}` : ''}`;
  node.textContent = label;
  if (opts.onClick) node.addEventListener('click', opts.onClick);
  return node;
}

function pill(text, tone = 'plain') {
  return h('span', `pill ${tone}`, text);
}

function msgline(text = '', bad = false) {
  return h('div', `msgline${bad ? ' bad' : ''}`, text);
}

function sheet(opts) {
  const el = document.createElement('div');
  el.className = 'sheet';
  const head = h('div', 'sheethead');
  head.append(h('h3', null, opts.title));
  const body = h('div', 'sheetbody');
  el.append(head, body);
  return { el, body, note: h('div'), desc: null };
}

function foldSheet(id, opts = {}) {
  const el = document.createElement('details');
  el.className = 'sheet fold tabbed';
  el.dataset.sheet = id;
  el.open = opts.defaultOpen !== false;
  const summary = document.createElement('summary');
  summary.append(h('h3', null, opts.title));
  const note = h('div', 'foldnote');
  summary.append(note);
  const body = h('div', 'foldbody');
  el.append(summary, body);
  return { el, body, note, desc: null };
}

function kv(rows) {
  const table = document.createElement('table');
  table.className = 'kvtable';
  const body = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    const key = document.createElement('td');
    key.textContent = row.k;
    const value = document.createElement('td');
    if (row.v instanceof window.Node) value.append(row.v);
    else value.textContent = row.v === null || row.v === undefined ? '' : String(row.v);
    tr.append(key, value);
    body.append(tr);
  }
  table.append(body);
  return table;
}

const ui = {
  h,
  esc: value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]),
  sheet,
  foldSheet,
  rowbar: () => h('div', 'rowbar'),
  section: (title, desc) => { const node = h('div', 'sectionhead'); node.append(h('h3', null, title)); if (desc) node.append(h('p', 'sectiondesc', desc)); return node; },
  actions: () => h('div', 'actions'),
  button,
  copyButton: text => button('copy'),
  pill,
  chip: (text, tone = 'plain') => h('span', `chip ${tone}`, text),
  msgline,
  placeholder: text => h('div', 'placeholder', text),
  input,
  select,
  textarea: opts => { const node = document.createElement('textarea'); node.className = 'field'; if (opts?.value !== undefined) node.value = opts.value; if (opts?.rows) node.rows = opts.rows; if (opts?.cls) node.classList.add(...opts.cls.split(/\s+/)); return node; },
  checkbox,
  field,
  segmented() { segmentedCalls += 1; throw new Error('the service page must not use an internal segmented switcher'); },
  table: () => { throw new Error('unused'); },
  kv,
  stat: () => { throw new Error('unused'); },
  statgrid: () => { throw new Error('unused'); },
  progress: () => { throw new Error('unused'); },
  toast: () => ({ dispose() {} }),
  confirm: async () => { confirmCalls += 1; return true; },
  drawer() { drawerCalls += 1; return { dispose() {} }; },
  lightbox: () => ({ dispose() {} }),
  busy: () => ({ dispose() {} }),
  disable: () => ({ dispose() {} }),
  fmt: { duration: ms => `${ms}ms` },
};

// ---------------------------------------------------------------------------
// 假数据面。
// ---------------------------------------------------------------------------

function service(entry, phase, patch = {}) {
  return {
    entry: {
      id: entry.name.toLowerCase(),
      enabled: true,
      manage: true,
      autoStart: false,
      restartOnExit: false,
      tokenSet: false,
      ...entry,
    },
    phase,
    detail: phase === 'online' ? 'listening' : '',
    external: false,
    managed: true,
    pid: phase === 'online' ? 4242 : null,
    models: entry.models?.length ?? 0,
    backend: '',
    baseUrl: entry.endpoint,
    restarts: 0,
    ...patch,
  };
}

const state = {
  gateway: {
    enabled: true,
    status: 'ok',
    phase: 'ok',
    ready: true,
    detail: '1/2 online',
    host: '127.0.0.1',
    port: 9883,
    baseUrl: 'http://127.0.0.1:9883',
    version: '0.4.0',
    uptimeSec: 12,
    tokenRequired: false,
    tokenSet: true,
    secretName: 'SERVICE_TOKEN',
    allowQueryToken: false,
    requestTimeoutSec: 180,
    defaultSpeechModel: '',
    restartRequired: false,
    models: 2,
    online: 1,
    total: 2,
  },
  services: [
    service({ id: 'alpha', name: 'Alpha', type: 'audiocpp', endpoint: 'http://127.0.0.1:8080', models: ['voice-a'] }, 'online'),
    service({ id: 'beta', name: 'Beta', type: 'custom', endpoint: 'http://127.0.0.1:9101' }, 'off', { managed: false }),
  ],
};

let addCount = 0;
const calls = [];

async function invoke(method, args = []) {
  calls.push({ method, args });
  switch (method) {
    case 'state':
      return structuredClone(state);
    case 'add': {
      const payload = args[0];
      addCount += 1;
      const entry = { ...payload, id: `added-${addCount}`, tokenSet: false };
      state.services.push(service(entry, 'off'));
      return structuredClone(entry);
    }
    case 'update': {
      const [id, patch] = args;
      const target = state.services.find(item => item.entry.id === id);
      assert.ok(target, `update target ${id}`);
      Object.assign(target.entry, patch);
      target.baseUrl = target.entry.endpoint;
      return structuredClone(state);
    }
    case 'remove':
      state.services = state.services.filter(item => item.entry.id !== args[0]);
      return structuredClone(state);
    case 'reorder': {
      const ids = args[0];
      state.services.sort((a, b) => ids.indexOf(a.entry.id) - ids.indexOf(b.entry.id));
      return structuredClone(state);
    }
    case 'start':
      state.services.find(item => item.entry.id === args[0]).phase = 'online';
      return structuredClone(state);
    case 'stop':
      state.services.find(item => item.entry.id === args[0]).phase = 'off';
      return structuredClone(state);
    case 'restart':
      state.services.find(item => item.entry.id === args[0]).restarts += 1;
      return structuredClone(state);
    case 'probe':
      state.services.find(item => item.entry.id === args[0]).phase = 'online';
      return structuredClone(state);
    case 'logs':
      return { id: args[0], lines: 0, text: '' };
    case 'saveGateway':
      Object.assign(state.gateway, args[0]);
      return structuredClone(state);
    default:
      throw new Error(`unexpected invoke: ${method}`);
  }
}

function makeCtx(panelId, element) {
  const intervals = [];
  const controller = new AbortController();
  return {
    intervals,
    ctx: {
      pageId: 'world:service',
      panelId,
      language: 'zh',
      root: element,
      signal: controller.signal,
      invoke,
      invokeBinary: async () => { throw new Error('unused'); },
      pickPath: async () => null,
      setConfig: async () => { throw new Error('unused'); },
      stream: () => { throw new Error('unused'); },
      interval(fn, ms) { intervals.push({ fn, ms }); return { dispose() {} }; },
      timeout: () => ({ dispose() {} }),
      frame: () => ({ dispose() {} }),
      own: value => value,
      memo: { map: new Map(), get(key, fallback) { return this.map.has(key) ? this.map.get(key) : fallback; }, set(key, value) { this.map.set(key, value); } },
      guardLeave: () => ({ dispose() {} }),
      scope: {},
      mountSlot: async () => ({ dispose() {} }),
      ui,
      refresh: async () => {},
    },
  };
}

const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise(resolve => setTimeout(resolve, 0)); };
const text = node => (node?.textContent ?? '').trim();
const all = (selector, scope = document) => [...scope.querySelectorAll(selector)];
const one = (selector, scope = document) => {
  const node = scope.querySelector(selector);
  assert.ok(node, `missing ${selector}`);
  return node;
};
const fieldControl = (scope, label) => {
  const boxes = all('.connection-field', scope);
  const nameOf = item => text(item.querySelector('.fieldlabel'));
  const box = boxes.find(item => nameOf(item) === label) ?? boxes.find(item => nameOf(item).startsWith(label));
  assert.ok(box, `missing field ${label}`);
  const control = box.querySelector('input, select, textarea');
  assert.ok(control, `missing control for ${label}`);
  return control;
};
const checkControl = (scope, label) => {
  const box = all('.svc-check', scope).find(item => text(item.querySelector('.check')).startsWith(label));
  assert.ok(box, `missing checkbox ${label}`);
  const control = box.querySelector('input[type="checkbox"]');
  assert.ok(control, `missing checkbox control for ${label}`);
  return control;
};
const sectionTitles = scope => all('details.connection-section', scope).map(item => text(item.querySelector('h3')));
const card = (identity, scope = document) => one(`.connection-card[data-service="${identity}"]`, scope);
const cardActions = node => all('.svc-card-actions button', node).map(text);
const fire = (node, type) => node.dispatchEvent(new window.Event(type, { bubbles: true }));

// ---------------------------------------------------------------------------
// 服务面板:布局、卡片、选中、编号折叠区。
// ---------------------------------------------------------------------------

const services = makeCtx('services', document.getElementById('services'));
bundle.panels.services.mount(services.ctx);
await settle();

const servicesRoot = services.ctx.root;
assert.equal(all('.svc-workbench', servicesRoot).length, 1, 'master-detail layout');
assert.equal(text(one('.connection-create > .btn', servicesRoot)), '+ 新建服务', 'full-width add button');
assert.ok(text(one('.connection-create-hint', servicesRoot)).length > 0, 'list note');
if (all('.connection-card', servicesRoot).length !== 2) {
  console.error('DEBUG', servicesRoot.innerHTML);
  console.error('CALLS', calls.map(item => item.method));
}
assert.equal(all('.connection-card', servicesRoot).length, 2, 'one card per service');
assert.equal(segmentedCalls, 0, 'no internal segmented switcher');

const alpha = card('alpha', servicesRoot);
assert.ok(alpha.classList.contains('is-active'), 'selected card highlighted');
assert.equal(text(one('.connection-name', alpha)), 'Alpha');
assert.equal(text(one('.kv-type .kv-v', alpha)), 'audiocpp');
assert.equal(text(one('.kv-model .kv-v', alpha)), 'voice-a');
assert.match(text(one('.connection-status', alpha)), /在线/);
assert.equal(text(one('.kv-type .kv-v', card('beta', servicesRoot))), 'custom');
assert.match(text(one('.connection-status', card('beta', servicesRoot))), /已停止/);
assert.deepEqual(cardActions(alpha), ['停止', '重启'], 'online card offers stop/restart');
assert.deepEqual(cardActions(card('beta', servicesRoot)), ['启动', '重启'], 'offline card offers start/restart');
assert.ok(one('.connection-erase', alpha), 'delete on every card');

const editor = one('.svc-editor', servicesRoot);
assert.equal(text(one('.connection-identity h3', editor)), '基本信息');
assert.deepEqual(sectionTitles(editor), ['服务地址', '运行时', '模型', '高级'], 'numbered editor sections');
assert.equal(all('.connection-step', editor).length, 4, 'four numbered steps');
const folds = all('details.connection-section', editor);
assert.deepEqual(folds.map(item => item.open), [true, true, true, false], 'sections collapsible, advanced closed');
const labels = all('.connection-field .fieldlabel', editor).map(text);
assert.ok(!labels.some(label => /协议|健康|health|protocol|(^|\s)id(\s|$)/i.test(label)), 'no protocol/healthPath/id inputs');
assert.ok(all('.svc-status tr', editor).length >= 7, 'status block rows');

// ---------------------------------------------------------------------------
// 轮询不重建表单;已有条目保存走 update。
// ---------------------------------------------------------------------------

const alphaName = fieldControl(editor, '名称');
alphaName.value = 'Alpha typing';
fire(alphaName, 'input');
assert.equal(text(one('.connection-name', card('alpha', servicesRoot))), 'Alpha', 'card stays on saved name until save');

services.intervals[0].fn();
await settle();
assert.equal(alphaName.value, 'Alpha typing', 'polling keeps typed value');
assert.equal(text(one('.connection-name', card('alpha', servicesRoot))), 'Alpha', 'polling paints saved card');

one('.svc-editor .actions .btn.primary', servicesRoot).click();
await settle();
const updateCall = calls.findLast(item => item.method === 'update');
assert.ok(updateCall, 'existing save calls update');
assert.equal(updateCall.args[0], 'alpha');
assert.equal(updateCall.args[1].name, 'Alpha typing');
assert.equal(text(one('.connection-name', card('alpha', servicesRoot))), 'Alpha typing', 'saved card updates');

// ---------------------------------------------------------------------------
// 新建:立即出现草稿卡片;类型规则;保存才 add。
// ---------------------------------------------------------------------------

one('.connection-create > .btn', servicesRoot).click();
await settle();
assert.equal(drawerCalls, 0, 'draft opens without a drawer');
assert.equal(all('.connection-card', servicesRoot).length, 3, 'draft card appears immediately');
const draftCard = card('__draft__', servicesRoot);
assert.ok(draftCard, 'draft card identity');
assert.equal(text(one('.connection-name', draftCard)), '未命名服务');
assert.equal(text(one('.kv-type .kv-v', draftCard)), 'audiocpp');
assert.equal(text(one('.kv-model .kv-v', draftCard)), '—');
const draftEditor = one('.svc-editor', servicesRoot);
assert.deepEqual(sectionTitles(draftEditor), ['服务地址', '运行时', '模型', '高级']);
const draftName = fieldControl(draftEditor, '名称');
const draftType = fieldControl(draftEditor, '类型');
const draftEndpoint = fieldControl(draftEditor, '地址');
assert.equal(draftName.value, '未命名服务');
assert.equal(draftType.value, 'audiocpp');
assert.equal(draftEndpoint.value, 'http://127.0.0.1:8080', 'audiocpp default endpoint 8080');
assert.equal(checkControl(draftEditor, '托管进程').checked, true);

draftType.value = 'sing';
fire(draftType, 'change');
assert.equal(draftEndpoint.value, 'http://127.0.0.1:9882', 'type change replaces the old default endpoint');
assert.equal(text(one('.kv-type .kv-v', draftCard)), 'sing', 'card type pill follows the form');

draftEndpoint.value = 'http://10.0.0.5:7000';
fire(draftEndpoint, 'input');
draftType.value = 'svc';
fire(draftType, 'change');
assert.equal(draftEndpoint.value, 'http://10.0.0.5:7000', 'custom endpoint survives type change');

draftEndpoint.value = '';
fire(draftEndpoint, 'input');
draftType.value = 'audiocpp';
fire(draftType, 'change');
assert.equal(draftEndpoint.value, 'http://127.0.0.1:8080', 'empty endpoint takes the new default');

draftType.value = 'openai';
fire(draftType, 'change');
const manage = checkControl(draftEditor, '托管进程');
assert.equal(manage.checked, false, 'openai turns process hosting off');
assert.deepEqual(all('.svc-process', draftEditor).map(item => item.hidden), [true, true, true, true], 'unmanaged hides process fields');

manage.checked = true;
fire(manage, 'change');
assert.deepEqual(all('.svc-process', draftEditor).map(item => item.hidden), [false, true, true, true], 'openai shows process fields only');

draftType.value = 'llamacpp';
fire(draftType, 'change');
assert.deepEqual(all('.svc-process', draftEditor).map(item => item.hidden), [false, true, false, true], 'llamacpp shows tuning, hides audiocpp extras');
const profileField = all('.connection-field', draftEditor).find(item => text(item.querySelector('.fieldlabel')).startsWith('模型 profile'));
assert.ok(profileField?.hidden, 'llamacpp hides the model profile');

draftType.value = 'audiocpp';
fire(draftType, 'change');
const audiocppExtras = all('.svc-process', draftEditor).find(item => text(item).includes('空闲卸载'));
assert.ok(audiocppExtras, 'audiocpp extras group');
assert.equal(audiocppExtras.hidden, false, 'audiocpp shows idle unload');

draftName.value = 'Gamma service';
fire(draftName, 'input');
one('.svc-editor .actions .btn.primary', servicesRoot).click();
await settle();
const addCall = calls.findLast(item => item.method === 'add');
assert.ok(addCall, 'draft save calls add');
assert.equal(addCall.args[0].name, 'Gamma service');
assert.equal(addCall.args[0].type, 'audiocpp');
assert.equal(addCall.args[0].endpoint, 'http://127.0.0.1:8080');
assert.equal(addCall.args[0].enabled, false);
assert.equal(addCall.args[0].manage, true);
assert.equal(addCall.args[0].autoStart, false);
assert.equal(addCall.args[0].restartOnExit, false);
assert.equal(all('.connection-card', servicesRoot).length, 3, 'saved draft becomes a real card');
assert.equal(servicesRoot.querySelector('.connection-card[data-service="__draft__"]'), null, 'draft card gone after save');
assert.ok(card('added-1', servicesRoot).classList.contains('is-active'), 'new service selected');
assert.equal(text(one('.connection-name', card('added-1', servicesRoot))), 'Gamma service');

// 草稿的卡片随输入即时更新;放弃草稿不问确认。
one('.connection-create > .btn', servicesRoot).click();
await settle();
const liveDraft = card('__draft__', servicesRoot);
const liveEditor = one('.svc-editor', servicesRoot);
const liveName = fieldControl(liveEditor, '名称');
liveName.value = 'Live draft';
fire(liveName, 'input');
assert.equal(text(one('.connection-name', liveDraft)), 'Live draft', 'draft name pill follows input');
const liveModels = fieldControl(liveEditor, '模型');
liveModels.value = 'voice-x, voice-y';
fire(liveModels, 'input');
assert.equal(text(one('.kv-model .kv-v', liveDraft)), 'voice-x', 'draft model pill follows input');
const confirmsBeforeDiscard = confirmCalls;
one('.connection-erase', liveDraft).click();
await settle();
assert.equal(confirmCalls, confirmsBeforeDiscard, 'discarding a draft asks nothing');
assert.equal(servicesRoot.querySelector('.connection-card[data-service="__draft__"]'), null, 'discarded draft card gone');
assert.equal(all('.connection-card', servicesRoot).length, 3);

// 卡片快捷动作与已有条目的删除。
const betaCard = card('beta', servicesRoot);
betaCard.click();
await settle();
const startButton = all('.svc-card-actions button', betaCard).find(item => text(item) === '启动');
assert.ok(startButton, 'offline card start action');
startButton.click();
await settle();
assert.ok(calls.findLast(item => item.method === 'start'), 'card start invokes the service');
assert.deepEqual(cardActions(betaCard), ['停止', '重启'], 'card actions follow the new phase');
const confirmsBeforeDelete = confirmCalls;
one('.connection-erase', betaCard).click();
await settle();
assert.equal(confirmCalls, confirmsBeforeDelete + 1, 'deleting a saved service asks first');
assert.ok(calls.findLast(item => item.method === 'remove'), 'card delete invokes remove');
assert.equal(all('.connection-card', servicesRoot).length, 2);

// ---------------------------------------------------------------------------
// llamacpp + systemone：StartLux 是模型任务，不是独立服务类型。
// ---------------------------------------------------------------------------

one('.connection-create > .btn', servicesRoot).click();
await settle();
const sysEditor = one('.svc-editor', servicesRoot);
const sysType = fieldControl(sysEditor, '类型');
const sysEndpoint = fieldControl(sysEditor, '地址');
sysType.value = 'llamacpp';
fire(sysType, 'change');
assert.equal(sysEndpoint.value, 'http://127.0.0.1:8081', 'llamacpp default endpoint 8081');
assert.equal(checkControl(sysEditor, '托管进程').checked, true, 'llamacpp starts managed');

const sysTasks = fieldControl(sysEditor, '模型任务');
assert.deepEqual([...sysTasks.options].map(item => item.value), ['embeddings,rerank', 'embeddings', 'rerank', 'systemone'], 'model task choices');
const sysGroup = all('.svc-process', sysEditor).find(item => text(item).includes('StartLux 本地预设'));
assert.ok(sysGroup?.hidden, 'StartLux preset hidden for embeddings/rerank');
assert.deepEqual(all('.svc-process', sysEditor).map(item => item.hidden), [false, true, false, true], 'llamacpp embeddings shows process and tuning');

sysTasks.value = 'systemone';
fire(sysTasks, 'change');
assert.equal(sysGroup.hidden, false, 'systemone task shows the StartLux preset');
assert.deepEqual(all('.svc-process', sysEditor).map(item => item.hidden), [false, false, true, true], 'StartLux shows process and preset only');

const sysModelDir = fieldControl(sysEditor, '模型目录');
const sysStartluxDir = fieldControl(sysEditor, 'StartLux 目录');
const sysSystemonePort = fieldControl(sysEditor, 'SystemOne 端口');
const sysThinkMode = fieldControl(sysEditor, '思考模式');
const sysGate = fieldControl(sysEditor, '思考阈值');
assert.deepEqual([...sysThinkMode.options].map(item => item.value), ['', 'auto', 'never', 'always'], 'think mode choices');

const addCountBeforeSystemone = addCount;
one('.svc-editor .actions .btn.primary', servicesRoot).click();
await settle();
assert.equal(addCount, addCountBeforeSystemone, 'missing model directory blocks save');
assert.match(text(one('.svc-editor > .msgline', servicesRoot)), /模型目录/, 'model directory error shown');

sysModelDir.value = 'D:/models/StartLux-0.8B';
fire(sysModelDir, 'input');
one('.svc-editor .actions .btn.primary', servicesRoot).click();
await settle();
assert.equal(addCount, addCountBeforeSystemone, 'missing StartLux directory blocks save');
assert.match(text(one('.svc-editor > .msgline', servicesRoot)), /StartLux/, 'StartLux directory error shown');

sysStartluxDir.value = 'C:/venv/Scripts';
fire(sysStartluxDir, 'input');
sysGate.value = '1.5';
fire(sysGate, 'input');
one('.svc-editor .actions .btn.primary', servicesRoot).click();
await settle();
assert.equal(addCount, addCountBeforeSystemone, 'gate above 1 blocks save');
assert.match(text(one('.svc-editor > .msgline', servicesRoot)), /0–1/, 'gate error shown');

const sysOptions = fieldControl(sysEditor, 'Options JSON');
sysOptions.value = JSON.stringify({ extra: 'kept', modelDir: 'old', llamacppUrl: 'old' });
fire(sysOptions, 'input');
sysSystemonePort.value = '8091';
fire(sysSystemonePort, 'input');
sysThinkMode.value = 'always';
fire(sysThinkMode, 'change');
sysGate.value = '0.7';
fire(sysGate, 'input');
checkControl(sysEditor, 'Instant 模型').checked = true;
fire(checkControl(sysEditor, 'Instant 模型'), 'change');
one('.svc-editor .actions .btn.primary', servicesRoot).click();
await settle();
const sysAdd = calls.findLast(item => item.method === 'add');
assert.ok(sysAdd, 'StartLux draft saves');
assert.equal(sysAdd.args[0].type, 'llamacpp');
assert.equal(sysAdd.args[0].endpoint, 'http://127.0.0.1:8081');
assert.deepEqual(sysAdd.args[0].tasks, ['systemone'], 'tasks systemone saved');
assert.deepEqual(sysAdd.args[0].options, {
  extra: 'kept',
  modelDir: 'D:/models/StartLux-0.8B',
  startluxDir: 'C:/venv/Scripts',
  systemonePort: 8091,
  thinkMode: 'always',
  gate: 0.7,
  instant: true,
});
console.log(`StartLux model/task smoke ok: options=${JSON.stringify(sysAdd.args[0].options)}`);

// ---------------------------------------------------------------------------
// 网关面板:三块编号折叠区。
// ---------------------------------------------------------------------------

const gateway = makeCtx('gateway', document.getElementById('gateway'));
bundle.panels.gateway.mount(gateway.ctx);
await settle();
const gatewayRoot = gateway.ctx.root;
assert.deepEqual(sectionTitles(gatewayRoot), ['基本', '令牌', '请求'], 'gateway sections');
assert.equal(all('.connection-step', gatewayRoot).length, 3, 'three numbered gateway steps');
assert.deepEqual(all('details.connection-section', gatewayRoot).map(item => item.open), [true, false, false]);
assert.equal(fieldControl(gatewayRoot, '端口').value, '9883', 'gateway default port 9883');
assert.equal(segmentedCalls, 0, 'no internal segmented switcher on either panel');
one('.svc-panel .actions .btn.primary', gatewayRoot).click();
await settle();
const saveGateway = calls.findLast(item => item.method === 'saveGateway');
assert.ok(saveGateway, 'gateway save');
assert.equal(saveGateway.args[0].port, 9883);
assert.equal(saveGateway.args[0].requestTimeoutSec, 180);
console.log(`webui smoke ok: panels=2 draft-save=1 draft-discard=1 delete=1 sections=4+3 segmented=${segmentedCalls} drawer=${drawerCalls}`);
