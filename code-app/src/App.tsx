import { useEffect, useMemo, useState } from 'react';
import {
  resolvePluginStep,
  savePluginConfiguration,
  isPluginConfigDebugEnabled,
  ConfigDataAccessError,
  type ResolvedPluginStep
} from './services/pluginConfigService';

type Provider = 'recaptcha' | 'turnstile';
type RecaptchaMode = 'standard' | 'enterprise';
type ThemeMode = 'dark' | 'light' | 'system';
type ConfigTab = 'plugin' | 'snippet';
type ActionThresholdPair = { action: string; threshold: string };

const clamp = (value: number) => Math.max(0, Math.min(1, value));

const normalizeGuid = (value: string) => value.replace(/[{}]/g, '').trim().toLowerCase();

type ParsedUnsecureConfig = {
  provider: Provider;
  recaptchaMode: RecaptchaMode;
  projectId: string;
  siteKey: string;
  actionThresholdPairs: ActionThresholdPair[];
  failureMessage: string;
};

const decodeConfigValue = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const parseUnsecureConfig = (config?: string): ParsedUnsecureConfig => {
  const result: ParsedUnsecureConfig = {
    provider: 'recaptcha',
    recaptchaMode: 'standard',
    projectId: '',
    siteKey: '',
    actionThresholdPairs: [{ action: 'cij_form_submit', threshold: '0.5' }],
    failureMessage: ''
  };

  let legacyExpectedAction = 'cij_form_submit';
  let legacyMinScore = 0.5;
  let parsedActionThresholds = false;

  if (!config) return result;

  for (const part of config.split(';')) {
    const pair = part.split('=');
    const rawKey = pair[0];
    const rawValue = pair.slice(1).join('=');
    if (!rawKey || !rawValue) continue;

    const key = rawKey.trim().toLowerCase();
    const value = rawValue.trim().toLowerCase();

    if (key === 'provider' && (value === 'recaptcha' || value === 'turnstile')) {
      result.provider = value;
    }

    if (key === 'recaptchamode' && (value === 'standard' || value === 'enterprise')) {
      result.recaptchaMode = value;
    }

    if (key === 'projectid') {
      result.projectId = rawValue.trim();
    }

    if (key === 'sitekey') {
      result.siteKey = rawValue.trim();
    }

    if (key === 'failuremessage') {
      result.failureMessage = decodeConfigValue(rawValue.trim());
    }

    if (key === 'actionthresholds') {
      const pairs = decodeConfigValue(rawValue.trim())
        .split(',')
        .map((entry) => {
          const [actionName, thresholdRaw] = entry.split(':');
          const action = String(actionName || '').trim();
          const parsed = clamp(Number(String(thresholdRaw || '').trim()) || 0.5);
          return action ? { action, threshold: String(parsed) } : null;
        })
        .filter((pair): pair is ActionThresholdPair => !!pair);

      if (pairs.length) {
        result.actionThresholdPairs = pairs;
        parsedActionThresholds = true;
      }
    }

    if (key === 'expectedaction') {
      legacyExpectedAction = decodeConfigValue(rawValue.trim()) || 'cij_form_submit';
    }

    if (key === 'minscore') {
      const score = Number(value);
      if (!Number.isNaN(score)) {
        legacyMinScore = clamp(score);
      }
    }
  }

  if (!parsedActionThresholds) {
    result.actionThresholdPairs = [{
      action: legacyExpectedAction,
      threshold: String(legacyMinScore)
    }];
  }

  return result;
};

