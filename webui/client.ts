/**
 * 「服务」面板:一个主从视图。
 *
 * 顶部选单只有「网关」与各服务名;下面是选中项的状态与表单。状态每 4 秒刷新,
 * 表单只在切换选中项或保存后重建,轮询不覆盖正在输入的内容。
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

const GATEWAY = 'gateway';

/** 类型切换且地址为空时的默认地址;其余类型没有可猜的端口。 */
const DEFAULT_ENDPOINTS: Partial<Record<ServiceType, string>> = {
  audiocpp: 'http://127.0.0.1:8000',
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

const servicesPanel: WebUiPanel = {
  mount(ctx: WebUiPanelContext): void {
    const { ui } = ctx;
    const T = panelText(ctx.language);

    // ---- 顶部:二级菜单 + 添加 ----
    const root = ui.h('div', 'svc-panel');
    const pickerRow = ui.rowbar();
    pickerRow.classList.add('svc-topbar');
    const picker = ui.select({
      value: GATEWAY,
      onChange: (value) => {
        selected = value || GATEWAY;
        renderDetail();
      },
    });
    picker.classList.add('svc-picker');
    picker.setAttribute('aria-label', T.pickerLabel);
    pickerRow.append(picker, ui.button(T.add, {
      variant: 'primary',
      size: 'sm',
      onClick: () => openAdd(),
    }));

    const msg = ui.msgline();
    msg.hidden = true;
    const detail = ui.h('div', 'svc-detail');
    detail.append(ui.placeholder(T.loading));
    root.append(pickerRow, msg, detail);
    ctx.root.append(root);

    let state: PanelState | null = null;
    let selected = GATEWAY;
    let pickerKey = '';
    let detailKey = '';
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

    const phasePill = (view: PhaseView): HTMLSpanElement => {
      const pill = ui.pill(view.text, view.tone);
      if (view.bad) pill.className = 'pill svc-bad';
      return pill;
    };

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

    function syncPicker(): void {
      if (!state) return;
      const key = state.services.map((item) => `${item.entry.id}\u0000${item.entry.name}`).join('\u0001');
      if (key !== pickerKey) {
        pickerKey = key;
        const options: Array<{ value: string; label: string }> = [
          { value: GATEWAY, label: T.gateway },
          ...state.services.map((item) => ({ value: item.entry.id, label: item.entry.name })),
        ];
        picker.replaceChildren(...options.map((option) => {
          const el = ui.h('option', null, option.label);
          el.value = option.value;
          return el;
        }));
      }
      picker.value = selected;
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
        if (selected !== GATEWAY && !state.services.some((item) => item.entry.id === selected)) {
          selected = GATEWAY;
          rebuild = true;
        }
        syncPicker();
        if (rebuild || detailKey !== selected) renderDetail();
        else paintStatus?.();
      } catch (err) {
        if (!ctx.signal.aborted) {
          refreshFailed = true;
          fail(err);
        }
      }
    }

    function renderDetail(): void {
      if (!state) return;
      paintStatus = null;
      detail.replaceChildren();
      if (selected !== GATEWAY) {
        const service = state.services.find((item) => item.entry.id === selected);
        if (service) {
          detailKey = selected;
          renderService(service);
          return;
        }
        selected = GATEWAY;
      }
      detailKey = GATEWAY;
      renderGateway();
    }

    // ---- 网关 ----

    function renderGateway(): void {
      const card = ui.sheet({ title: T.gateway });
      const statusHost = ui.h('div', 'svc-status');
      const notes = ui.h('div', 'svc-notes');
      card.body.append(statusHost, notes);

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
      const form = ui.h('div', 'svc-form');
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

      form.append(
        checkBlock(enabled, T.enabledNote),
        block(T.fieldPort, port, T.portNote),
        block(T.fieldTokenName, secretName, T.tokenNameNote),
        block(T.fieldTokenValue, tokenRow, T.tokenValueNote),
        checkBlock(queryToken, T.allowQueryTokenNote),
        block(T.fieldTimeout, timeout, T.timeoutNote),
        block(T.fieldDefaultModel, defaultModel, T.defaultModelNote),
      );

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

      card.body.append(form, actions);
      detail.append(card.el);
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

    // ---- 服务 ----

    /**
     * 服务表单。`withProcess` 为 false 时只给新增用的最小集合:
     * 名称、类型、地址、四个开关与高级字段;进程字段加完服务再到详情里填。
     */
    function buildServiceForm(initial: ServiceEntry | null, withProcess: boolean): ServiceForm {
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
        placeholder: 'http://127.0.0.1:8000',
      });

      const enabled = ui.checkbox(T.flagEnabled, { checked: initial?.enabled ?? true });
      const manage = ui.checkbox(T.flagManage, { checked: initial?.manage ?? true });
      const autoStart = ui.checkbox(T.flagAutoStart, { checked: initial?.autoStart ?? true });
      const restartOnExit = ui.checkbox(T.flagRestartOnExit, { checked: initial?.restartOnExit ?? true });

      const serverDir = ui.input({ value: initial?.serverDir ?? '' });
      const binary = ui.input({ value: initial?.binary ?? '' });
      const args = ui.input({ value: initial?.args ?? '', cls: 'mono' });
      const process = ui.h('div', 'svc-form svc-wide');
      process.append(
        block(T.fieldServerDir, pathRow(serverDir, 'directory'), T.serverDirNote),
        block(T.fieldBinary, pathRow(binary, 'file'), T.binaryNote),
        block(T.fieldArgs, args, T.argsNote, true),
      );
      const syncProcess = (): void => { process.hidden = !manage.checked; };
      manage.input.addEventListener('change', syncProcess, { signal: ctx.signal });

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

      const advanced = ui.foldSheet(`advanced-${initial?.id ?? 'new'}`, {
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

      const grid = ui.h('div', 'svc-form');
      grid.append(
        block(T.fieldName, name, T.nameNote),
        block(T.fieldType, type, typeNoteEl),
        block(T.fieldEndpoint, endpoint, T.endpointNote, true),
      );

      const flags = ui.h('div', 'svc-flags');
      flags.append(
        checkBlock(enabled, T.serviceEnabledNote),
        checkBlock(manage, T.manageNote),
        checkBlock(autoStart, T.autoStartNote),
        checkBlock(restartOnExit, T.restartOnExitNote),
      );

      const el = ui.h('div', 'svc-formwrap');
      el.append(grid, flags, ...(withProcess ? [process] : []), advanced.el);
      syncProcess();

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

    function renderService(service: PanelService): void {
      const id = service.entry.id;
      const card = ui.sheet({ title: service.entry.name });
      const statusHost = ui.h('div', 'svc-status');
      const actionsHost = ui.h('div', 'svc-actions');
      card.body.append(statusHost);

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

      const form = buildServiceForm(service.entry, true);
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

      card.body.append(form.el, saveRow, actionsHost);
      detail.append(card.el);
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
        selected = GATEWAY;
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
      const form = buildServiceForm(null, false);
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
          selected = created.id;
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
