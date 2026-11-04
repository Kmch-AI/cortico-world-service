/**
 * 「服务」与「网关」两块页面面板。框架把 `webUi().panels` 渲染成 Cortico 自己的页面页签,
 * 所以这里不再做内部分段标签:每一块面板由框架单独挂载、单独卸载。
 *
 * 服务面板复刻模型供应商设置页:左侧是新建按钮与卡片列表,右侧是状态块与无弹层编辑器。
 * 编辑器的折叠区复用框架 connection-step / connection-section 的编号外观。4 秒轮询只更新
 * 卡片灯、状态行、状态块与动作,不重建正在编辑的表单。
 * 数据面只走 `ctx.invoke`;DOM 只走 `ctx.ui` 原语。
 */
import type {
  WebUiCheckbox, WebUiClientBundle, WebUiPanel, WebUiPanelContext, WebUiSheet,
} from 'cortico/web/shared/client-panel.ts';
import {
  SERVICE_TYPES, SERVICE_TYPE_LABELS,
  type PanelGateway, type PanelLogs, type PanelService, type PanelServiceEntry, type PanelState,
  type PanelTokenResult,
} from '../src/panel.ts';
import type { ServiceEntry, ServiceType } from '../src/types.ts';
import { llamacppLaunchMode } from '../src/entry.ts';
import { panelText, type PanelText } from './strings.ts';
import './style.css';

type Ui = WebUiPanelContext['ui'];
type Tone = 'on' | 'off' | 'plain';

/** 类型切换时的默认地址;其余类型没有可猜的端口。 */
const DEFAULT_ENDPOINTS: Partial<Record<ServiceType, string>> = {
  audiocpp: 'http://127.0.0.1:8080',
  sing: 'http://127.0.0.1:9882',
  llamacpp: 'http://127.0.0.1:8081',
  startlux: 'http://127.0.0.1:8091',
  systemone: 'http://127.0.0.1:8091',
};

const DRAFT_KEY = '__draft__';
const POLL_MS = 4000;

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

interface PhaseView {
  text: string;
  tone: Tone;
  bad?: boolean;
}

/** 服务条目的状态文案;停用优先于进程阶段。 */
function servicePhase(T: PanelText, status: PanelService): PhaseView {
  if (!status.entry.enabled) return { text: T.disabled, tone: 'off' };
  switch (status.phase) {
    case 'online': return { text: T.phaseOnline, tone: 'on' };
    case 'starting': return { text: T.phaseStarting, tone: 'plain' };
    case 'error': return { text: T.phaseError, tone: 'off', bad: true };
    default: return { text: T.phaseOff, tone: 'off' };
  }
}

function draftPhase(T: PanelText): PhaseView {
  return { text: T.draft, tone: 'plain' };
}

function gatewayPhase(T: PanelText, gw: PanelGateway): PhaseView {
  switch (gw.status) {
    case 'ok': return { text: T.phaseOnline, tone: 'on' };
    case 'starting': return { text: T.phaseStarting, tone: 'plain' };
    case 'degraded': return { text: T.phaseDegraded, tone: 'plain' };
    case 'error': return { text: T.phaseError, tone: 'off', bad: true };
    default: return { text: T.phaseOff, tone: 'off' };
  }
}

function typeNote(T: PanelText, type: ServiceType): string {
  switch (type) {
    case 'audiocpp': return T.typeAudiocpp;
    case 'sing': return T.typeSing;
    case 'openai': return T.typeOpenai;
    case 'llamacpp': return T.typeLlamacpp;
    case 'startlux': return T.typeStartlux;
    case 'systemone': return T.typeSystemone;
  }
  return T.typeLegacy;
}

function typeLabel(type: ServiceType): string {
  return SERVICE_TYPE_LABELS[type] ?? type;
}

function baseName(path: string): string {
  return path.split(/[\\/]+/).filter(Boolean).pop() ?? '';
}

/** 卡片上的模型摘要:多选时显示第一个 +N；StartLux 显示模型目录名。 */
function modelSummaryOf(type: ServiceType, models: readonly string[], modelDir = ''): string {
  const list = models.map((model) => model.trim()).filter(Boolean);
  if (list.length > 1) return `${list[0]} +${list.length - 1}`;
  if (list[0]) return list[0];
  if (type === 'startlux' && modelDir.trim()) return baseName(modelDir);
  return '';
}

function modelSummary(entry: Pick<ServiceEntry, 'type' | 'models' | 'options'>): string {
  const modelDir = typeof entry.options?.modelDir === 'string' ? entry.options.modelDir : '';
  return modelSummaryOf(entry.type, entry.models ?? [], modelDir);
}

function lampClass(phase: PhaseView): string {
  return `svc-lamp ${phase.bad ? 'bad' : phase.tone}`;
}

function phasePill(ui: Ui, phase: PhaseView): HTMLSpanElement {
  const pill = ui.pill(phase.text, phase.tone);
  if (phase.bad) pill.classList.add('svc-bad');
  return pill;
}

function fieldBlock(
  ui: Ui,
  label: string,
  control: HTMLElement,
  note?: string | HTMLElement,
): HTMLElement {
  const box = ui.h('div', 'connection-field');
  box.append(ui.field(label, control));
  if (note) box.append(typeof note === 'string' ? ui.h('p', 'tdesc', note) : note);
  return box;
}

function checkBlock(ui: Ui, box: WebUiCheckbox, note: string): HTMLElement {
  const wrap = ui.h('div', 'svc-check');
  wrap.append(box.el, ui.h('p', 'tdesc', note));
  return wrap;
}

/**
 * 编号折叠区。框架的 `.connection-step` 计数器与 summary 编号圆点只认
 * `details.sheet > summary .connection-step-heading > h3`,这里照供应商编辑页的写法搭出来。
 */
function numberedSection(
  ui: Ui,
  host: HTMLElement,
  id: string,
  title: string,
  defaultOpen: boolean,
): WebUiSheet {
  const card = ui.foldSheet(id, { title, defaultOpen });
  card.el.classList.add('connection-section');
  const summary = card.el.querySelector('summary');
  const heading = summary?.querySelector('h3');
  if (summary && heading) {
    const wrap = ui.h('div', 'connection-step-heading');
    wrap.append(heading);
    summary.prepend(wrap);
  }
  const step = ui.h('div', 'connection-step');
  step.append(card.el);
  host.append(step);
  return card;
}

