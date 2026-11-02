/**
 * 「服务」面板:一个系统页签里的两个视图。
 *
 * 顶部用分段标签切「服务」与「网关」。服务视图是主从布局:左侧列表,右侧编辑器;
 * 编辑器的字段按「基本 / 运行 / 进程 / 高级」折叠分组。状态每 4 秒刷新,只重画状态灯、
 * 阶段药丸、状态块与动作行;表单只在选中项变化、服务集合变化或保存后重建。
 * 数据面只走 `ctx.invoke`;DOM 只走 `ctx.ui` 原语。
 */
import type {
  WebUiCheckbox, WebUiClientBundle, WebUiPanel, WebUiPanelContext,
} from 'cortico/web/shared/client-panel.ts';
import {
  SERVICE_TYPES,
  type PanelLogs, type PanelService, type PanelServiceEntry, type PanelState,
  type PanelTokenResult,
} from '../src/panel.ts';
import type { ServiceEntry, ServiceType } from '../src/types.ts';
import { panelText, type PanelText } from './strings.ts';
import './style.css';

type View = 'services' | 'gateway';

/** 类型切换且地址为空时的默认地址;其余类型没有可猜的端口。 */
const DEFAULT_ENDPOINTS: Partial<Record<ServiceType, string>> = {
  audiocpp: 'http://127.0.0.1:8080',
  sing: 'http://127.0.0.1:9882',
};

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

type Tone = 'on' | 'off' | 'plain';

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

function gatewayPhase(T: PanelText, gw: PanelState['gateway']): PhaseView {
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
    case 'openai': return T.typeOpenai;
    case 'sing': return T.typeSing;
    case 'llamacpp': return T.typeLlamacpp;
    case 'systemone': return T.typeSystemone;
    case 'svc': return T.typeSvc;
    case 'custom': return T.typeCustom;
  }
}

type ServicePayload = Record<string, unknown>;
type FormRead = { value: ServicePayload } | { error: string };

interface ServiceForm {
  el: HTMLElement;
  read(): FormRead;
}

interface ListRow {
  row: HTMLButtonElement;
  lamp: HTMLSpanElement;
  pill: HTMLSpanElement;
}