export function App() {
  const [themeMode, setThemeMode] = useState<ThemeMode>('system');
  const [activeTab, setActiveTab] = useState<ConfigTab>('plugin');
  const [systemTheme, setSystemTheme] = useState<'dark' | 'light'>('light');
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [provider, setProvider] = useState<Provider>('recaptcha');
  const [recaptchaMode, setRecaptchaMode] = useState<RecaptchaMode>('standard');
  const [actionThresholdPairs, setActionThresholdPairs] = useState<ActionThresholdPair[]>([
    { action: 'cij_form_submit', threshold: '0.5' }
  ]);
  const [projectId, setProjectId] = useState('');
  const [enterpriseSiteKey, setEnterpriseSiteKey] = useState('');
  const [enterpriseSiteKeyVisible, setEnterpriseSiteKeyVisible] = useState(false);
  const [snippetAction, setSnippetAction] = useState('cij_form_submit');
  const [pluginFailureMessage, setPluginFailureMessage] = useState('');
  const [secret, setSecret] = useState('');
  const [snippetSiteKey, setSnippetSiteKey] = useState('');
  const [snippetVerifyEndpoint, setSnippetVerifyEndpoint] = useState('');
  const [snippetTimeout, setSnippetTimeout] = useState('8000');
  const [snippetFailureMessage, setSnippetFailureMessage] = useState('');
  const [snippetPreSubmitEnabled, setSnippetPreSubmitEnabled] = useState(true);
  const [snippetDebugEnabled, setSnippetDebugEnabled] = useState(false);
  const [stepId, setStepId] = useState('');
  const [status, setStatus] = useState('Ready.');
  const [isSaving, setIsSaving] = useState(false);

  const normalizedActionThresholdPairs = useMemo(() => {
    const valid = actionThresholdPairs
      .map((pair) => {
        const action = pair.action.trim();
        const threshold = clamp(Number(pair.threshold) || 0.5);
        return action ? { action, threshold } : null;
      })
      .filter((pair): pair is { action: string; threshold: number } => !!pair);

    return valid.length
      ? valid
      : [{ action: 'cij_form_submit', threshold: 0.5 }];
  }, [actionThresholdPairs]);

  const actionThresholdsSerialized = useMemo(
    () => normalizedActionThresholdPairs.map((pair) => `${pair.action}:${pair.threshold}`).join(','),
    [normalizedActionThresholdPairs]
  );

  const unsecureConfig = useMemo(() => {
    if (provider === 'turnstile') {
      const parts = ['provider=turnstile'];
      if (pluginFailureMessage.trim()) {
        parts.push(`failuremessage=${encodeURIComponent(pluginFailureMessage.trim())}`);
      }
      return parts.join(';');
    }

    const parts = [
      'provider=recaptcha',
      `recaptchamode=${recaptchaMode}`,
      `actionthresholds=${actionThresholdsSerialized}`
    ];

    if (pluginFailureMessage.trim()) {
      parts.push(`failuremessage=${encodeURIComponent(pluginFailureMessage.trim())}`);
    }

    if (recaptchaMode === 'enterprise') {
      if (projectId.trim()) parts.push(`projectid=${projectId.trim()}`);
      if (enterpriseSiteKey.trim()) parts.push(`sitekey=${enterpriseSiteKey.trim()}`);
    }

    return parts.join(';');
  }, [provider, recaptchaMode, actionThresholdsSerialized, pluginFailureMessage, projectId, enterpriseSiteKey]);

  const generatedSnippet = useMemo(() => {
    const lines: string[] = [];
    lines.push('<script>');
    lines.push('function initCijCaptcha() {');
    lines.push('window.CijCaptcha.init({');
    lines.push(`  provider: '${provider}',`);
    lines.push(`  siteKey: '${snippetSiteKey || 'YOUR_SITE_KEY'}',`);

    if (provider === 'recaptcha') {
      lines.push(`  action: '${snippetAction || 'cij_form_submit'}',`);
      lines.push('  recaptcha: {');
      lines.push(`    mode: '${recaptchaMode}'`);
      lines.push('  },');
    }

    lines.push(`  enableDebugLogs: ${snippetDebugEnabled ? 'true' : 'false'}${snippetPreSubmitEnabled ? ',' : ''}`);
    if (snippetPreSubmitEnabled) {
      const safeTimeout = Math.max(1, Number(snippetTimeout) || 8000);
      lines.push('  preSubmit: {');
      lines.push(`    verifyEndpoint: '${snippetVerifyEndpoint || 'https://YOUR_FUNCTION_HOST/api/captcha/verify'}',`);
      lines.push(`    timeout: ${safeTimeout}${snippetFailureMessage.trim() ? ',' : ''}`);
      if (snippetFailureMessage.trim()) {
        lines.push(`    failureMessage: '${snippetFailureMessage.trim().replace(/'/g, "\\'")}'`);
      }
      lines.push('  }');
    }

    lines.push('});');
    lines.push('}');
    lines.push('</script>');
    lines.push('<script src="https://cdn.jsdelivr.net/gh/georged/cij-captcha/form-script/cij-captcha.js" onload="initCijCaptcha()"></script>');
    return lines.join('\n');
  }, [
    provider,
    snippetAction,
    snippetSiteKey,
    normalizedActionThresholdPairs,
    snippetDebugEnabled,
    snippetPreSubmitEnabled,
    snippetVerifyEndpoint,
    snippetTimeout,
    snippetFailureMessage
  ]);

  const resolvedTheme: 'dark' | 'light' = useMemo(() => {
    if (themeMode === 'system') return systemTheme;
    return themeMode;
  }, [themeMode, systemTheme]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystemTheme(media.matches ? 'dark' : 'light');
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    setDebugEnabled(isPluginConfigDebugEnabled());

    const resolveStep = async () => {
      setStatus('Resolving plugin step...');

      try {
        const resolved: ResolvedPluginStep = await resolvePluginStep({
          pluginTypeName: 'Georged.Cij.Captcha.CaptchaValidationPlugin',
          messageName: 'msdynmkt_validateformsubmission'
        });

        setStepId(normalizeGuid(resolved.stepId));

        const parsed = parseUnsecureConfig(resolved.configuration || '');
        setProvider(parsed.provider);
        setActionThresholdPairs(parsed.actionThresholdPairs);
        setRecaptchaMode(parsed.recaptchaMode);
        setProjectId(parsed.projectId);
        setEnterpriseSiteKey(parsed.siteKey);
        setSnippetAction(parsed.actionThresholdPairs[0]?.action || 'cij_form_submit');
        setPluginFailureMessage(parsed.failureMessage);
        setSnippetSiteKey(parsed.siteKey);
        setStatus('Resolved plugin step and loaded current unsecure configuration.');
      } catch (error) {
        if (error instanceof ConfigDataAccessError) {
          setStatus(error.message);
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        setStatus(`Auto-resolve failed: ${message}`);
      }
    };

    resolveStep();
  }, []);

  const toggleDebug = () => {
    if (typeof window === 'undefined') return;

    const next = !debugEnabled;
    window.localStorage.setItem('cijConfigDebug', next ? '1' : '0');
    setDebugEnabled(isPluginConfigDebugEnabled());
    setStatus(`Debug logging ${next ? 'enabled' : 'disabled'}.`);
  };

  const save = async () => {
    const normalizedStepId = normalizeGuid(stepId);

    if (!normalizedStepId) {
      setStatus('Step Id is required.');
      return;
    }

    if (!secret.trim()) {
      setStatus('Secret key is required.');
      return;
    }

    if (provider === 'recaptcha' && recaptchaMode === 'enterprise' && !projectId.trim()) {
      setStatus('Project Id is required for reCAPTCHA Enterprise mode.');
      return;
    }

    setStatus('Saving...');
    setIsSaving(true);

    try {
      await savePluginConfiguration({
        stepId: normalizedStepId,
        unsecureConfig,
        secureConfig: secret
      });

      setStatus('Saved successfully.');
    } catch (error) {
      if (error instanceof ConfigDataAccessError) {
        setStatus(error.message);
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Save failed: ${message}`);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className={`app ${resolvedTheme}`}>
      <div className="backdrop" />
      <main className="panel">
        <header className="header">
          <div>
            <h1>CIJ Captcha Configuration</h1>
            <p>Configure plugin provider, threshold, and secret key.</p>
          </div>
          <div className="header-actions">
            <div className="header-actions-top">
              <button
                className={`debug-pill ${debugEnabled ? 'on' : 'off'}`}
                type="button"
                onClick={toggleDebug}
                title="Toggle debug logging"
              >
                Debug: {debugEnabled ? 'ON' : 'OFF'}
              </button>
              <div className="theme-toggle" role="group" aria-label="Theme">
                <button
                  type="button"
                  className={`theme-option ${themeMode === 'system' ? 'active' : ''}`}
                  onClick={() => setThemeMode('system')}
                  aria-label="System theme"
                >
                  <span aria-hidden="true">🖥</span>
                  <span>System</span>
                </button>
                <button
                  type="button"
                  className={`theme-option ${themeMode === 'light' ? 'active' : ''}`}
                  onClick={() => setThemeMode('light')}
                  aria-label="Light theme"
                >
                  <span aria-hidden="true">☼</span>
                  <span>Light</span>
                </button>
                <button
                  type="button"
                  className={`theme-option ${themeMode === 'dark' ? 'active' : ''}`}
                  onClick={() => setThemeMode('dark')}
                  aria-label="Dark theme"
                >
                  <span aria-hidden="true">☾</span>
                  <span>Dark</span>
                </button>
              </div>
            </div>
            {debugEnabled && (
              <label className="step-id-inline">
                <span>Plugin Step Id</span>
                <input value={stepId} readOnly />
              </label>
            )}
          </div>
        </header>

        <div className="config-tabs" role="tablist" aria-label="Configuration sections">
          <button
            type="button"
            role="tab"
            className={`config-tab ${activeTab === 'plugin' ? 'active' : ''}`}
            onClick={() => setActiveTab('plugin')}
          >
            Plugin Settings
          </button>
          <button
            type="button"
            role="tab"
            className={`config-tab ${activeTab === 'snippet' ? 'active' : ''}`}
            onClick={() => setActiveTab('snippet')}
          >
            JavaScript Snippet
          </button>
        </div>

        {activeTab === 'plugin' && (
          <section className="grid" role="tabpanel" aria-label="Plugin Settings">
            <label>
              <span>Provider</span>
              <select value={provider} onChange={(e) => setProvider(e.target.value as Provider)}>
                <option value="recaptcha">Google reCAPTCHA v3</option>
                <option value="turnstile">Cloudflare Turnstile</option>
              </select>
            </label>

            <label>
              <span>Secret key</span>
              <input
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder="••••••••••••••••"
              />
            </label>

            {provider === 'recaptcha' && (
              <fieldset>
                <span>reCAPTCHA mode</span>
                <div className="choice-row">
                  <label className="choice-item">
                    <input
                      type="radio"
                      name="recaptcha-mode"
                      checked={recaptchaMode === 'standard'}
                      onChange={() => setRecaptchaMode('standard')}
                    />
                    <span>Standard</span>
                  </label>
                  <label className="choice-item">
                    <input
                      type="radio"
                      name="recaptcha-mode"
                      checked={recaptchaMode === 'enterprise'}
                      onChange={() => setRecaptchaMode('enterprise')}
                    />
                    <span>Enterprise</span>
                  </label>
                </div>
              </fieldset>
            )}

            {provider === 'recaptcha' && recaptchaMode === 'enterprise' && (
              <label>
                <span>Enterprise project id</span>
                <input
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  placeholder="my-gcp-project-id"
                />
              </label>
            )}

            {provider === 'recaptcha' && recaptchaMode === 'enterprise' && (
              <label>
                <span>Enterprise site key</span>
                <div className="secret-row">
                  <input
                    type={enterpriseSiteKeyVisible ? 'text' : 'password'}
                    value={enterpriseSiteKey}
                    onChange={(e) => {
                      setEnterpriseSiteKey(e.target.value);
                      if (!snippetSiteKey) setSnippetSiteKey(e.target.value);
                    }}
                    placeholder="6Lxxxxxxxxxxxxxxxx"
                  />
                  <button
                    className="secret-toggle"
                    type="button"
                    onClick={() => setEnterpriseSiteKeyVisible((v) => !v)}
                  >
                    {enterpriseSiteKeyVisible ? 'Hide' : 'Show'}
                  </button>
                </div>
              </label>
            )}

            {provider === 'recaptcha' && (
              <div className="wide action-thresholds">
                <span>Action thresholds</span>
                {actionThresholdPairs.map((pair, index) => (
                  <div className="action-threshold-row" key={`${index}-${pair.action}`}>
                    <input
                      value={pair.action}
                      onChange={(e) => {
                        const next = [...actionThresholdPairs];
                        next[index] = { ...next[index], action: e.target.value };
                        setActionThresholdPairs(next);
                      }}
                      placeholder="action name"
                    />
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.1}
                      value={pair.threshold}
                      onChange={(e) => {
                        const next = [...actionThresholdPairs];
                        next[index] = { ...next[index], threshold: e.target.value };
                        setActionThresholdPairs(next);
                      }}
                      placeholder="0.5"
                    />
                    <button
                      type="button"
                      className="secret-toggle"
                      onClick={() => {
                        if (actionThresholdPairs.length === 1) return;
                        setActionThresholdPairs(actionThresholdPairs.filter((_, i) => i !== index));
                      }}
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="secret-toggle"
                  onClick={() => setActionThresholdPairs([...actionThresholdPairs, { action: '', threshold: '0.5' }])}
                >
                  Add action threshold
                </button>
              </div>
            )}

            <label className="wide">
              <span>Plugin validation failure message</span>
              <input
                value={pluginFailureMessage}
                onChange={(e) => setPluginFailureMessage(e.target.value)}
                placeholder="Captcha test failed."
              />
            </label>

            <label className="wide">
              <span>Unsecure config preview</span>
              <textarea value={unsecureConfig} readOnly />
            </label>
          </section>
        )}

        {activeTab === 'snippet' && (
          <section className="grid" role="tabpanel" aria-label="JavaScript Snippet">
            <label className="wide">
              <span>Snippet site key</span>
              <input
                value={snippetSiteKey}
                onChange={(e) => setSnippetSiteKey(e.target.value)}
                placeholder="YOUR_SITE_KEY"
              />
            </label>

            <label className="wide">
              <span>Snippet action</span>
              <input
                value={snippetAction}
                onChange={(e) => setSnippetAction(e.target.value)}
                placeholder="cij_form_submit"
              />
            </label>

            <label className="wide">
              <span>Snippet verify endpoint</span>
              <input
                value={snippetVerifyEndpoint}
                onChange={(e) => setSnippetVerifyEndpoint(e.target.value)}
                placeholder="https://YOUR_FUNCTION_HOST/api/captcha/verify"
              />
            </label>

            <label>
              <span>Snippet timeout (ms)</span>
              <input
                type="number"
                min={1000}
                step={500}
                value={snippetTimeout}
                onChange={(e) => setSnippetTimeout(e.target.value)}
              />
            </label>

            <label className="inline-checkbox">
              <input
                type="checkbox"
                checked={snippetPreSubmitEnabled}
                onChange={(e) => setSnippetPreSubmitEnabled(e.target.checked)}
              />
              <span>Snippet pre-submit enabled</span>
            </label>

            <label className="inline-checkbox">
              <input
                type="checkbox"
                checked={snippetDebugEnabled}
                onChange={(e) => setSnippetDebugEnabled(e.target.checked)}
              />
              <span>Snippet debug logging</span>
            </label>

            <label className="wide">
              <span>Snippet validation failure message override</span>
              <input
                value={snippetFailureMessage}
                onChange={(e) => setSnippetFailureMessage(e.target.value)}
                placeholder="Leave blank to use the server-returned message"
              />
            </label>

            <label className="wide">
              <span>Ready-to-paste init snippet</span>
              <textarea value={generatedSnippet} readOnly />
            </label>
          </section>
        )}

        <footer className="footer">
          <button className="save" type="button" onClick={save} disabled={isSaving}>
            Save Configuration
          </button>
          <div className="status">{status}</div>
        </footer>
      </main>
    </div>
  );
}