/**
 * 「服务」面板:服务列表与网关两段。
 *
 * 数据面只走 `ctx.invoke`;DOM 只走 `ctx.ui` 原语。列表轮询状态,表单与令牌抽屉
 * 单独维护自己的输入,不会被轮询覆盖。
 */
import type { WebUiClientBundle, WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import {
  SERVICE_KINDS, SERVICE_PROTOCOLS,
  type PanelLogs, type PanelModels, type PanelService, type PanelServiceEntry, type PanelState,
  type PanelTokenResult,
} from '../src/panel.ts';
import { panelText, type PanelText } from './strings.ts';
import './style.css';

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function setPill(el: HTMLSpanElement, text: string, tone: 'on' | 'off' | 'plain' = 'plain'): void {
  el.textContent = text;
  el.className = tone === 'on' ? 'pill on' : tone === 'off' ? 'pill off' : 'pill';
}

function setBadPill(el: HTMLSpanElement, text: string): void {
  el.textContent = text;
  el.className = 'pill svc-bad';
}

function phaseText(T: PanelText, status: PanelService): string {
  if (!status.entry.enabled) return T.disabled;
  switch (status.phase) {
    case 'online': return T.phaseOnline;
    case 'starting': return T.phaseStarting;
    case 'error': return T.phaseError;
    default: return T.phaseOff;
  }
}

function phaseTone(status: PanelService): 'on' | 'off' | 'plain' {
  if (!status.entry.enabled) return 'off';
  if (status.phase === 'online') return 'on';
  return status.phase === 'error' ? 'off' : 'plain';
}

function gatewayPhase(T: PanelText, status: PanelState['gateway']): { text: string; tone: 'on' | 'off' | 'plain' } {
  switch (status.status) {
    case 'ok': return { text: T.phaseOnline, tone: 'on' };
    case 'starting': return { text: T.phaseStarting, tone: 'plain' };
    case 'degraded': return { text: T.phaseDegraded, tone: 'plain' };
    case 'error': return { text: T.phaseError, tone: 'off' };
    default: return { text: T.phaseOff, tone: 'off' };
  }
}

function defaultPort(entry: PanelServiceEntry): number | null {
  if (typeof entry.port === 'number' && entry.port > 0) return entry.port;
  return entry.kind === 'audiocpp' ? 8000 : null;
}

const servicesPanel: WebUiPanel = {
  mount(ctx: WebUiPanelContext): void {
    const { ui } = ctx;
    const T = panelText(ctx.language);

    const root = ui.h('div', 'svc-panel');
    const bar = ui.rowbar();
    const tabs = ui.segmented(
      [{ value: 'services', label: T.tabServices }, { value: 'gateway', label: T.tabGateway }],
      {
        value: 'services',
        size: 'sm',
        onSelect: (value) => {
          view = value === 'gateway' ? 'gateway' : 'services';
          applyView();
        },
      },
    );
    const refreshBtn = ui.button(T.refresh, { size: 'sm', onClick: () => void refresh() });
    bar.append(tabs.el, ui.h('span', 'grow'), refreshBtn);

    const msg = ui.msgline();

    // ---- 服务列表 ----
    const servicesView = ui.h('div', 'svc-view');
    const tools = ui.rowbar();
    const addBtn = ui.button(T.add, { variant: 'primary', size: 'sm', onClick: () => openForm(null) });
    const discoverBtn = ui.button(T.discover, { size: 'sm', onClick: () => void discoverAll() });
    tools.append(addBtn, discoverBtn, ui.h('span', 'grow'));
    const list = ui.h('div', 'svc-list');
    list.append(ui.placeholder(T.loading));
    const formHost = ui.h('div');
    servicesView.append(tools, list, formHost);

    // ---- 网关 ----
    const gatewayView = ui.h('div', 'svc-view');
    gatewayView.hidden = true;
    const gwSheet = ui.sheet({ title: T.gateway });
    const gwStatus = ui.pill('');
    const gwReady = ui.pill('');
    const gwAddress = ui.h('span', 'svc-mono');
    const gwPort = ui.h('span', 'svc-mono');
    const gwServices = ui.h('span', 'svc-mono');
    const gwModels = ui.h('span', 'svc-mono');
    const gwVersion = ui.h('span', 'svc-mono');
    const gwUptime = ui.h('span', 'svc-mono');
    const gwToken = ui.h('span', 'svc-chiprow');
    const gwRequired = ui.pill('');
    const gwQuery = ui.pill('');
    const gwDefault = ui.h('span', 'svc-mono');
    gwSheet.body.append(ui.kv([
      { k: T.rowStatus, v: gwStatus },
      { k: T.rowReady, v: gwReady },
      { k: T.rowAddress, v: gwAddress },
      { k: T.rowPort, v: gwPort },
      { k: T.rowServices, v: gwServices },
      { k: T.rowModels, v: gwModels },
      { k: T.rowVersion, v: gwVersion },
      { k: T.rowUptime, v: gwUptime },
      { k: T.rowToken, v: gwToken },
      { k: T.rowTokenRequired, v: gwRequired },
      { k: T.rowQueryToken, v: gwQuery },
      { k: T.rowDefaultModel, v: gwDefault },
    ]));

    const tokenName = ui.input({ placeholder: 'SERVICE_TOKEN' });
    const tokenValue = ui.input({ type: 'password', placeholder: T.tokenUnset });
    const tokenMsg = ui.msgline();
    const tokenSetBtn = ui.button(T.tokenSet, {
      variant: 'primary', size: 'sm', onClick: () => void saveGatewayToken(),
    });
    const tokenClearBtn = ui.button(T.tokenClear, {
      variant: 'danger', size: 'sm', onClick: () => void clearGatewayToken(),
    });
    const tokenRow = ui.h('div', 'svc-token-row');
    tokenRow.append(ui.field(T.tokenName, tokenName), ui.field(T.tokenValue, tokenValue));
    const tokenActs = ui.actions();
    tokenActs.append(tokenSetBtn, tokenClearBtn);
    gwSheet.body.append(tokenRow, tokenActs, tokenMsg);
    gatewayView.append(gwSheet.el);

    root.append(bar, msg, servicesView, gatewayView);
    ctx.root.append(root);

    let state: PanelState | null = null;
    let view: 'services' | 'gateway' = 'services';
    let formOpen = false;
    let lastSecretName: string | null = null;
    let refreshFailed = false;

    applyView();
    void refresh();
    ctx.interval(() => void refresh(), 4000);

    // -----------------------------------------------------------------------

    function applyView(): void {
      servicesView.hidden = view !== 'services';
      gatewayView.hidden = view !== 'gateway';
    }

    function fail(err: unknown): void {
      msg.textContent = `${T.failed}: ${errText(err)}`;
      msg.classList.add('bad');
    }

    function clearMsg(): void {
      msg.textContent = '';
      msg.classList.remove('bad');
    }

    async function refresh(): Promise<void> {
      try {
        state = await ctx.invoke<PanelState>('state');
        if (refreshFailed) {
          refreshFailed = false;
          clearMsg();
        }
        if (!formOpen) renderList();
        renderGateway();
      } catch (err) {
        refreshFailed = true;
        fail(err);
      }
    }

    function renderList(): void {
      if (!state) return;
      if (!state.services.length) {
        list.replaceChildren(ui.placeholder(T.empty));
        return;
      }
      const ids = state.services.map((status) => status.entry.id);
      list.replaceChildren(...state.services.map((status, index) => serviceRow(status, ids, index)));
    }

    function serviceRow(status: PanelService, ids: string[], index: number): HTMLElement {
      const entry = status.entry;
      const row = ui.h('div', 'svc-item');
      const head = ui.h('div', 'svc-head');
      const lamp = ui.h('span', 'svc-lamp');
      lamp.dataset.state = entry.enabled ? status.phase : 'off';
      head.append(lamp, ui.h('span', 'svc-name', entry.label?.trim() || entry.id));
      if (entry.label?.trim() && entry.label.trim() !== entry.id) {
        head.append(ui.h('span', 'svc-id', entry.id));
      }
      const phase = ui.pill('');
      if (status.phase === 'error' && entry.enabled) setBadPill(phase, T.phaseError);
      else setPill(phase, phaseText(T, status), phaseTone(status));
      head.append(phase, ui.pill(entry.kind, 'plain'), ui.pill(entry.protocol, 'plain'));
      if (!entry.manage) head.append(ui.pill(T.unmanaged, 'plain'));
      if (status.external) head.append(ui.pill(T.external, 'plain'));
      const port = defaultPort(entry);
      if (port !== null) head.append(ui.chip(String(port), 'plain'));
      head.append(ui.chip(`${T.rowModels} ${status.models}`, 'plain'));
      if (entry.tokenSet) head.append(ui.pill(T.tokenSetState, 'on'));

      const acts = ui.h('span', 'svc-actions');
      if (entry.enabled && status.phase !== 'online' && status.phase !== 'starting') {
        acts.append(ui.button(T.start, { size: 'sm', onClick: () => act('start', [entry.id]) }));
      }
      if (status.phase === 'online' || status.phase === 'starting') {
        acts.append(ui.button(T.stop, { size: 'sm', onClick: () => act('stop', [entry.id]) }));
      }
      if (entry.enabled) {
        acts.append(ui.button(T.restart, { size: 'sm', onClick: () => act('restart', [entry.id]) }));
      }
      acts.append(ui.button(T.probe, { size: 'sm', onClick: () => act('probe', [entry.id]) }));
      acts.append(ui.button(T.logs, { size: 'sm', onClick: () => void openLogs(entry.id) }));
      if (entry.secretName?.trim()) {
        acts.append(ui.button(T.token, { size: 'sm', onClick: () => openTokenDrawer(entry) }));
      }
      acts.append(ui.button(T.edit, { size: 'sm', onClick: () => openForm(entry) }));
      if (index > 0) {
        const up = ui.button('↑', { size: 'sm', onClick: () => moveService(ids, index, -1) });
        up.title = T.moveUp;
        acts.append(up);
      }
      if (index < ids.length - 1) {
        const down = ui.button('↓', { size: 'sm', onClick: () => moveService(ids, index, 1) });
        down.title = T.moveDown;
        acts.append(down);
      }
      acts.append(ui.button(T.delete, {
        variant: 'danger', size: 'sm', onClick: () => void removeService(entry.id),
      }));
      head.append(acts);

      row.append(head, ui.h('div', 'svc-meta', [status.baseUrl, status.detail].filter(Boolean).join(' · ')));
      return row;
    }

    function renderGateway(): void {
      if (!state) return;
      const gw = state.gateway;
      const phase = gatewayPhase(T, gw);
      if (gw.status === 'error') setBadPill(gwStatus, phase.text);
      else setPill(gwStatus, phase.text, phase.tone);
      setPill(gwReady, gw.ready ? T.yes : T.no, gw.ready ? 'on' : 'off');
      gwAddress.textContent = gw.baseUrl;
      gwPort.textContent = String(gw.port);
      gwServices.textContent = `${gw.online}/${gw.total}`;
      gwModels.textContent = String(gw.models);
      gwVersion.textContent = gw.version;
      gwUptime.textContent = ui.fmt.duration(gw.uptimeSec * 1000);
      gwToken.replaceChildren(
        ui.pill(gw.tokenSet ? T.tokenSetState : T.tokenUnset, gw.tokenSet ? 'on' : 'off'),
        ui.h('span', 'svc-mono', gw.secretName || T.none),
      );
      setPill(gwRequired, gw.tokenRequired ? T.yes : T.no, gw.tokenRequired ? 'on' : 'plain');
      setPill(gwQuery, gw.allowQueryToken ? T.yes : T.no, gw.allowQueryToken ? 'on' : 'plain');
      gwDefault.textContent = gw.defaultSpeechModel || T.none;
      if (gw.secretName !== lastSecretName && ctx.root.ownerDocument?.activeElement !== tokenName) {
        tokenName.value = gw.secretName;
        lastSecretName = gw.secretName;
      }
      tokenName.readOnly = Boolean(gw.secretName);
    }

    function act(method: string, args: unknown[]): void {
      void (async () => {
        try {
          await ctx.invoke(method, args);
          clearMsg();
          await refresh();
        } catch (err) {
          fail(err);
        }
      })();
    }

    async function discoverAll(): Promise<void> {
      clearMsg();
      try {
        const result = await ctx.invoke<PanelModels>('discover', []);
        ui.toast(T.discovered(result.models.length), 'ok');
        await refresh();
      } catch (err) {
        fail(err);
      }
    }

    async function openLogs(id: string): Promise<void> {
      try {
        const result = await ctx.invoke<PanelLogs>('logs', [id, 200]);
        ui.drawer(T.logsTitle(id), result.text || T.logsEmpty);
      } catch (err) {
        fail(err);
      }
    }

    function moveService(ids: string[], index: number, delta: number): void {
      const target = index + delta;
      if (target < 0 || target >= ids.length) return;
      const next = [...ids];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item!);
      act('reorder', [next]);
    }

    async function removeService(id: string): Promise<void> {
      const confirmed = await ui.confirm({
        title: T.deleteTitle(id),
        body: T.deleteBody,
        danger: true,
      });
      if (!confirmed) return;
      act('remove', [id]);
    }

    // ---- 添加 / 编辑 ----
    function openForm(entry: PanelServiceEntry | null): void {
      formOpen = true;
      formHost.replaceChildren();
      const sheet = ui.sheet({ title: entry ? T.editTitle : T.addTitle });

      const idInput = ui.input({ value: entry?.id ?? '', disabled: entry !== null });
      const labelInput = ui.input({ value: entry?.label ?? '' });
      const kindSelect = ui.select({ value: entry?.kind ?? 'custom', options: SERVICE_KINDS });
      const protocolSelect = ui.select({ value: entry?.protocol ?? 'openai', options: SERVICE_PROTOCOLS });
      const hostInput = ui.input({ value: entry?.host ?? '', placeholder: '127.0.0.1' });
      const portInput = ui.input({ type: 'number', value: entry?.port != null ? String(entry.port) : '' });
      portInput.min = '1';
      portInput.max = '65535';
      const baseUrlInput = ui.input({ value: entry?.baseUrl ?? '', placeholder: 'http://127.0.0.1:8000' });
      const healthInput = ui.input({ value: entry?.healthPath ?? '', placeholder: '/health' });
      const serverDirInput = ui.input({ value: entry?.serverDir ?? '' });
      const binaryInput = ui.input({ value: entry?.binary ?? '' });
      const configInput = ui.input({ value: entry?.configPath ?? '' });
      const argsInput = ui.input({ value: entry?.args ?? '', cls: 'mono' });
      const secretInput = ui.input({ value: entry?.secretName ?? '', cls: 'mono' });
      const profileInput = ui.input({ value: entry?.modelProfile ?? '', placeholder: 'auto' });
      const profilesInput = ui.textarea({
        value: entry?.modelProfiles ? JSON.stringify(entry.modelProfiles, null, 2) : '',
        rows: 4,
        cls: 'mono',
      });
      const modelsInput = ui.input({ value: entry?.models?.join(', ') ?? '' });
      const optionsInput = ui.textarea({
        value: entry?.options ? JSON.stringify(entry.options, null, 2) : '',
        rows: 5,
        cls: 'mono',
      });

      const enabledBox = ui.checkbox(T.flagEnabled, { checked: entry?.enabled ?? true });
      const manageBox = ui.checkbox(T.flagManage, { checked: entry?.manage ?? true });
      const autoBox = ui.checkbox(T.flagAutoStart, { checked: entry?.autoStart ?? true });
      const restartBox = ui.checkbox(T.flagRestartOnExit, { checked: entry?.restartOnExit ?? true });

      const pathControl = (input: HTMLInputElement, kind: 'file' | 'directory'): HTMLElement => {
        input.style.flex = '1';
        const pick = ui.button(T.choose, {
          size: 'sm',
          onClick: () => {
            void ctx.pickPath({ kind, currentPath: input.value }).then((chosen) => {
              if (chosen) input.value = chosen;
            });
          },
        });
        const row = ui.h('div', 'svc-path');
        row.append(input, pick);
        return row;
      };
      const wide = (node: HTMLElement): HTMLElement => {
        const box = ui.h('div', 'svc-form-wide');
        box.append(node);
        return box;
      };

      const grid = ui.h('div', 'svc-form');
      grid.append(
        ui.field(T.fieldId, idInput),
        ui.field(T.fieldLabel, labelInput),
        ui.field(T.fieldKind, kindSelect),
        ui.field(T.fieldProtocol, protocolSelect),
        ui.field(T.fieldHost, hostInput),
        ui.field(T.fieldPort, portInput),
        wide(ui.field(T.fieldBaseUrl, baseUrlInput)),
        ui.field(T.fieldHealthPath, healthInput),
        wide(ui.field(T.fieldServerDir, pathControl(serverDirInput, 'directory'))),
        wide(ui.field(T.fieldBinary, pathControl(binaryInput, 'file'))),
        wide(ui.field(T.fieldConfigPath, pathControl(configInput, 'file'))),
        ui.field(T.fieldSecretName, secretInput),
        ui.field(T.fieldModelProfile, profileInput),
        wide(ui.field(T.fieldModelProfiles, profilesInput)),
        wide(ui.field(T.fieldModels, modelsInput)),
        wide(ui.field(T.fieldArgs, argsInput)),
        wide(ui.field(T.fieldOptions, optionsInput)),
      );

      const flags = ui.h('div', 'svc-flags');
      flags.append(enabledBox.el, manageBox.el, autoBox.el, restartBox.el);

      const formMsg = ui.msgline();
      const saveBtn = ui.button(T.save, { variant: 'primary', onClick: () => void save() });
      const cancelBtn = ui.button(T.cancel, {
        onClick: () => {
          closeForm();
          void refresh();
        },
      });
      const actions = ui.actions();
      actions.append(ui.h('span', 'grow'), cancelBtn, saveBtn);

      sheet.body.append(grid, flags, actions, formMsg);
      formHost.append(sheet.el);

      function closeForm(): void {
        formOpen = false;
        formHost.replaceChildren();
      }

      async function save(): Promise<void> {
        const id = idInput.value.trim();
        if (!id) {
          formMsg.textContent = T.badId;
          formMsg.classList.add('bad');
          return;
        }
        const portText = portInput.value.trim();
        const port = portText ? Number(portText) : null;
        if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
          formMsg.textContent = T.badPort;
          formMsg.classList.add('bad');
          return;
        }
        let options: unknown = null;
        const optionsText = optionsInput.value.trim();
        if (optionsText) {
          try {
            options = JSON.parse(optionsText);
          } catch {
            formMsg.textContent = T.badOptions;
            formMsg.classList.add('bad');
            return;
          }
        }
        let modelProfiles: unknown = null;
        const profilesText = profilesInput.value.trim();
        if (profilesText) {
          try {
            modelProfiles = JSON.parse(profilesText);
          } catch {
            formMsg.textContent = T.badProfiles;
            formMsg.classList.add('bad');
            return;
          }
          if (!modelProfiles || typeof modelProfiles !== 'object' || Array.isArray(modelProfiles)) {
            formMsg.textContent = T.badProfiles;
            formMsg.classList.add('bad');
            return;
          }
        }
        const models = modelsInput.value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
        const payload: Record<string, unknown> = {
          id,
          kind: kindSelect.value,
          protocol: protocolSelect.value,
          enabled: enabledBox.checked,
          manage: manageBox.checked,
          autoStart: autoBox.checked,
          restartOnExit: restartBox.checked,
          port,
          models: models.length ? models : null,
          modelProfiles,
          options,
        };
        const texts: Array<[string, string]> = [
          ['label', labelInput.value],
          ['host', hostInput.value],
          ['baseUrl', baseUrlInput.value],
          ['healthPath', healthInput.value],
          ['serverDir', serverDirInput.value],
          ['binary', binaryInput.value],
          ['configPath', configInput.value],
          ['args', argsInput.value],
          ['secretName', secretInput.value],
          ['modelProfile', profileInput.value],
        ];
        for (const [key, value] of texts) {
          const text = value.trim();
          payload[key] = text || null;
        }
        saveBtn.disabled = true;
        formMsg.textContent = '';
        formMsg.classList.remove('bad');
        try {
          if (entry) await ctx.invoke('update', [entry.id, payload]);
          else await ctx.invoke('add', [payload]);
          ui.toast(T.saved, 'ok');
          closeForm();
          await refresh();
        } catch (err) {
          formMsg.textContent = errText(err);
          formMsg.classList.add('bad');
          saveBtn.disabled = false;
        }
      }
    }

    // ---- 服务令牌 ----
    function openTokenDrawer(entry: PanelServiceEntry): void {
      const name = entry.secretName?.trim();
      if (!name) return;
      const body = ui.h('div', 'svc-token');
      const input = ui.input({
        type: 'password',
        placeholder: entry.tokenSet ? T.tokenSetState : T.tokenUnset,
      });
      const line = ui.h('div', 'svc-token-row');
      line.append(ui.field(`${T.tokenName} ${name}`, input));
      const note = ui.msgline();
      const setBtn = ui.button(T.tokenSet, { variant: 'primary', size: 'sm', onClick: () => void save() });
      const clearBtn = ui.button(T.tokenClear, { variant: 'danger', size: 'sm', onClick: () => void clear() });
      const actions = ui.actions();
      actions.append(setBtn, clearBtn);
      body.append(line, actions, note);
      const drawer = ui.drawer(T.tokenTitle(entry.id), body);

      async function save(): Promise<void> {
        const value = input.value.trim();
        if (!value) {
          note.textContent = T.badToken;
          note.classList.add('bad');
          return;
        }
        try {
          const result = await ctx.invoke<PanelTokenResult>('setToken', [name, value]);
          note.textContent = result.tokenSet ? T.tokenSaved : T.tokenUnset;
          note.classList.toggle('bad', !result.tokenSet);
          ui.toast(T.tokenSaved, 'ok');
          drawer.dispose();
          await refresh();
        } catch (err) {
          note.textContent = errText(err);
          note.classList.add('bad');
        }
      }

      async function clear(): Promise<void> {
        try {
          await ctx.invoke<PanelTokenResult>('setToken', [name, '']);
          ui.toast(T.tokenCleared, 'ok');
          drawer.dispose();
          await refresh();
        } catch (err) {
          note.textContent = errText(err);
          note.classList.add('bad');
        }
      }
    }

    // ---- 网关令牌 ----
    async function saveGatewayToken(): Promise<void> {
      const name = tokenName.value.trim();
      const value = tokenValue.value.trim();
      if (!value) {
        tokenMsg.textContent = T.badToken;
        tokenMsg.classList.add('bad');
        return;
      }
      tokenMsg.textContent = '';
      tokenMsg.classList.remove('bad');
      try {
        const result = await ctx.invoke<PanelTokenResult>('setToken', [name, value]);
        tokenValue.value = '';
        tokenMsg.textContent = result.tokenSet ? T.tokenRestart : T.tokenUnset;
        tokenMsg.classList.toggle('bad', !result.tokenSet);
        ui.toast(T.tokenSaved, 'ok');
        await refresh();
      } catch (err) {
        tokenMsg.textContent = errText(err);
        tokenMsg.classList.add('bad');
      }
    }

    async function clearGatewayToken(): Promise<void> {
      const name = tokenName.value.trim() || state?.gateway.secretName || '';
      tokenMsg.textContent = '';
      tokenMsg.classList.remove('bad');
      try {
        await ctx.invoke<PanelTokenResult>('setToken', [name, '']);
        ui.toast(T.tokenCleared, 'ok');
        tokenMsg.textContent = T.tokenRestart;
        await refresh();
      } catch (err) {
        tokenMsg.textContent = errText(err);
        tokenMsg.classList.add('bad');
      }
    }
  },
};

const bundle: WebUiClientBundle = {
  panels: { services: servicesPanel },
};

export default bundle;