const servicesPanel: WebUiPanel = {
  mount(ctx: WebUiPanelContext): void {
    const { ui } = ctx;
    const T = panelText(ctx.language);

    const root = ui.h('div', 'svc-panel');
    const tabbar = ui.h('div', 'svc-tabbar');
    const tabs = ui.segmented([
      { value: 'services', label: T.tabServices },
      { value: 'gateway', label: T.tabGateway },
    ], {
      value: 'services',
      onSelect: (value) => {
        const next: View = value === 'gateway' ? 'gateway' : 'services';
        if (next === view) return;
        view = next;
        renderView();
      },
    });
    tabs.el.classList.add('svc-tabs');
    tabbar.append(tabs.el);

    const msg = ui.msgline();
    msg.hidden = true;
    const viewHost = ui.h('div', 'svc-view');
    viewHost.append(ui.placeholder(T.loading));
    root.append(tabbar, msg, viewHost);
    ctx.root.append(root);

    let state: PanelState | null = null;
    let view: View = 'services';
    let selectedId: string | null = null;
    let listKey = '';
    let detailKey = '';
    let paintList: (() => void) | null = null;
    let paintStatus: (() => void) | null = null;
    let refreshFailed = false;

    const mono = (text: string): HTMLElement => ui.h('span', 'svc-mono', text);

    const tokenCell = (set: boolean, name: string | undefined): HTMLElement => {
      const row = ui.h('span', 'svc-chiprow');
      row.append(
        ui.pill(set ? T.tokenSetState : T.tokenUnset, set ? 'on' : 'off'),
        ui.h('span', 'svc-mono', name || T.none),
      );
      return row;
    };

    function setPhasePill(pill: HTMLSpanElement, phase: PhaseView, small = false): void {
      pill.className = `pill${phase.tone === 'on' ? ' on' : phase.tone === 'off' ? ' off' : ''}`
        + `${phase.bad ? ' svc-bad' : ''}${small ? ' svc-phase' : ''}`;
      pill.textContent = phase.text;
    }

    const phasePill = (phase: PhaseView, small = false): HTMLSpanElement => {
      const pill = ui.pill(phase.text, phase.tone);
      if (phase.bad) pill.classList.add('svc-bad');
      if (small) pill.classList.add('svc-phase');
      return pill;
    };

    const lampClass = (phase: PhaseView): string =>
      `svc-lamp ${phase.bad ? 'bad' : phase.tone}`;

    /** 一格控件 + 下方一句说明。 */
    const block = (
      label: string,
      control: HTMLElement,
      note: string | HTMLElement,
      wide = false,
    ): HTMLElement => {
      const box = ui.h('div', wide ? 'svc-field svc-wide' : 'svc-field');
      box.append(ui.field(label, control), typeof note === 'string' ? ui.h('div', 'svc-note', note) : note);
      return box;
    };

    const checkBlock = (box: WebUiCheckbox, note: string): HTMLElement => {
      const wrap = ui.h('div', 'svc-field');
      wrap.append(box.el, ui.h('div', 'svc-note', note));
      return wrap;
    };

    const pathRow = (input: HTMLInputElement, kind: 'file' | 'directory'): HTMLElement => {
      const row = ui.h('div', 'svc-path');
      row.append(input, ui.button(T.choose, {
        size: 'sm',
        onClick: () => {
          void ctx.pickPath({ kind, currentPath: input.value }).then((chosen) => {
            if (chosen) input.value = chosen;
          });
        },
      }));
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

    // -----------------------------------------------------------------------

    function detailKeyOf(): string {
      return view === 'gateway' ? 'gateway' : `service:${selectedId ?? ''}`;
    }

    async function refresh(rebuild = false): Promise<void> {
      try {
        const next = await ctx.invoke<PanelState>('state');
        if (ctx.signal.aborted) return;
        state = next;
        if (refreshFailed) {
          refreshFailed = false;
          clearMsg();
        }
        if (selectedId !== null && !state.services.some((item) => item.entry.id === selectedId)) {
          selectedId = null;
        }
        const key = state.services
          .map((item) => `${item.entry.id}\u0000${item.entry.name}`)
          .join('\u0001');
        const setChanged = key !== listKey;
        listKey = key;
        if (rebuild || setChanged || detailKey !== detailKeyOf()) renderView();
        else paintLive();
      } catch (err) {
        if (!ctx.signal.aborted) {
          refreshFailed = true;
          fail(err);
        }
      }
    }

    /** 轮询时只重画灯、药丸与状态;表单节点原样留着。 */
    function paintLive(): void {
      if (paintList) paintList();
      if (paintStatus) paintStatus();
    }

    function renderView(): void {
      paintList = null;
      paintStatus = null;
      detailKey = detailKeyOf();
      viewHost.replaceChildren();
      if (!state) {
        viewHost.append(ui.placeholder(T.loading));
        return;
      }
      if (view === 'gateway') renderGateway(viewHost);
      else renderServices(viewHost);
      paintLive();
    }

    // ---- 服务视图 ----

    function renderServices(host: HTMLElement): void {
      const layout = ui.h('div', 'svc-workbench');
      const side = ui.h('aside', 'svc-side');
      const addButton = ui.button(T.add, {
        variant: 'primary',
        onClick: () => openAdd(),
      });
      const list = ui.h('div', 'svc-list');
      side.append(addButton, list);
      const editor = ui.h('div', 'svc-editor');
      layout.append(side, editor);
      host.append(layout);

      renderServiceList(list);
      renderServiceEditor(editor);
    }

    function renderServiceList(list: HTMLElement): void {
      const rows = new Map<string, ListRow>();
      const services = state?.services ?? [];
      if (services.length === 0) {
        list.append(ui.placeholder(T.noServices));
        return;
      }
      for (const service of services) {
        const row = ui.h('button', 'svc-row');
        row.type = 'button';
        const lamp = ui.h('span', 'svc-lamp');
        const name = ui.h('span', 'svc-name', service.entry.name);
        const pill = phasePill(servicePhase(T, service), true);
        row.append(lamp, name, pill);
        row.addEventListener('click', () => selectService(service.entry.id), { signal: ctx.signal });
        rows.set(service.entry.id, { row, lamp, pill });
        list.append(row);
      }

      paintList = (): void => {
        if (!state) return;
        for (const service of state.services) {
          const parts = rows.get(service.entry.id);
          if (!parts) continue;
          const phase = servicePhase(T, service);
          parts.lamp.className = lampClass(phase);
          setPhasePill(parts.pill, phase, true);
          const active = service.entry.id === selectedId;
          parts.row.classList.toggle('active', active);
          if (active) parts.row.setAttribute('aria-current', 'true');
          else parts.row.removeAttribute('aria-current');
        }
      };
    }

    function selectService(id: string): void {
      if (selectedId === id) return;
      selectedId = id;
      renderView();
    }

    function renderNoSelection(editor: HTMLElement): void {
      const empty = ui.h('div', 'svc-empty');
      empty.append(
        ui.placeholder(T.noServiceSelected),
        ui.button(T.add, {
          variant: 'primary',
          onClick: () => openAdd(),
        }),
      );
      editor.append(empty);
    }

    function renderServiceEditor(editor: HTMLElement): void {
      const service = selectedId === null
        ? undefined
        : state?.services.find((item) => item.entry.id === selectedId);
      if (!service) {
        renderNoSelection(editor);
        return;
      }

      const id = service.entry.id;
      const statusHost = ui.h('div', 'svc-status');
      const actionsHost = ui.h('div', 'svc-actions');
      editor.append(statusHost, actionsHost);

      const paint = (): void => {
        if (!state) return;
        const current = state.services.find((item) => item.entry.id === id);
        if (!current) return;
        statusHost.replaceChildren(ui.kv([
          { k: T.rowStatus, v: phasePill(servicePhase(T, current)) },
          { k: T.rowDetail, v: mono(current.detail || T.none) },
          { k: T.rowAddress, v: mono(current.baseUrl || T.none) },
          { k: T.rowModels, v: mono(String(current.models)) },
          { k: T.rowPid, v: mono(current.pid === null ? T.none : String(current.pid)) },
          { k: T.rowRestarts, v: mono(String(current.restarts)) },
          { k: T.rowToken, v: tokenCell(current.entry.tokenSet, current.entry.secretName) },
        ]));

        const order = state.services.map((item) => item.entry.id);
        const index = order.indexOf(id);
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
        buttons.push(ui.button(T.delete, {
          variant: 'danger',
          size: 'sm',
          onClick: () => void removeService(id, current.entry.name),
        }));
        actionsHost.replaceChildren(...buttons);
      };
      paintStatus = paint;
      paint();

      const form = buildServiceForm(service.entry, true, 'edit');
      const saveRow = ui.actions();
      saveRow.append(ui.h('span', 'grow'), ui.button(T.save, {
        variant: 'primary',
        onClick: () => void (async () => {
          const result = form.read();
          if ('error' in result) {
            fail(result.error);
            return;
          }
          try {
            await ctx.invoke('update', [id, result.value]);
            if (ctx.signal.aborted) return;
            ui.toast(T.saved, 'ok');
            clearMsg();
            await refresh(true);
          } catch (err) {
            if (!ctx.signal.aborted) fail(err);
          }
        })(),
      }));

      editor.append(form.el, saveRow);
    }

    // ---- 网关视图 ----

    function renderGateway(host: HTMLElement): void {
      const statusHost = ui.h('div', 'svc-status');
      const notes = ui.h('div', 'svc-notes');
      host.append(statusHost, notes);

      const paint = (): void => {
        if (!state) return;
        const gw = state.gateway;
        statusHost.replaceChildren(ui.kv([
          { k: T.rowStatus, v: phasePill(gatewayPhase(T, gw)) },
          { k: T.rowReady, v: ui.pill(gw.ready ? T.yes : T.no, gw.ready ? 'on' : 'off') },
          { k: T.rowAddress, v: mono(gw.baseUrl) },
          { k: T.rowVersion, v: mono(gw.version) },
          { k: T.rowUptime, v: mono(ui.fmt.duration(gw.uptimeSec * 1000)) },
          { k: T.rowServices, v: mono(`${gw.online}/${gw.total}`) },
          { k: T.rowModels, v: mono(String(gw.models)) },
          { k: T.rowToken, v: tokenCell(gw.tokenSet, gw.secretName) },
        ]));
        notes.replaceChildren(...(gw.restartRequired ? [ui.h('div', 'svc-note', T.restartNeeded)] : []));
      };
      paintStatus = paint;
      paint();

      const gw = state!.gateway;
      const enabled = ui.checkbox(T.flagEnabled, { checked: gw.enabled });
      const port = ui.input({ type: 'number', value: String(gw.port) });
      port.min = '1';
      port.max = '65535';
      port.step = '1';
      const secretName = ui.input({ value: gw.secretName, cls: 'mono', placeholder: 'SERVICE_TOKEN' });
      const tokenValue = ui.input({ type: 'password', placeholder: gw.tokenSet ? '••••••••' : T.tokenUnset });
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

      const basic = ui.foldSheet('gateway-basic', {
        title: T.sectionBasic,
        defaultOpen: true,
      });
      const basicGrid = ui.h('div', 'svc-form');
      basicGrid.append(
        checkBlock(enabled, T.enabledNote),
        block(T.fieldPort, port, T.portNote),
      );
      basic.body.append(basicGrid);

      const token = ui.foldSheet('gateway-token', {
        title: T.sectionToken,
        defaultOpen: false,
      });
      const tokenGrid = ui.h('div', 'svc-form');
      tokenGrid.append(
        block(T.fieldTokenName, secretName, T.tokenNameNote),
        block(T.fieldTokenValue, tokenRow, T.tokenValueNote, true),
        checkBlock(queryToken, T.allowQueryTokenNote),
      );
      token.body.append(tokenGrid);

      const request = ui.foldSheet('gateway-request', {
        title: T.sectionRequest,
        defaultOpen: false,
      });
      const requestGrid = ui.h('div', 'svc-form');
      requestGrid.append(
        block(T.fieldTimeout, timeout, T.timeoutNote),
        block(T.fieldDefaultModel, defaultModel, T.defaultModelNote),
      );
      request.body.append(requestGrid);

      const formWrap = ui.h('div', 'svc-formwrap');
      formWrap.append(basic.el, token.el, request.el);

      async function save(): Promise<void> {
        const portValue = Number(port.value);
        if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
          fail(T.badPort);
          return;
        }
        const timeoutValue = Number(timeout.value);
        if (!Number.isInteger(timeoutValue) || timeoutValue < 5 || timeoutValue > 3600) {
          fail(T.badTimeout);
          return;
        }
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
          if (!ctx.signal.aborted) fail(err);
        }
      }

      const actions = ui.actions();
      actions.append(ui.h('span', 'grow'), ui.button(T.save, {
        variant: 'primary',
        onClick: () => void save(),
      }));

      host.append(formWrap, actions);
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
        // 变量名和面板生效值不同时先落盘;setToken 只接受已配置的变量名。
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

    // ---- 服务表单 ----

    /**
     * 服务表单。`withProcess` 为 false 时只给新增用的最小集合:
     * 名称、类型、地址、四个开关与高级字段;进程字段加完服务再到详情里填。
     */
    function buildServiceForm(
      initial: ServiceEntry | null,
      withProcess: boolean,
      mode: 'add' | 'edit',
    ): ServiceForm {
      const prefix = mode === 'add' ? 'service-add' : `service-edit-${initial?.id ?? 'new'}`;

      const name = ui.input({ value: initial?.name ?? '' });
      const type = ui.select({ value: initial?.type ?? 'custom', options: SERVICE_TYPES });
      const typeNoteEl = ui.h('div', 'svc-note', typeNote(T, type.value as ServiceType));
      type.addEventListener('change', () => {
        const value = type.value as ServiceType;
        typeNoteEl.textContent = typeNote(T, value);
        const fallback = DEFAULT_ENDPOINTS[value];
        if (fallback && !endpoint.value.trim()) endpoint.value = fallback;
      }, { signal: ctx.signal });
      const endpoint = ui.input({
        value: initial?.endpoint ?? '',
        cls: 'mono',
        placeholder: 'http://127.0.0.1:8080',
      });

      const enabled = ui.checkbox(T.flagEnabled, { checked: initial?.enabled ?? true });
      const manage = ui.checkbox(T.flagManage, { checked: initial?.manage ?? true });
      const autoStart = ui.checkbox(T.flagAutoStart, { checked: initial?.autoStart ?? true });
      const restartOnExit = ui.checkbox(T.flagRestartOnExit, { checked: initial?.restartOnExit ?? true });

      const basic = ui.foldSheet(`${prefix}-basic`, {
        title: T.sectionBasic,
        defaultOpen: true,
      });
      const basicGrid = ui.h('div', 'svc-form');
      basicGrid.append(
        block(T.fieldName, name, T.nameNote),
        block(T.fieldType, type, typeNoteEl),
        block(T.fieldEndpoint, endpoint, T.endpointNote, true),
      );
      basic.body.append(basicGrid);

      const runtime = ui.foldSheet(`${prefix}-runtime`, {
        title: T.sectionRuntime,
        defaultOpen: true,
      });
      const flags = ui.h('div', 'svc-flags');
      flags.append(
        checkBlock(enabled, T.serviceEnabledNote),
        checkBlock(manage, T.manageNote),
        checkBlock(autoStart, T.autoStartNote),
        checkBlock(restartOnExit, T.restartOnExitNote),
      );
      runtime.body.append(flags);

      const serverDir = ui.input({ value: initial?.serverDir ?? '' });
      const binary = ui.input({ value: initial?.binary ?? '' });
      const args = ui.input({ value: initial?.args ?? '', cls: 'mono' });
      const process = ui.foldSheet(`${prefix}-process`, {
        title: T.sectionProcess,
        defaultOpen: manage.checked,
      });
      const processGrid = ui.h('div', 'svc-form');
      processGrid.append(
        block(T.fieldServerDir, pathRow(serverDir, 'directory'), T.serverDirNote),
        block(T.fieldBinary, pathRow(binary, 'file'), T.binaryNote),
        block(T.fieldArgs, args, T.argsNote, true),
      );
      process.body.append(processGrid);

      const syncProcess = (): void => {
        process.el.hidden = !manage.checked;
        if (manage.checked) (process.el as HTMLDetailsElement).open = true;
      };
      manage.input.addEventListener('change', syncProcess, { signal: ctx.signal });
      syncProcess();

      const secretName = ui.input({
        value: initial?.secretName ?? '',
        cls: 'mono',
        placeholder: 'SERVICE_TOKEN',
      });
      const modelProfile = ui.input({ value: initial?.modelProfile ?? '', placeholder: 'auto' });
      const models = ui.input({ value: initial?.models?.join(', ') ?? '' });
      const options = ui.textarea({
        value: initial?.options && Object.keys(initial.options).length
          ? JSON.stringify(initial.options, null, 2)
          : '',
        rows: 5,
        cls: 'mono',
      });

      const advanced = ui.foldSheet(`${prefix}-advanced`, {
        title: T.advancedTitle,
        defaultOpen: false,
      });
      const advancedGrid = ui.h('div', 'svc-form');
      advancedGrid.append(
        block(T.fieldTokenName, secretName, T.secretNameNote),
        block(T.fieldModelProfile, modelProfile, T.modelProfileNote),
        block(T.fieldModels, models, T.modelsNote),
        block(T.fieldOptions, options, T.optionsNote, true),
      );
      advanced.body.append(advancedGrid);

      const el = ui.h('div', 'svc-formwrap');
      el.append(basic.el, runtime.el, ...(withProcess ? [process.el] : []), advanced.el);

      function read(): FormRead {
        const value = name.value.trim();
        if (!value) return { error: T.badName };
        const address = endpoint.value.trim();
        if (!address) return { error: T.badEndpoint };
        const optionsText = options.value.trim();
        let parsedOptions: Record<string, unknown> | null = null;
        if (optionsText) {
          try {
            const parsed: unknown = JSON.parse(optionsText);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object');
            parsedOptions = parsed as Record<string, unknown>;
          } catch {
            return { error: T.badOptions };
          }
        }
        const list = models.value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
        return {
          value: {
            name: value,
            type: type.value,
            endpoint: address,
            enabled: enabled.checked,
            manage: manage.checked,
            autoStart: autoStart.checked,
            restartOnExit: restartOnExit.checked,
            ...(withProcess ? {
              serverDir: serverDir.value.trim() || null,
              binary: binary.value.trim() || null,
              args: args.value.trim() || null,
            } : {}),
            secretName: secretName.value.trim() || null,
            modelProfile: modelProfile.value.trim() || null,
            models: list.length ? list : null,
            options: parsedOptions,
          },
        };
      }

      return { el, read };
    }

    async function act(method: string, args: unknown[], rebuild = false): Promise<void> {
      try {
        await ctx.invoke(method, args);
        if (ctx.signal.aborted) return;
        clearMsg();
        await refresh(rebuild);
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
      await act('reorder', [next], true);
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
        selectedId = null;
        ui.toast(T.deleted, 'ok');
        clearMsg();
        await refresh(true);
      } catch (err) {
        if (!ctx.signal.aborted) fail(err);
      }
    }

    // ---- 添加 ----

    function openAdd(): void {
      const body = ui.h('div', 'svc-add');
      const form = buildServiceForm(null, false, 'add');
      const report = ui.msgline();
      report.hidden = true;
      const actions = ui.actions();
      const submit = ui.button(T.add, {
        variant: 'primary',
        onClick: () => void save(),
      });
      actions.append(ui.h('span', 'grow'), ui.button(T.cancel, {
        onClick: () => drawer.dispose(),
      }), submit);
      body.append(form.el, report, actions);
      const drawer = ui.drawer(T.addTitle, body);

      async function save(): Promise<void> {
        const result = form.read();
        if ('error' in result) {
          report.hidden = false;
          report.textContent = result.error;
          report.classList.add('bad');
          return;
        }
        submit.disabled = true;
        try {
          const created = await ctx.invoke<PanelServiceEntry>('add', [result.value]);
          if (ctx.signal.aborted) return;
          ui.toast(T.saved, 'ok');
          drawer.dispose();
          selectedId = created.id;
          view = 'services';
          tabs.setValue('services');
          clearMsg();
          await refresh(true);
        } catch (err) {
          if (ctx.signal.aborted) return;
          report.hidden = false;
          report.textContent = errText(err);
          report.classList.add('bad');
          submit.disabled = false;
        }
      }
    }

    // -----------------------------------------------------------------------

    void refresh(true);
    ctx.interval(() => void refresh(), 4000);
  },
};

const bundle: WebUiClientBundle = {
  panels: { services: servicesPanel },
};

export default bundle;
