import {
  PlugintypesService,
  SdkmessagesService,
  SdkmessageprocessingstepsService,
  SdkmessageprocessingstepsecureconfigsService
} from '../generated';

export class ConfigDataAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigDataAccessError';
  }
}

export type ResolveRequest = {
  pluginTypeName: string;
  messageName: string;
};

export type ResolvedPluginStep = {
  stepId: string;
  configuration?: string;
};

export type SaveRequest = {
  stepId: string;
  unsecureConfig: string;
  secureConfig: string;
};

const logDebug = (enabled: boolean, ...args: unknown[]) => {
  if (!enabled) return;
  console.log('[CIJ Config Debug]', ...args);
};
export const isPluginConfigDebugEnabled = (): boolean => {
  if (typeof window === 'undefined') return true;

  const explicitStorage = window.localStorage.getItem('cijConfigDebug');
  if (explicitStorage === '1') return true;
  if (explicitStorage === '0') return false;

  const debugParam = new URLSearchParams(window.location.search).get('cijConfigDebug');
  if (debugParam === '1') return true;
  if (debugParam === '0') return false;

  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1';
};
const shortList = (values: string[]): string => values.slice(0, 10).join(', ');

export async function resolvePluginStep(request: ResolveRequest): Promise<ResolvedPluginStep> {
  const debug = isPluginConfigDebugEnabled();

  logDebug(debug, 'resolvePluginStep request', request);

  const pluginTypeResult = await PlugintypesService.getAll({
    select: ['plugintypeid', 'typename'],
    filter: `typename eq '${request.pluginTypeName.replace(/'/g, "''")}'`
  });

  logDebug(debug, 'pluginType exact result', pluginTypeResult.data);

  let pluginType = pluginTypeResult.data?.[0];
  if (!pluginType?.plugintypeid) {
    const escaped = request.pluginTypeName.replace(/'/g, "''");
    const pluginTypeFallback = await PlugintypesService.getAll({
      select: ['plugintypeid', 'typename'],
      filter: `contains(typename,'${escaped}') or contains(typename,'Captcha')`,
      top: 25
    });

    logDebug(debug, 'pluginType fallback result', pluginTypeFallback.data);

    if (pluginTypeFallback.data?.length === 1) {
      pluginType = pluginTypeFallback.data[0];
    }

    if (!pluginType?.plugintypeid) {
      const candidates = (pluginTypeFallback.data || [])
        .map((x) => x.typename || '')
        .filter(Boolean);

      throw new ConfigDataAccessError(
        `Plugin type not found: ${request.pluginTypeName}. ` +
        (candidates.length
          ? `Candidate typenames: ${shortList(candidates)}`
          : 'No candidate typenames returned from Dataverse.')
      );
    }
  }

  const messageResult = await SdkmessagesService.getAll({
    select: ['sdkmessageid', 'name'],
    filter: `name eq '${request.messageName.replace(/'/g, "''")}'`
  });

  logDebug(debug, 'sdkmessage exact result', messageResult.data);

  const sdkMessage = messageResult.data?.[0];
  if (!sdkMessage?.sdkmessageid) {
    const messageFallback = await SdkmessagesService.getAll({
      select: ['sdkmessageid', 'name'],
      filter: `contains(name,'validateformsubmission')`,
      top: 25
    });

    logDebug(debug, 'sdkmessage fallback result', messageFallback.data);

    const candidates = (messageFallback.data || [])
      .map((x) => x.name || '')
      .filter(Boolean);

    throw new ConfigDataAccessError(
      `SDK message not found: ${request.messageName}. ` +
      (candidates.length
        ? `Candidate messages: ${shortList(candidates)}`
        : 'No candidate messages returned from Dataverse.')
    );
  }

  const select = [
    'sdkmessageprocessingstepid',
    'configuration',
    'statecode',
    '_sdkmessageprocessingstepsecureconfigid_value'
  ] as const;

  const stepResult = await SdkmessageprocessingstepsService.getAll({
    select: [...select],
    filter: `_sdkmessageid_value eq ${sdkMessage.sdkmessageid} and statecode eq 0`,
    top: 1
  });

  const steps = stepResult.data || [];

  logDebug(debug, 'steps returned', steps.length);

  if (!steps.length) {
    throw new ConfigDataAccessError(
      'No active plugin step found for this message.'
    );
  }

  const preferredStep = steps[0];

  logDebug(debug, 'preferred step:', preferredStep);

  return {
    stepId: preferredStep.sdkmessageprocessingstepid,
    configuration: preferredStep.configuration || ''
  };
}

export async function savePluginConfiguration(request: SaveRequest): Promise<void> {
  const debug = isPluginConfigDebugEnabled();
  logDebug(debug, 'savePluginConfiguration request', {
    stepId: request.stepId,
    unsecureConfig: request.unsecureConfig,
    secureConfigLength: request.secureConfig.length
  });

  const stepResult = await SdkmessageprocessingstepsService.get(request.stepId, {
    select: ['sdkmessageprocessingstepid', '_sdkmessageprocessingstepsecureconfigid_value']
  });

  const step = stepResult.data;
  const existingSecureConfigId = step?._sdkmessageprocessingstepsecureconfigid_value;

  logDebug(debug, 'existing secure config id', existingSecureConfigId);

  let secureConfigIdToBind = existingSecureConfigId;

  if (secureConfigIdToBind) {
    logDebug(debug, 'updating existing secure config');
    await SdkmessageprocessingstepsecureconfigsService.update(secureConfigIdToBind, {
      secureconfig: request.secureConfig
    });
  } else {
    logDebug(debug, 'creating new secure config');
    const createResult = await SdkmessageprocessingstepsecureconfigsService.create({
      secureconfig: request.secureConfig
    });

    const createdId = createResult.data?.sdkmessageprocessingstepsecureconfigid;
    if (!createdId) {
      throw new ConfigDataAccessError('Secure config was created but no id was returned.');
    }

    secureConfigIdToBind = createdId;
  }

  logDebug(debug, 'updating step with unsecure config and secure config id', request.unsecureConfig, secureConfigIdToBind);
  const stepUpdatePayload: Record<string, unknown> = {
    configuration: request.unsecureConfig,
    'sdkmessageprocessingstepsecureconfigid@odata.bind': `/sdkmessageprocessingstepsecureconfigs(${secureConfigIdToBind})`
  };

  await SdkmessageprocessingstepsService.update(request.stepId, stepUpdatePayload as never);
}