function trashIcon(doc: Document): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(NS, 'svg') as SVGSVGElement;
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  for (const d of ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6', 'M10 11v6M14 11v6']) {
    const path = doc.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

interface FormSeed {
  name: string;
  type: ServiceType;
  endpoint: string;
  enabled: boolean;
  manage: boolean;
  autoStart: boolean;
  restartOnExit: boolean;
  serverDir: string;
  binary: string;
  args: string;
  secretName: string;
  modelProfile: string;
  models: string;
  tasks: string;
  launchMode: string;
  optionsText: string;
}

interface RuntimeFields {
  backend: string;
  device: string;
  threads: string;
  idleUnloadMs: string;
  ui: boolean;
  modelsDir: string;
  cacheDir: string;
  contextSize: string;
  nGpuLayers: string;
  parallel: string;
  modelDir: string;
  llamacppService: string;
  llamacppUrl: string;
  thinkMode: string;
  gate: string;
  instant: boolean;
}

interface DraftState extends FormSeed, RuntimeFields {}

type ServicePayload = Record<string, unknown>;
type FormRead = { value: ServicePayload } | { error: string };
type Selection = { kind: 'draft' } | { kind: 'service'; id: string } | null;

interface ServiceForm {
  el: HTMLElement;
  read(): FormRead;
  capture(): { seed: FormSeed; runtime: RuntimeFields };
}

interface FormBuildOptions {
  mode: 'draft' | 'edit';
  /** 草稿的运行时字段存回草稿,不重新从 options JSON 推导。 */
  runtime?: RuntimeFields;
  /** 同一组配置里的服务;StartLux Decision 用它列出 llama.cpp 条目。 */
  services?: readonly PanelService[];
  onDirty(): void;
  onChange?(next: { seed: FormSeed; runtime: RuntimeFields }): void;
  onTest?(): Promise<{ ok: boolean; text: string }>;
}

interface CardNode {
  el: HTMLElement;
  name: HTMLElement;
  typeValue: HTMLElement;
  modelValue: HTMLElement;
  status: HTMLElement;
  lamp: HTMLSpanElement;
  statusText: HTMLSpanElement;
  actions: HTMLElement;
  actionKey: string;
}

function selectionKeyOf(selection: Selection): string {
  if (!selection) return '';
  return selection.kind === 'draft' ? 'draft' : `service:${selection.id}`;
}

function newDraft(T: PanelText): DraftState {
  return {
    name: T.draftName,
    type: 'audiocpp',
    endpoint: DEFAULT_ENDPOINTS.audiocpp!,
    enabled: false,
    manage: true,
    autoStart: false,
    restartOnExit: false,
    serverDir: '',
    binary: '',
    args: '',
    secretName: '',
    modelProfile: '',
    models: '',
    tasks: '',
    launchMode: 'router',
    optionsText: '',
    backend: '',
    device: '',
    threads: '',
    idleUnloadMs: '',
    ui: true,
    modelsDir: '',
    cacheDir: '',
    contextSize: '',
    nGpuLayers: '',
    parallel: '',
    modelDir: '',
    llamacppService: '',
    llamacppUrl: '',
    thinkMode: '',
    gate: '',
    instant: false,
  };
}

function seedOfEntry(entry: ServiceEntry): FormSeed {
  return {
    name: entry.name,
    type: entry.type,
    endpoint: entry.endpoint,
    enabled: entry.enabled,
    manage: entry.manage,
    autoStart: entry.autoStart,
    restartOnExit: entry.restartOnExit,
    serverDir: entry.serverDir ?? '',
    binary: entry.binary ?? '',
    args: entry.args ?? '',
    secretName: entry.secretName ?? '',
    modelProfile: entry.modelProfile ?? '',
    models: (entry.models ?? []).join(', '),
    tasks: (entry.tasks ?? []).join(','),
    launchMode: entry.type === 'llamacpp' ? llamacppLaunchMode(entry) : '',
    optionsText: entry.options && Object.keys(entry.options).length
      ? JSON.stringify(entry.options, null, 2)
      : '',
  };
}

function optionsObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function runtimeOfOptions(options: Record<string, unknown> | null): RuntimeFields {
  const numberText = (value: unknown): string =>
    typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
  return {
    backend: typeof options?.backend === 'string' ? options.backend : '',
    device: numberText(options?.device),
    threads: numberText(options?.threads),
    idleUnloadMs: numberText(options?.idleUnloadMs),
    ui: options?.ui !== false,
    modelsDir: typeof options?.modelsDir === 'string' ? options.modelsDir : '',
    cacheDir: typeof options?.cacheDir === 'string' ? options.cacheDir : '',
    contextSize: numberText(options?.contextSize),
    nGpuLayers: typeof options?.nGpuLayers === 'string' ? options.nGpuLayers : '',
    parallel: numberText(options?.parallel),
    modelDir: typeof options?.modelDir === 'string' ? options.modelDir : '',
    llamacppService: typeof options?.llamacppService === 'string' ? options.llamacppService : '',
    llamacppUrl: typeof options?.llamacppUrl === 'string' ? options.llamacppUrl : '',
    thinkMode: typeof options?.thinkMode === 'string' ? options.thinkMode : '',
    gate: numberText(options?.gate),
    instant: options?.instant === true,
  };
}

function parseInteger(raw: string): number | null | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  const value = Number(text);
  return Number.isInteger(value) ? value : null;
}

