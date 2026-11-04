/** 包入口:默认导出 `WorldDefinition`,加载器按 `cortico.kind === 'world'` 认它。 */
import { SERVICE } from './definition.ts';

export default SERVICE;
export { SERVICE };
export { SERVICE_DEFAULTS, SERVICE_ID, SERVICE_VERSION, serviceText } from './config.ts';
export type { ServiceText } from './config.ts';
export { ServiceWorld } from './world.ts';
export type { ServiceWorldOptions } from './world.ts';
export { Manager, DEFAULT_LOG_LINES, MAX_LOG_LINES } from './manager.ts';
export type { ManagerOptions, ServiceListSource } from './manager.ts';
export { SERVICE_ID_RE, SERVICE_TYPES } from './panel.ts';
export type {
  PanelGateway, PanelLogs, PanelModels, PanelService, PanelServiceEntry, PanelState, PanelTokenResult,
} from './panel.ts';
export { normalizeEntry, validateServices } from './validate.ts';
export { clearEnvLine, ENV_NAME_RE } from './secrets.ts';
export {
  DEFAULT_HOST, endpointUrl, healthPathOf, healthUrl, hostPort, protocolOf, serverJsonPath,
  serviceIdFor, slugify,
} from './entry.ts';
export { Supervisor, idleServiceStatus, serviceLogPath } from './supervisor.ts';
export type {
  ChildLike, LaunchSpec, LogSink, SupervisorDeps, SupervisorOptions,
} from './supervisor.ts';
export { ServiceError } from './errors.ts';
export type { ServiceErrorKind, ServiceErrorOptions } from './errors.ts';
export {
  gatewayAuthError, isLoopbackHost, startGateway,
} from './gateway/server.ts';
export type {
  GatewayHandle, GatewayHandlers, GatewayHealthBody, GatewayModel, GatewayOptions,
  GatewayVoice, GatewayVoiceList, GatewayVoiceQuery,
} from './gateway/server.ts';
export { ModelCatalog } from './profiles/discover.ts';
export type { CatalogOptions, DiscoveryIo } from './profiles/discover.ts';
export {
  BUILTIN_BY_ID, BUILTIN_PROFILES, AUDIOCPP_INDEXTTS2, AUDIOCPP_MING3, CUSTOM, OPENAI, SING,
} from './profiles/builtin.ts';
export {
  buildSing, buildSpeech, matchesModel, profileOf, profilesOf, resolveProfile,
  resolveSingProfile, speedLevelOf,
} from './profiles/resolve.ts';
export type { BuiltRequest } from './profiles/resolve.ts';
export {
  acceptsSing, acceptsSpeech, adapterOf, audiocppProtocol, customProtocol, llamacppProtocol,
  openaiProtocol, singProtocol, systemoneProtocol,
} from './protocol/index.ts';
export type {
  JsonRequest, ProtocolAdapter, ProtocolRequest, VoiceListRequest,
} from './protocol/index.ts';
export type {
  AudioFormat, AudiocppBackend, Backend, EmbeddingsRequest, GatewayPhase, GatewayStatus, JsonResult,
  ModelField, ModelParameter, ModelParameterType, ModelProfile, ModelProfileOption,
  ModelProfileSpeedLevel, ModelProfileVariant, ModelRecord, Phase, RerankRequest,
  ServiceCatalog, ServiceConfigSection, ServiceEntry, ServiceProtocol, ServiceStatus, ServiceType,
  SingRequest, SpeechRequest, SupervisorStatus, SystemOneRequest, TtsAudio, VoiceOption,
} from './types.ts';