function buildServiceForm(
  ui: Ui,
  ctx: WebUiPanelContext,
  T: PanelText,
  seed: FormSeed,
  opts: FormBuildOptions,
): ServiceForm {
  const prefix = opts.mode === 'draft' ? 'service-draft' : 'service-edit';
  const runtime = opts.runtime ?? runtimeOfOptions(optionsObject(seed.optionsText));

  const name = ui.input({ value: seed.name });
  const type = ui.select({
    value: seed.type,
    options: SERVICE_TYPES.map((value) => ({ value, label: typeLabel(value) })),
  });
  const typeNoteEl = ui.h('div', 'tdesc', typeNote(T, seed.type));
  const endpoint = ui.input({
    value: seed.endpoint,
    cls: 'mono',
    placeholder: 'http://127.0.0.1:8080',
  });

  const enabled = ui.checkbox(T.flagEnabled, { checked: seed.enabled });
  const manage = ui.checkbox(T.flagManage, { checked: seed.manage });
  const autoStart = ui.checkbox(T.flagAutoStart, { checked: seed.autoStart });
  const restartOnExit = ui.checkbox(T.flagRestartOnExit, { checked: seed.restartOnExit });

  const serverDir = ui.input({ value: seed.serverDir });
  const binary = ui.input({ value: seed.binary });
  const args = ui.input({ value: seed.args, cls: 'mono' });

  const backend = ui.select({
    value: runtime.backend,
    options: [
      { value: '', label: T.defaultValue },
      'cuda', 'cpu', 'vulkan', 'hip', 'metal',
    ],
  });
  const device = ui.input({ type: 'number', value: runtime.device });
  device.min = '0';
  device.step = '1';
  const threads = ui.input({ type: 'number', value: runtime.threads });
  threads.min = '1';
  threads.step = '1';
  const idleUnloadMs = ui.input({ type: 'number', value: runtime.idleUnloadMs });
  idleUnloadMs.min = '0';
  idleUnloadMs.step = '1';
  const uiBox = ui.checkbox(T.flagUi, { checked: runtime.ui });

  const taskOptions = [
    { value: 'embeddings,rerank', label: T.taskEmbeddings },
    { value: 'embeddings', label: 'Embeddings' },
    { value: 'rerank', label: 'Rerank' },
    { value: 'chat', label: T.taskChat },
  ];
  // 任务列表用逗号存储；旧配置可能带空格，先归一化再匹配预设，避免下拉框退化成自定义文本。
  const seedTasks = seed.tasks.replace(/\s*,\s*/g, ',');
  if (seedTasks && !taskOptions.some((option) => option.value === seedTasks)) {
    taskOptions.push({ value: seedTasks, label: seedTasks });
  }
  const tasks = ui.select({
    value: seedTasks || 'chat',
    options: taskOptions,
  });
  const launchMode = ui.select({
    value: seed.launchMode === 'single' ? 'single' : 'router',
    options: [
      { value: 'router', label: T.launchMulti },
      { value: 'single', label: T.launchSingle },
    ],
  });
  const modelsDir = ui.input({ value: runtime.modelsDir, cls: 'mono' });
  const cacheDir = ui.input({ value: runtime.cacheDir, cls: 'mono' });
  const contextSize = ui.input({ type: 'number', value: runtime.contextSize });
  contextSize.min = '0';
  contextSize.step = '1';
  contextSize.placeholder = '16384';
  const nGpuLayers = ui.input({ value: runtime.nGpuLayers, cls: 'mono', placeholder: 'auto' });
  const parallel = ui.input({ type: 'number', value: runtime.parallel });
  parallel.min = '1';
  parallel.step = '1';
  parallel.placeholder = '1';
  const modelDir = ui.input({ value: runtime.modelDir, cls: 'mono' });
  const llamacppServices = (opts.services ?? []).filter((item) => item.entry.type === 'llamacpp');
  const llamacppServiceOptions = [
    { value: '', label: T.manualAddress },
    ...llamacppServices.map((item) => ({ value: item.entry.id, label: item.entry.name })),
  ];
  if (runtime.llamacppService
    && !llamacppServiceOptions.some((option) => option.value === runtime.llamacppService)) {
    llamacppServiceOptions.push({
      value: runtime.llamacppService,
      label: `${runtime.llamacppService} ${T.missingService}`,
    });
  }
  const llamacppService = ui.select({
    value: runtime.llamacppService,
    options: llamacppServiceOptions,
  });
  const llamacppUrl = ui.input({
    value: runtime.llamacppUrl,
    cls: 'mono',
    placeholder: 'http://127.0.0.1:8081',
  });
  const thinkMode = ui.select({
    value: runtime.thinkMode,
    options: [{ value: '', label: T.defaultValue }, 'auto', 'never', 'always'],
  });
  const gate = ui.input({ type: 'number', value: runtime.gate });
  gate.min = '0';
  gate.max = '1';
  gate.step = '0.01';
  const instant = ui.checkbox(T.flagInstant, { checked: runtime.instant });

  const secretName = ui.input({
    value: seed.secretName,
    cls: 'mono',
    placeholder: 'SERVICE_API_KEY',
  });
  const modelProfile = ui.input({ value: seed.modelProfile, placeholder: 'auto' });
  const models = ui.input({ value: seed.models });
  const optionsArea = ui.textarea({ value: seed.optionsText, rows: 6, cls: 'mono' });

  const pathRow = (input: HTMLInputElement, kind: 'file' | 'directory'): HTMLElement => {
    const row = ui.h('div', 'svc-path');
    row.append(input, ui.button(T.choose, {
      size: 'sm',
      onClick: () => {
        void ctx.pickPath({ kind, currentPath: input.value }).then((chosen) => {
          if (!chosen) return;
          input.value = chosen;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
      },
    }));
    return row;
  };

  // 模型文件选择:多模型多选、单模型单选;文件列表从服务端读 GGUF 目录。
  const selectedModels = seed.models.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
  let scannedFiles: string[] = [];
  let scanToken = 0;
  let scanTimer: { dispose(): void } | null = null;
  const modelList = ui.h('div', 'svc-model-list');
  const modelEmpty = ui.h('p', 'tdesc', T.modelFilesEmpty);
  const pickerHead = ui.h('div', 'svc-path');
  pickerHead.append(ui.button(T.refresh, {
    size: 'sm',
    onClick: () => void scanModels(),
  }));
  const modelChooser = ui.h('div', 'svc-models');
  modelChooser.append(pickerHead, modelList, ui.h('p', 'tdesc', T.modelFilesNote));

  function syncModelsInput(): void {
    models.value = selectedModels.join(', ');
    models.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function renderModelList(): void {
    modelList.replaceChildren();
    const single = launchMode.value === 'single';
    if (single && selectedModels.length > 1) selectedModels.splice(1);
    const known = new Set(scannedFiles);
    const extras = selectedModels.filter((name) => !known.has(name));
    const entries = [...scannedFiles, ...extras];
    if (!entries.length) {
      modelList.append(modelsDir.value.trim() ? modelEmpty : ui.h('p', 'tdesc', T.modelFilesNoDir));
      return;
    }
    const labelOf = (name: string): string =>
      extras.includes(name) ? `${name} ${T.modelFilesMissing}` : name;
    if (single) {
      const select = ui.select({
        value: selectedModels[0] ?? '',
        options: [{ value: '', label: T.none }, ...entries.map((name) => ({ value: name, label: labelOf(name) }))],
      });
      select.addEventListener('change', () => {
        selectedModels.splice(0, selectedModels.length, ...(select.value ? [select.value] : []));
        syncModelsInput();
      }, { signal: ctx.signal });
      modelList.append(select);
      return;
    }
    for (const name of entries) {
      const box = ui.checkbox(labelOf(name), {
        checked: selectedModels.includes(name),
        onChange: (checked) => {
          const index = selectedModels.indexOf(name);
          if (checked && index < 0) selectedModels.push(name);
          else if (!checked && index >= 0) selectedModels.splice(index, 1);
          syncModelsInput();
        },
      });
      modelList.append(box.el);
    }
  }

  async function scanModels(): Promise<void> {
    const dir = modelsDir.value.trim();
    const token = ++scanToken;
    if (!dir) {
      scannedFiles = [];
      renderModelList();
      return;
    }
    try {
      const files = await ctx.invoke<string[]>('modelFiles', [dir]);
      if (ctx.signal.aborted || token !== scanToken) return;
      scannedFiles = Array.isArray(files) ? files.filter((item) => typeof item === 'string') : [];
    } catch {
      if (ctx.signal.aborted || token !== scanToken) return;
      scannedFiles = [];
    }
    renderModelList();
  }

  const scheduleScan = (): void => {
    scanTimer?.dispose();
    scanTimer = ctx.timeout(() => void scanModels(), 300);
  };
  modelsDir.addEventListener('input', scheduleScan, { signal: ctx.signal });
  modelsDir.addEventListener('change', scheduleScan, { signal: ctx.signal });

  const identity = ui.sheet({ title: T.sectionIdentity });
  identity.el.classList.add('connection-identity');
  identity.body.append(
    fieldBlock(ui, `${T.fieldName} *`, name, T.nameNote),
    fieldBlock(ui, `${T.fieldType} *`, type, typeNoteEl),
  );

  const flow = ui.h('div', 'connection-flow');

  const address = numberedSection(ui, flow, `${prefix}-address`, T.sectionAddress, true);
  address.body.append(
    fieldBlock(ui, `${T.fieldEndpoint} *`, endpoint, T.endpointNote),
    fieldBlock(ui, T.fieldUpstreamToken, secretName, T.upstreamTokenNote),
  );
  if (opts.onTest) {
    const row = ui.rowbar();
    row.classList.add('connection-test');
    const line = ui.msgline();
    const button = ui.button(T.testConnection, {
      onClick: () => void runTest(),
    });
    row.append(button, line);
    address.body.append(row);

    async function runTest(): Promise<void> {
      button.disabled = true;
      line.textContent = '';
      line.classList.remove('bad');
      try {
        const result = await opts.onTest!();
        if (ctx.signal.aborted) return;
        line.textContent = result.text;
        line.classList.toggle('bad', !result.ok);
      } catch (err) {
        if (ctx.signal.aborted) return;
        line.textContent = `${T.testFailed}: ${errText(err)}`;
        line.classList.add('bad');
      } finally {
        button.disabled = false;
      }
    }
  }

  const runtimeSection = numberedSection(ui, flow, `${prefix}-runtime`, T.sectionRuntime, true);
  const flags = ui.h('div', 'svc-flags');
  flags.append(
    checkBlock(ui, enabled, T.serviceEnabledNote),
    checkBlock(ui, manage, T.manageNote),
    checkBlock(ui, autoStart, T.autoStartNote),
    checkBlock(ui, restartOnExit, T.restartOnExitNote),
  );
  runtimeSection.body.append(flags);

  const processGroup = ui.h('div', 'svc-process');
  processGroup.append(
    fieldBlock(ui, T.fieldServerDir, pathRow(serverDir, 'directory'), T.serverDirNote),
    fieldBlock(ui, T.fieldBinary, pathRow(binary, 'file'), T.binaryNote),
    fieldBlock(ui, T.fieldArgs, args, T.argsNote),
  );
  runtimeSection.body.append(processGroup);

  const modelsDirField = fieldBlock(ui, T.fieldModelsDir, pathRow(modelsDir, 'directory'), T.modelsDirNote);
  const cacheDirField = fieldBlock(ui, T.fieldCacheDir, pathRow(cacheDir, 'directory'), T.cacheDirNote);
  const llamacppGroup = ui.h('div', 'svc-process');
  llamacppGroup.append(
    fieldBlock(ui, T.fieldLaunchMode, launchMode, T.launchModeNote),
    cacheDirField,
    fieldBlock(ui, T.fieldContextSize, contextSize, T.contextSizeNote),
    fieldBlock(ui, T.fieldNgl, nGpuLayers, T.nglNote),
    fieldBlock(ui, T.fieldParallel, parallel, T.parallelNote),
  );
  runtimeSection.body.append(llamacppGroup);

  const llamacppUrlField = fieldBlock(ui, T.fieldLlamacppUrl, llamacppUrl, T.llamacppUrlNote);
  const startluxGroup = ui.h('div', 'svc-process');
  startluxGroup.append(
    ui.h('h4', 'svc-group-title', T.startluxPreset),
    fieldBlock(ui, T.fieldModelDir, pathRow(modelDir, 'directory'), T.modelDirNote),
    fieldBlock(ui, T.fieldLlamacppService, llamacppService, T.llamacppServiceNote),
    llamacppUrlField,
    fieldBlock(ui, T.fieldThinkMode, thinkMode, T.thinkModeNote),
    fieldBlock(ui, T.fieldGate, gate, T.gateNote),
    checkBlock(ui, instant, T.instantNote),
    ui.h('p', 'tdesc', T.startluxVenvNote),
  );
  runtimeSection.body.append(startluxGroup);

  const tuningGroup = ui.h('div', 'svc-process');
  tuningGroup.append(
    fieldBlock(ui, T.fieldBackend, backend),
    fieldBlock(ui, T.fieldDevice, device, T.deviceNote),
    fieldBlock(ui, T.fieldThreads, threads, T.threadsNote),
  );
  runtimeSection.body.append(tuningGroup);

  const audiocppGroup = ui.h('div', 'svc-process');
  audiocppGroup.append(
    fieldBlock(ui, T.fieldIdleUnloadMs, idleUnloadMs, T.idleUnloadNote),
    checkBlock(ui, uiBox, T.uiNote),
  );
  runtimeSection.body.append(audiocppGroup);

  const modelsSection = numberedSection(ui, flow, `${prefix}-models`, T.sectionModels, true);
  const tasksField = fieldBlock(ui, T.fieldTasks, tasks, T.tasksNote);
  const profileField = fieldBlock(ui, T.fieldModelProfile, modelProfile, T.modelProfileNote);
  const modelFilesField = fieldBlock(ui, T.fieldModelFiles, modelChooser);
  const modelsField = fieldBlock(ui, T.fieldModels, models, T.modelsNote);
  modelsSection.body.append(tasksField, profileField, modelsDirField, modelFilesField, modelsField);

  const advanced = numberedSection(ui, flow, `${prefix}-advanced`, T.advancedTitle, false);
  advanced.body.append(fieldBlock(ui, T.fieldOptions, optionsArea, T.optionsNote));

  const el = ui.h('div', 'svc-formwrap');
  el.append(identity.el, flow);

  let lastType = seed.type;

  function syncVisibility(): void {
    const current = type.value as ServiceType;
    const managed = manage.checked;
    const llama = current === 'llamacpp';
    const startlux = current === 'startlux';
    processGroup.hidden = !managed;
    llamacppGroup.hidden = !(managed && llama);
    startluxGroup.hidden = !(managed && startlux);
    tuningGroup.hidden = !(managed && current === 'audiocpp');
    audiocppGroup.hidden = !(managed && current === 'audiocpp');
    tasksField.hidden = !llama;
    profileField.hidden = llama || startlux;
    modelsDirField.hidden = !llama;
    modelFilesField.hidden = !llama;
    modelsField.hidden = llama || startlux;
    modelsSection.el.hidden = startlux;
    llamacppUrlField.hidden = Boolean(llamacppService.value);
  }

  manage.input.addEventListener('change', syncVisibility, { signal: ctx.signal });
  tasks.addEventListener('change', syncVisibility, { signal: ctx.signal });
  llamacppService.addEventListener('change', syncVisibility, { signal: ctx.signal });
  launchMode.addEventListener('change', () => {
    renderModelList();
    syncVisibility();
  }, { signal: ctx.signal });
  type.addEventListener('change', () => {
    const next = type.value as ServiceType;
    typeNoteEl.textContent = typeNote(T, next);
    const previousDefault = DEFAULT_ENDPOINTS[lastType];
    const currentEndpoint = endpoint.value.trim();
    const nextDefault = DEFAULT_ENDPOINTS[next];
    if (nextDefault && (!currentEndpoint
      || (previousDefault !== undefined && currentEndpoint === previousDefault))) {
      endpoint.value = nextDefault;
    }
    if (next === 'openai' || next === 'systemone') manage.setChecked(false);
    if (next === 'startlux') {
      selectedModels.splice(0, selectedModels.length);
      models.value = '';
    }
    lastType = next;
    if (next === 'llamacpp' && modelsDir.value.trim()) scheduleScan();
    syncVisibility();
  }, { signal: ctx.signal });
  renderModelList();
  syncVisibility();
  if (seed.type === 'llamacpp' && runtime.modelsDir) void scanModels();

  function capture(): { seed: FormSeed; runtime: RuntimeFields } {
    return {
      seed: {
        name: name.value.trim(),
        type: type.value as ServiceType,
        endpoint: endpoint.value,
        enabled: enabled.checked,
        manage: manage.checked,
        autoStart: autoStart.checked,
        restartOnExit: restartOnExit.checked,
        serverDir: serverDir.value,
        binary: binary.value,
        args: args.value,
        secretName: secretName.value,
        modelProfile: modelProfile.value,
        models: models.value,
        tasks: tasks.value,
        launchMode: launchMode.value,
        optionsText: optionsArea.value,
      },
      runtime: {
        backend: backend.value,
        device: device.value,
        threads: threads.value,
        idleUnloadMs: idleUnloadMs.value,
        ui: uiBox.checked,
        modelsDir: modelsDir.value,
        cacheDir: cacheDir.value,
        contextSize: contextSize.value,
        nGpuLayers: nGpuLayers.value,
        parallel: parallel.value,
        modelDir: modelDir.value,
        llamacppService: llamacppService.value,
        llamacppUrl: llamacppUrl.value,
        thinkMode: thinkMode.value,
        gate: gate.value,
        instant: instant.checked,
      },
    };
  }

  const changed = (): void => {
    opts.onDirty();
    opts.onChange?.(capture());
  };
  el.addEventListener('input', changed, { signal: ctx.signal });
  el.addEventListener('change', changed, { signal: ctx.signal });

  function read(): FormRead {
    const nameValue = name.value.trim();
    if (!nameValue) return { error: T.badName };
    const address = endpoint.value.trim();
    if (!address) return { error: T.badEndpoint };
    const typeValue = type.value as ServiceType;

    let options: Record<string, unknown> = {};
    const optionsText = optionsArea.value.trim();
    if (optionsText) {
      const parsed = optionsObject(optionsText);
      if (!parsed) return { error: T.badOptions };
      options = { ...parsed };
    }

    const llama = typeValue === 'llamacpp';
    const startlux = typeValue === 'startlux';
    if (manage.checked && llama) {
      delete options.modelDir;
      delete options.llamacppService;
      delete options.llamacppUrl;
      delete options.thinkMode;
      delete options.gate;
      delete options.instant;

      const mode = launchMode.value === 'single' ? 'single' : 'router';
      options.launchMode = mode;

      const modelsDirValue = modelsDir.value.trim();
      if (!modelsDirValue) return { error: T.badModelsDir };
      options.modelsDir = modelsDirValue;

      if (mode === 'single' && selectedModels.length === 0
        && !/(^|\s)(-m|--model)(\s|=)/.test(args.value)) {
        return { error: T.badSingleModel };
      }

      const cacheDirValue = cacheDir.value.trim();
      if (cacheDirValue) options.cacheDir = cacheDirValue;
      else delete options.cacheDir;

      const contextText = contextSize.value.trim();
      if (contextText) {
        const value = Number(contextText);
        if (!Number.isInteger(value) || value < 0) return { error: T.badContextSize };
        options.contextSize = value;
      } else {
        delete options.contextSize;
      }

      const nglText = nGpuLayers.value.trim();
      if (nglText) {
        if (!/^(auto|all|\d+)$/i.test(nglText)) return { error: T.badNgl };
        options.nGpuLayers = nglText.toLowerCase();
      } else {
        delete options.nGpuLayers;
      }

      const parallelText = parallel.value.trim();
      if (parallelText) {
        const value = Number(parallelText);
        if (!Number.isInteger(value) || value < 1) return { error: T.badParallel };
        options.parallel = value;
      } else {
        delete options.parallel;
      }
    } else if (manage.checked && startlux) {
      delete options.launchMode;
      delete options.modelsDir;
      delete options.cacheDir;
      delete options.contextSize;
      delete options.nGpuLayers;
      delete options.parallel;
      // 0.6–0.8 的本地 StartLux 键。
      delete options.startluxDir;
      delete options.startluxBinary;
      delete options.startluxArgs;
      delete options.systemonePort;
      delete options.systemoneUrl;
      delete options.systemoneSecretName;

      const modelDirValue = modelDir.value.trim();
      if (!modelDirValue) return { error: T.badModelDir };
      options.modelDir = modelDirValue;

      const serviceId = llamacppService.value.trim();
      if (serviceId) {
        options.llamacppService = serviceId;
        delete options.llamacppUrl;
      } else {
        const url = llamacppUrl.value.trim();
        if (!url) return { error: T.badLlamacppUrl };
        options.llamacppUrl = url;
        delete options.llamacppService;
      }

      const thinkModeValue = thinkMode.value.trim();
      if (thinkModeValue) {
        if (thinkModeValue !== 'auto' && thinkModeValue !== 'never' && thinkModeValue !== 'always') {
          return { error: T.badThinkMode };
        }
        options.thinkMode = thinkModeValue;
      } else {
        delete options.thinkMode;
      }

      const gateText = gate.value.trim();
      if (gateText) {
        const gateValue = Number(gateText);
        if (!Number.isFinite(gateValue) || gateValue < 0 || gateValue > 1) {
          return { error: T.badGate };
        }
        options.gate = gateValue;
      } else {
        delete options.gate;
      }
      if (instant.checked) options.instant = true;
      else delete options.instant;
    } else if (!llama && !startlux) {
      for (const key of [
        'launchMode', 'modelsDir', 'cacheDir', 'contextSize', 'nGpuLayers', 'parallel',
        'modelDir', 'llamacppService', 'llamacppUrl', 'thinkMode', 'gate', 'instant',
        'startluxDir', 'startluxBinary', 'startluxArgs', 'systemonePort', 'systemoneUrl',
        'systemoneSecretName',
      ]) {
        delete options[key];
      }
    }
    // 不托管时也要记住 GGUF 目录，下一次打开面板才能重新扫描模型。
    if (llama && !manage.checked) {
      const modelsDirValue = modelsDir.value.trim();
      if (modelsDirValue) options.modelsDir = modelsDirValue;
      else delete options.modelsDir;
    }

    if (manage.checked && typeValue === 'audiocpp') {
      const backendValue = backend.value.trim();
      if (backendValue) options.backend = backendValue;
      else delete options.backend;

      const deviceValue = parseInteger(device.value);
      if (deviceValue === null || (deviceValue !== undefined && deviceValue < 0)) {
        return { error: T.badDevice };
      }
      if (deviceValue === undefined) delete options.device;
      else options.device = deviceValue;

      const threadsValue = parseInteger(threads.value);
      if (threadsValue === null || (threadsValue !== undefined && threadsValue < 1)) {
        return { error: T.badThreads };
      }
      if (threadsValue === undefined) delete options.threads;
      else options.threads = threadsValue;

      if (typeValue === 'audiocpp') {
        const idleValue = parseInteger(idleUnloadMs.value);
        if (idleValue === null || (idleValue !== undefined && idleValue < 0)) {
          return { error: T.badIdle };
        }
        if (idleValue === undefined) delete options.idleUnloadMs;
        else options.idleUnloadMs = idleValue;
        options.ui = uiBox.checked;
      }
    }

    const list = llama
      ? (launchMode.value === 'single' ? selectedModels.slice(0, 1) : [...selectedModels])
      : models.value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
    return {
      value: {
        name: nameValue,
        type: typeValue,
        endpoint: address,
        enabled: enabled.checked,
        manage: manage.checked,
        autoStart: autoStart.checked,
        restartOnExit: restartOnExit.checked,
        serverDir: serverDir.value.trim() || null,
        binary: binary.value.trim() || null,
        args: args.value.trim() || null,
        secretName: secretName.value.trim() || null,
        modelProfile: llama || startlux ? null : (modelProfile.value.trim() || null),
        models: startlux ? null : (list.length ? list : null),
        tasks: llama
          ? tasks.value.split(',').map((item) => item.trim()).filter(Boolean)
          : null,
        options: Object.keys(options).length ? options : null,
      },
    };
  }

  return { el, read, capture };
}

const servicesPanel: WebUiPanel = {
  mount(ctx: WebUiPanelContext): void {
    const { ui } = ctx;
    const T = panelText(ctx.language);
    const doc = ctx.root.ownerDocument;

    const root = ui.h('div', 'svc-panel');
    const msg = ui.msgline();
    msg.hidden = true;
    const layout = ui.h('div', 'svc-workbench');
    const side = ui.h('aside', 'svc-side');
    const creator = ui.h('div', 'connection-create');
    const list = ui.h('div', 'connection-cards svc-cards');
    const editor = ui.h('div', 'svc-editor');
    const addButton = ui.button(T.add, {
      variant: 'primary',
      onClick: () => openDraft(),
    });
    creator.append(addButton, ui.h('p', 'connection-create-hint', T.listNote));
    side.append(creator, list);
    layout.append(side, editor);
    root.append(msg, layout);
    ctx.root.append(root);

    let state: PanelState | null = null;
    let draft: DraftState | null = null;
    let selection: Selection = null;
    let listKey = '';
    let renderedSelection = '';
    let paintStatus: (() => void) | null = null;
    let paintDraftStatus: (() => void) | null = null;
    let refreshFailed = false;
    let refreshing = false;
    let refreshAgain = false;
    let pendingSelect: string | null = null;
    let initialized = false;
    const cards = new Map<string, CardNode>();

    const mono = (text: string): HTMLElement => ui.h('span', 'svc-mono', text);

    const tokenCell = (set: boolean, name: string | undefined): HTMLElement => {
      const row = ui.h('span', 'svc-chiprow');
      row.append(
        ui.pill(set ? T.tokenSetState : T.tokenUnset, set ? 'on' : 'off'),
        ui.h('span', 'svc-mono', name || T.none),
      );
      return row;
    };

    function fail(err: unknown): void {
      msg.hidden = false;
      msg.textContent = `${T.failed}: ${errText(err)}`;
      msg.classList.add('bad');
    }

    function clearMsg(): void {
      msg.hidden = true;
      msg.textContent = '';
      msg.classList.remove('bad');
    }

    function paintPhase(node: CardNode, phase: PhaseView): void {
      node.lamp.className = lampClass(phase);
      node.statusText.textContent = phase.text;
      node.status.dataset.tone = phase.bad ? 'error'
        : phase.tone === 'on' ? 'ready'
          : phase.tone === 'plain' ? 'draft' : '';
    }

    function quickActions(service: PanelService): HTMLElement[] {
      const id = service.entry.id;
      const buttons: HTMLElement[] = [];
      if (service.entry.enabled && service.phase !== 'online' && service.phase !== 'starting') {
        buttons.push(ui.button(T.start, {
          size: 'sm',
          onClick: (event) => { event.stopPropagation(); void act('start', [id]); },
        }));
      }
      if (service.phase === 'online' || service.phase === 'starting') {
        buttons.push(ui.button(T.stop, {
          size: 'sm',
          onClick: (event) => { event.stopPropagation(); void act('stop', [id]); },
        }));
      }
      if (service.entry.enabled) {
        buttons.push(ui.button(T.restart, {
          size: 'sm',
          onClick: (event) => { event.stopPropagation(); void act('restart', [id]); },
        }));
      }
      return buttons;
    }

    function buildCard(identity: string, isDraft: boolean): CardNode {
      const el = ui.h('article', 'connection-card');
      el.dataset.service = identity;
      el.tabIndex = 0;

      const name = ui.h('div', 'connection-name');
      const facts = ui.h('div', 'connection-facts');
      const fact = (key: string, label: string): HTMLElement => {
        const box = ui.h('span', `kv kv-${key}`);
        const value = ui.h('span', 'kv-v');
        box.append(ui.h('span', 'kv-k', label), value);
        facts.append(box);
        return value;
      };
      const typeValue = fact('type', T.cardType);
      const modelValue = fact('model', T.cardModel);

      const status = ui.h('div', 'connection-status svc-statusline');
      const lamp = ui.h('span', 'svc-lamp');
      const statusText = ui.h('span');
      status.append(lamp, statusText);

      const actions = ui.h('div', 'svc-card-actions');

      const erase = ui.h('button', 'connection-erase') as HTMLButtonElement;
      erase.type = 'button';
      erase.title = isDraft ? T.discard : T.delete;
      erase.setAttribute('aria-label', erase.title);
      erase.append(trashIcon(doc));
      erase.addEventListener('click', (event) => {
        event.stopPropagation();
        if (isDraft) discardDraft();
        else void removeService(identity, name.textContent || identity);
      }, { signal: ctx.signal });

      el.append(erase, name, facts, status, actions);
      el.addEventListener('click', (event) => {
        if ((event.target as Element).closest('button')) return;
        select(isDraft ? { kind: 'draft' } : { kind: 'service', id: identity });
      }, { signal: ctx.signal });
      el.addEventListener('keydown', (event) => {
        if (event.target !== el) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        select(isDraft ? { kind: 'draft' } : { kind: 'service', id: identity });
      }, { signal: ctx.signal });

      return { el, name, typeValue, modelValue, status, lamp, statusText, actions, actionKey: '' };
    }

    function paintList(): void {
      for (const [identity, node] of cards) {
        if (identity === DRAFT_KEY) {
          if (!draft) continue;
          node.name.textContent = draft.name.trim() || T.draftName;
          node.typeValue.textContent = typeLabel(draft.type);
          node.modelValue.textContent = modelSummaryOf(
            draft.type,
            draft.models.split(/[\s,]+/),
            draft.modelDir,
          ) || T.none;
          paintPhase(node, draftPhase(T));
          node.actions.replaceChildren();
          const active = selection?.kind === 'draft';
          node.el.classList.toggle('is-active', active);
          node.el.setAttribute('aria-current', active ? 'true' : 'false');
          continue;
        }

        const service = state?.services.find((item) => item.entry.id === identity);
        if (!service) continue;
        node.name.textContent = service.entry.name;
        node.typeValue.textContent = typeLabel(service.entry.type);
        node.modelValue.textContent = modelSummary(service.entry) || T.none;
        paintPhase(node, servicePhase(T, service));
        const actionKey = `${service.entry.enabled}:${service.phase}`;
        if (actionKey !== node.actionKey) {
          node.actionKey = actionKey;
          node.actions.replaceChildren(...quickActions(service));
        }
        const active = selection?.kind === 'service' && selection.id === identity;
        node.el.classList.toggle('is-active', active);
        node.el.setAttribute('aria-current', active ? 'true' : 'false');
      }
    }

    function renderList(): void {
      cards.clear();
      list.replaceChildren();
      if (!state && !draft) {
        list.append(ui.placeholder(T.loading));
        return;
      }
      if (draft) {
        const node = buildCard(DRAFT_KEY, true);
        cards.set(DRAFT_KEY, node);
        list.append(node.el);
      }
      for (const service of state?.services ?? []) {
        const node = buildCard(service.entry.id, false);
        cards.set(service.entry.id, node);
        list.append(node.el);
      }
      if (!draft && (state?.services.length ?? 0) === 0) {
        list.append(ui.placeholder(T.noServices));
      }
    }

    function selectionChanged(): void {
      if (selectionKeyOf(selection) === renderedSelection) return;
      renderEditor();
    }

    function select(next: Selection): void {
      if (selectionKeyOf(selection) === selectionKeyOf(next)) return;
      selection = next;
      paintList();
      selectionChanged();
    }

    function openDraft(): void {
      if (!draft) draft = newDraft(T);
      selection = { kind: 'draft' };
      renderList();
      renderEditor();
      paintList();
    }

    function discardDraft(): void {
      const wasSelected = selection?.kind === 'draft';
      draft = null;
      if (wasSelected) selection = null;
      renderList();
      if (wasSelected) renderEditor();
      paintList();
    }

    // ---- 编辑器 ----

    function renderEditor(): void {
      paintStatus = null;
      paintDraftStatus = null;
      editor.replaceChildren();
      if (!state && !draft) {
        editor.append(ui.placeholder(T.loading));
        renderedSelection = '';
        return;
      }
      if (!selection) {
        editor.append(ui.placeholder(T.noServiceSelected));
        renderedSelection = '';
        return;
      }
      if (selection.kind === 'draft') {
        if (!draft) {
          selection = null;
          renderEditor();
          return;
        }
        renderDraftEditor(draft);
      } else {
        const id = selection.id;
        const service = state?.services.find((item) => item.entry.id === id);
        if (!service) {
          selection = null;
          renderEditor();
          return;
        }
        renderServiceEditor(service);
      }
      renderedSelection = selectionKeyOf(selection);
    }

    function renderDraftEditor(current: DraftState): void {
      const statusHost = ui.h('div', 'svc-status');
      editor.append(statusHost);

      const paint = (): void => {
        statusHost.replaceChildren(ui.kv([
          { k: T.rowStatus, v: phasePill(ui, draftPhase(T)) },
          { k: T.rowDetail, v: mono(T.draftDetail) },
          { k: T.rowAddress, v: mono(current.endpoint.trim() || T.none) },
          { k: T.rowModels, v: mono(modelSummaryOf(
            current.type,
            current.models.split(/[\s,]+/),
            current.modelDir,
          ) || T.none) },
          { k: T.rowPid, v: mono(T.none) },
          { k: T.rowRestarts, v: mono(T.none) },
          { k: T.rowToken, v: tokenCell(false, undefined) },
        ]));
      };
      paintDraftStatus = paint;
      paint();

      const dirtyEl = ui.h('span', 'svc-dirty', T.unsaved);
      const saveMsg = ui.msgline();
      saveMsg.hidden = true;
      const showSaveError = (text: string): void => {
        saveMsg.hidden = false;
        saveMsg.textContent = text;
        saveMsg.classList.add('bad');
      };
      const form = buildServiceForm(ui, ctx, T, current, {
        mode: 'draft',
        runtime: {
          backend: current.backend,
          device: current.device,
          threads: current.threads,
          idleUnloadMs: current.idleUnloadMs,
          ui: current.ui,
          modelsDir: current.modelsDir,
          cacheDir: current.cacheDir,
          contextSize: current.contextSize,
          nGpuLayers: current.nGpuLayers,
          parallel: current.parallel,
          modelDir: current.modelDir,
          llamacppService: current.llamacppService,
          llamacppUrl: current.llamacppUrl,
          thinkMode: current.thinkMode,
          gate: current.gate,
          instant: current.instant,
        },
        services: state?.services ?? [],
        onDirty: () => { dirtyEl.hidden = false; },
        onChange: (next) => {
          Object.assign(current, next.seed, next.runtime);
          paint();
          paintList();
        },
      });

      const saveButton = ui.button(T.save, {
        variant: 'primary',
        onClick: () => void (async () => {
          const result = form.read();
          if ('error' in result) {
            showSaveError(result.error);
            return;
          }
          saveButton.disabled = true;
          try {
            const created = await ctx.invoke<PanelServiceEntry>('add', [result.value]);
            if (ctx.signal.aborted) return;
            draft = null;
            pendingSelect = created.id;
            selection = { kind: 'service', id: created.id };
            ui.toast(T.saved, 'ok');
            clearMsg();
            await refresh(true);
          } catch (err) {
            if (ctx.signal.aborted) return;
            showSaveError(errText(err));
            saveButton.disabled = false;
          }
        })(),
      });

      const actions = ui.actions();
      actions.append(dirtyEl, ui.h('span', 'grow'), saveButton);
      editor.append(form.el, saveMsg, actions);
    }

    function editorActions(current: PanelService): HTMLElement[] {
      const order = state?.services.map((item) => item.entry.id) ?? [];
      const index = order.indexOf(current.entry.id);
      const id = current.entry.id;
      const buttons: HTMLElement[] = [];
      if (current.entry.enabled && current.phase !== 'online' && current.phase !== 'starting') {
        buttons.push(ui.button(T.start, { size: 'sm', onClick: () => void act('start', [id]) }));
      }
      if (current.phase === 'online' || current.phase === 'starting') {
        buttons.push(ui.button(T.stop, { size: 'sm', onClick: () => void act('stop', [id]) }));
      }
      if (current.entry.enabled) {
        buttons.push(ui.button(T.restart, { size: 'sm', onClick: () => void act('restart', [id]) }));
      }
      buttons.push(ui.button(T.probe, { size: 'sm', onClick: () => void act('probe', [id]) }));
      buttons.push(ui.button(T.logs, {
        size: 'sm',
        onClick: () => void openLogs(id, current.entry.name),
      }));
      if (index > 0) {
        const up = ui.button('↑', { size: 'sm', onClick: () => void moveService(id, -1) });
        up.title = T.moveUp;
        buttons.push(up);
      }
      if (index >= 0 && index < order.length - 1) {
        const down = ui.button('↓', { size: 'sm', onClick: () => void moveService(id, 1) });
        down.title = T.moveDown;
        buttons.push(down);
      }
      return buttons;
    }

    function renderServiceEditor(service: PanelService): void {
      const id = service.entry.id;
      const statusHost = ui.h('div', 'svc-status');
      const actionsHost = ui.h('div', 'svc-actions');
      editor.append(statusHost, actionsHost);

      let actionKey = '';
      const paint = (): void => {
        const current = state?.services.find((item) => item.entry.id === id);
        if (!current) return;
        statusHost.replaceChildren(ui.kv([
          { k: T.rowStatus, v: phasePill(ui, servicePhase(T, current)) },
          { k: T.rowDetail, v: mono(current.detail || T.none) },
          { k: T.rowAddress, v: mono(current.baseUrl || T.none) },
          { k: T.rowModels, v: mono(String(current.models)) },
          { k: T.rowPid, v: mono(current.pid === null ? T.none : String(current.pid)) },
          { k: T.rowRestarts, v: mono(String(current.restarts)) },
          { k: T.rowToken, v: tokenCell(current.entry.tokenSet, current.entry.secretName) },
        ]));
        const order = state?.services.map((item) => item.entry.id).join(',') ?? '';
        const nextKey = `${current.entry.enabled}:${current.phase}:${order}`;
        if (nextKey !== actionKey) {
          actionKey = nextKey;
          actionsHost.replaceChildren(...editorActions(current));
        }
      };
      paintStatus = paint;
      paint();

      const dirtyEl = ui.h('span', 'svc-dirty', T.unsaved);
      dirtyEl.hidden = true;
      const saveMsg = ui.msgline();
      saveMsg.hidden = true;
      const showSaveError = (text: string): void => {
        saveMsg.hidden = false;
        saveMsg.textContent = text;
        saveMsg.classList.add('bad');
      };
      const form = buildServiceForm(ui, ctx, T, seedOfEntry(service.entry), {
        mode: 'edit',
        services: state?.services ?? [],
        onDirty: () => { dirtyEl.hidden = false; },
        onTest: async () => {
          const next = await ctx.invoke<PanelState>('probe', [id]);
          if (!ctx.signal.aborted) {
            state = next;
            paintList();
            paintStatus?.();
          }
          const current = next.services.find((item) => item.entry.id === id);
          return current?.phase === 'online'
            ? { ok: true, text: `${T.testOk} · ${current.detail || T.none}` }
            : { ok: false, text: `${T.testFailed}: ${current?.detail ?? T.none}` };
        },
      });

      const saveButton = ui.button(T.save, {
        variant: 'primary',
        onClick: () => void (async () => {
          const result = form.read();
          if ('error' in result) {
            showSaveError(result.error);
            return;
          }
          saveButton.disabled = true;
          try {
            await ctx.invoke('update', [id, result.value]);
            if (ctx.signal.aborted) return;
            ui.toast(T.saved, 'ok');
            clearMsg();
            await refresh(true);
          } catch (err) {
            if (ctx.signal.aborted) return;
            showSaveError(errText(err));
            saveButton.disabled = false;
          }
        })(),
      });

      const actions = ui.actions();
      actions.append(dirtyEl, ui.h('span', 'grow'), saveButton);
      editor.append(form.el, saveMsg, actions);
    }

    // ---- 数据与动作 ----

    async function refresh(force = false): Promise<void> {
      if (refreshing) {
        if (force || pendingSelect) refreshAgain = true;
        return;
      }
      refreshing = true;
      try {
        const next = await ctx.invoke<PanelState>('state');
        if (ctx.signal.aborted) return;
        state = next;
        if (refreshFailed) {
          refreshFailed = false;
          clearMsg();
        }
        if (!initialized) {
          initialized = true;
          if (!selection && next.services[0]) {
            selection = { kind: 'service', id: next.services[0].entry.id };
          }
          force = true;
        }
        if (pendingSelect) {
          force = true;
          if (next.services.some((item) => item.entry.id === pendingSelect)) {
            selection = { kind: 'service', id: pendingSelect };
            pendingSelect = null;
          }
        }
        const current = selection;
        if (current?.kind === 'service' && !next.services.some((item) => item.entry.id === current.id)) {
          selection = null;
          force = true;
        }
        const key = next.services.map((item) => `${item.entry.id}\u0000${item.entry.name}`).join('\u0001');
        if (force || key !== listKey) {
          listKey = key;
          renderList();
        }
        if (force || selectionKeyOf(selection) !== renderedSelection) renderEditor();
        paintList();
        paintStatus?.();
      } catch (err) {
        if (!ctx.signal.aborted) {
          refreshFailed = true;
          fail(err);
        }
      } finally {
        refreshing = false;
        if (refreshAgain) {
          refreshAgain = false;
          void refresh(true);
        }
      }
    }

    async function act(method: string, args: unknown[]): Promise<void> {
      try {
        await ctx.invoke(method, args);
        if (ctx.signal.aborted) return;
        clearMsg();
        await refresh();
      } catch (err) {
        if (!ctx.signal.aborted) fail(err);
      }
    }

    async function openLogs(id: string, name: string): Promise<void> {
      try {
        const result = await ctx.invoke<PanelLogs>('logs', [id, 200]);
        if (ctx.signal.aborted) return;
        ui.drawer(T.logsTitle(name), result.text || T.logsEmpty);
      } catch (err) {
        if (!ctx.signal.aborted) fail(err);
      }
    }

    async function moveService(id: string, delta: number): Promise<void> {
      if (!state) return;
      const ids = state.services.map((item) => item.entry.id);
      const index = ids.indexOf(id);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= ids.length) return;
      const next = [...ids];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item!);
      try {
        await ctx.invoke('reorder', [next]);
        if (ctx.signal.aborted) return;
        clearMsg();
        await refresh();
      } catch (err) {
        if (!ctx.signal.aborted) fail(err);
      }
    }

    async function removeService(id: string, name: string): Promise<void> {
      const confirmed = await ui.confirm({
        title: T.deleteTitle(name),
        body: T.deleteBody,
        danger: true,
      });
      if (!confirmed || ctx.signal.aborted) return;
      try {
        await ctx.invoke('remove', [id]);
        if (ctx.signal.aborted) return;
        if (selection?.kind === 'service' && selection.id === id) selection = null;
        ui.toast(T.deleted, 'ok');
        clearMsg();
        await refresh(true);
      } catch (err) {
        if (ctx.signal.aborted) return;
        fail(err);
      }
    }

    void refresh(true);
    ctx.interval(() => void refresh(), POLL_MS);
  },
};

const gatewayPanel: WebUiPanel = {
  mount(ctx: WebUiPanelContext): void {
    const { ui } = ctx;
    const T = panelText(ctx.language);

    const root = ui.h('div', 'svc-panel svc-gateway');
    const msg = ui.msgline();
    msg.hidden = true;
    const statusHost = ui.h('div', 'svc-status');
    const notes = ui.h('div', 'svc-notes');
    const formHost = ui.h('div', 'svc-formwrap');
    root.append(msg, statusHost, notes, formHost);
    ctx.root.append(root);

    let state: PanelState | null = null;
    let initialized = false;
    let refreshFailed = false;
    let refreshing = false;
    let refreshAgain = false;

    const mono = (text: string): HTMLElement => ui.h('span', 'svc-mono', text);

    const tokenCell = (set: boolean, name: string | undefined): HTMLElement => {
      const row = ui.h('span', 'svc-chiprow');
      row.append(
        ui.pill(set ? T.tokenSetState : T.tokenUnset, set ? 'on' : 'off'),
        ui.h('span', 'svc-mono', name || T.none),
      );
      return row;
    };

    function fail(err: unknown): void {
      msg.hidden = false;
      msg.textContent = `${T.failed}: ${errText(err)}`;
      msg.classList.add('bad');
    }

    function info(text: string): void {
      msg.hidden = false;
      msg.textContent = text;
      msg.classList.remove('bad');
    }

    function clearMsg(): void {
      msg.hidden = true;
      msg.textContent = '';
      msg.classList.remove('bad');
    }

    function paintStatus(): void {
      if (!state) return;
      const gw = state.gateway;
      statusHost.replaceChildren(ui.kv([
        { k: T.rowStatus, v: phasePill(ui, gatewayPhase(T, gw)) },
        { k: T.rowReady, v: ui.pill(gw.ready ? T.yes : T.no, gw.ready ? 'on' : 'off') },
        { k: T.rowAddress, v: mono(gw.baseUrl) },
        { k: T.rowVersion, v: mono(gw.version) },
        { k: T.rowUptime, v: mono(ui.fmt.duration(gw.uptimeSec * 1000)) },
        { k: T.rowServices, v: mono(`${gw.online}/${gw.total}`) },
        { k: T.rowModels, v: mono(String(gw.models)) },
        { k: T.rowToken, v: tokenCell(gw.tokenSet, gw.secretName) },
      ]));
      notes.replaceChildren(...(gw.restartRequired
        ? [ui.h('div', 'svc-note', T.restartNeeded)]
        : []));
    }

    function buildForm(gw: PanelGateway): void {
      const enabled = ui.checkbox(T.flagEnabled, { checked: gw.enabled });
      const port = ui.input({ type: 'number', value: String(gw.port) });
      port.min = '1';
      port.max = '65535';
      port.step = '1';
      const secretName = ui.input({ value: gw.secretName, cls: 'mono', placeholder: 'SERVICE_TOKEN' });
      const tokenValue = ui.input({
        type: 'password',
        placeholder: gw.tokenSet ? '••••••••' : T.tokenUnset,
      });
      const tokenRow = ui.h('div', 'svc-token-row');
      tokenRow.append(
        tokenValue,
        ui.button(T.tokenSet, {
          size: 'sm',
          variant: 'primary',
          onClick: () => void setGatewayToken(secretName.value, tokenValue),
        }),
        ui.button(T.tokenClear, {
          size: 'sm',
          variant: 'danger',
          onClick: () => void clearGatewayToken(secretName.value),
        }),
      );
      const queryToken = ui.checkbox(T.flagAllowQueryToken, { checked: gw.allowQueryToken });
      const timeout = ui.input({ type: 'number', value: String(gw.requestTimeoutSec) });
      timeout.min = '5';
      timeout.max = '3600';
      timeout.step = '1';
      const defaultModel = ui.input({ value: gw.defaultSpeechModel, cls: 'mono' });

      const flow = ui.h('div', 'connection-flow');

      const basic = numberedSection(ui, flow, 'gateway-basic', T.sectionBasic, true);
      basic.body.append(
        checkBlock(ui, enabled, T.enabledNote),
        fieldBlock(ui, T.fieldPort, port, T.portNote),
      );

      const token = numberedSection(ui, flow, 'gateway-token', T.sectionToken, false);
      token.body.append(
        fieldBlock(ui, T.fieldTokenName, secretName, T.tokenNameNote),
        fieldBlock(ui, T.fieldTokenValue, tokenRow, T.tokenValueNote),
        checkBlock(ui, queryToken, T.allowQueryTokenNote),
      );

      const request = numberedSection(ui, flow, 'gateway-request', T.sectionRequest, false);
      request.body.append(
        fieldBlock(ui, T.fieldTimeout, timeout, T.timeoutNote),
        fieldBlock(ui, T.fieldDefaultModel, defaultModel, T.defaultModelNote),
      );

      const dirtyEl = ui.h('span', 'svc-dirty', T.unsaved);
      dirtyEl.hidden = true;
      flow.addEventListener('input', () => { dirtyEl.hidden = false; }, { signal: ctx.signal });
      flow.addEventListener('change', () => { dirtyEl.hidden = false; }, { signal: ctx.signal });

      const saveMsg = ui.msgline();
      saveMsg.hidden = true;
      const showSaveError = (text: string): void => {
        saveMsg.hidden = false;
        saveMsg.textContent = text;
        saveMsg.classList.add('bad');
      };

      const saveButton = ui.button(T.save, { variant: 'primary', onClick: () => void save() });
      const actions = ui.actions();
      actions.append(dirtyEl, ui.h('span', 'grow'), saveButton);

      formHost.replaceChildren(flow, saveMsg, actions);

      async function save(): Promise<void> {
        const portValue = Number(port.value);
        if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
          showSaveError(T.badPort);
          return;
        }
        const timeoutValue = Number(timeout.value);
        if (!Number.isInteger(timeoutValue) || timeoutValue < 5 || timeoutValue > 3600) {
          showSaveError(T.badTimeout);
          return;
        }
        saveButton.disabled = true;
        try {
          await ctx.invoke('saveGateway', [{
            enabled: enabled.checked,
            port: portValue,
            tokenSecret: secretName.value.trim(),
            allowQueryToken: queryToken.checked,
            requestTimeoutSec: timeoutValue,
            defaultSpeechModel: defaultModel.value.trim(),
          }]);
          if (ctx.signal.aborted) return;
          ui.toast(T.saved, 'ok');
          clearMsg();
          await refresh(true);
        } catch (err) {
          if (ctx.signal.aborted) return;
          showSaveError(errText(err));
          saveButton.disabled = false;
        }
      }
    }

    async function setGatewayToken(nameRaw: string, valueInput: HTMLInputElement): Promise<void> {
      const name = nameRaw.trim();
      if (!name) {
        fail(T.badTokenName);
        return;
      }
      const value = valueInput.value.trim();
      if (!value) {
        fail(T.badToken);
        return;
      }
      try {
        // 变量名和当前值不同时先落盘;setToken 只接受已配置的变量名。
        if (state && name !== state.gateway.secretName) {
          await ctx.invoke('saveGateway', [{ tokenSecret: name }]);
        }
        const result = await ctx.invoke<PanelTokenResult>('setToken', [name, value]);
        if (ctx.signal.aborted) return;
        valueInput.value = '';
        ui.toast(result.tokenSet ? T.tokenSaved : T.tokenUnset, result.tokenSet ? 'ok' : 'bad');
        info(T.tokenRestart);
        await refresh(true);
      } catch (err) {
        if (!ctx.signal.aborted) fail(err);
      }
    }

    async function clearGatewayToken(nameRaw: string): Promise<void> {
      const name = nameRaw.trim() || state?.gateway.secretName || '';
      if (!name) {
        fail(T.badTokenName);
        return;
      }
      try {
        await ctx.invoke<PanelTokenResult>('setToken', [name, '']);
        if (ctx.signal.aborted) return;
        ui.toast(T.tokenCleared, 'ok');
        info(T.tokenRestart);
        await refresh(true);
      } catch (err) {
        if (!ctx.signal.aborted) fail(err);
      }
    }

    async function refresh(force = false): Promise<void> {
      if (refreshing) {
        if (force) refreshAgain = true;
        return;
      }
      refreshing = true;
      try {
        const next = await ctx.invoke<PanelState>('state');
        if (ctx.signal.aborted) return;
        state = next;
        if (refreshFailed) {
          refreshFailed = false;
          clearMsg();
        }
        const first = !initialized;
        initialized = true;
        paintStatus();
        if (first || force) buildForm(next.gateway);
      } catch (err) {
        if (!ctx.signal.aborted) {
          refreshFailed = true;
          fail(err);
        }
      } finally {
        refreshing = false;
        if (refreshAgain) {
          refreshAgain = false;
          void refresh(true);
        }
      }
    }

    void refresh(true);
    ctx.interval(() => void refresh(), POLL_MS);
  },
};

const bundle: WebUiClientBundle = {
  panels: { services: servicesPanel, gateway: gatewayPanel },
};

export default bundle;
