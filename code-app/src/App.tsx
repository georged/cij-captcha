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

const clamp = (value: number) => Math.max(0, Math.min(1, value));

const normalizeGuid = (value: string) => value.replace(/[{}]/g, '').trim().toLowerCase();

type ParsedUnsecureConfig = {
  provider: Provider;
  minscore: number;
  recaptchaMode: RecaptchaMode;
  projectId: string;
  siteKey: string;
  expectedAction: string;
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
    minscore: 0.5,
    recaptchaMode: 'standard',
    projectId: '',
    siteKey: '',
    expectedAction: '',
    failureMessage: ''
  };

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

    if (key === 'expectedaction') {
      result.expectedAction = decodeConfigValue(rawValue.trim());
    }

    if (key === 'failuremessage') {
      result.failureMessage = decodeConfigValue(rawValue.trim());
    }

    if (key === 'minscore') {
      const score = Number(value);
      if (!Number.isNaN(score)) {
        result.minscore = clamp(score);
      }
    }
  }

  return result;
};

export function App() {
  const [themeMode, setThemeMode] = useState<ThemeMode>('system');
  const [systemTheme, setSystemTheme] = useState<'dark' | 'light'>('light');
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [provider, setProvider] = useState<Provider>('recaptcha');
  const [recaptchaMode, setRecaptchaMode] = useState<RecaptchaMode>('standard');
  const [minScore, setMinScore] = useState('0.5');
  const [projectId, setProjectId] = useState('');
  const [enterpriseSiteKey, setEnterpriseSiteKey] = useState('');
  const [expectedAction, setExpectedAction] = useState('cij_form_submit');
  const [pluginFailureMessage, setPluginFailureMessage] = useState('');
  const [secret, setSecret] = useState('');
  const [snippetSiteKey, setSnippetSiteKey] = useState('');
  const [snippetVerifyEndpoint, setSnippetVerifyEndpoint] = useState('');
  const [snippetTimeoutMs, setSnippetTimeoutMs] = useState('8000');
  const [snippetFailureMessage, setSnippetFailureMessage] = useState('');
  const [snippetPreSubmitEnabled, setSnippetPreSubmitEnabled] = useState(true);
  const [snippetDebugEnabled, setSnippetDebugEnabled] = useState(false);
  const [stepId, setStepId] = useState('');
  const [status, setStatus] = useState('Ready.');
  const [isSaving, setIsSaving] = useState(false);

  const unsecureConfig = useMemo(() => {
    if (provider === 'turnstile') {
      const parts = ['provider=turnstile'];
      if (pluginFailureMessage.trim()) {
        parts.push(`failuremessage=${encodeURIComponent(pluginFailureMessage.trim())}`);
      }
      return parts.join(';');
    }

    const safeScore = clamp(Number(minScore) || 0.5);
    const parts = [
      'provider=recaptcha',
      `recaptchamode=${recaptchaMode}`,
      `minscore=${safeScore}`
    ];

    if (expectedAction.trim()) {
      parts.push(`expectedaction=${expectedAction.trim()}`);
    }

    if (pluginFailureMessage.trim()) {
      parts.push(`failuremessage=${encodeURIComponent(pluginFailureMessage.trim())}`);
    }

    if (recaptchaMode === 'enterprise') {
      if (projectId.trim()) parts.push(`projectid=${projectId.trim()}`);
      if (enterpriseSiteKey.trim()) parts.push(`sitekey=${enterpriseSiteKey.trim()}`);
    }

    return parts.join(';');
  }, [provider, recaptchaMode, minScore, expectedAction, pluginFailureMessage, projectId, enterpriseSiteKey]);

  const generatedSnippet = useMemo(() => {
    const lines: string[] = [];
    lines.push('window.CijCaptcha.init({');
    lines.push(`  provider: '${provider}',`);
    lines.push(`  siteKey: '${snippetSiteKey || 'YOUR_SITE_KEY'}',`);

    if (provider === 'recaptcha') {
      lines.push(`  action: '${expectedAction || 'cij_form_submit'}',`);
      lines.push('  recaptcha: {');
      lines.push(`    mode: '${recaptchaMode}'`);
      lines.push('  },');
    }

    lines.push(`  enableDebugLogs: ${snippetDebugEnabled ? 'true' : 'false'},`);
    if (snippetPreSubmitEnabled) {
      const safeTimeout = Math.max(1, Number(snippetTimeoutMs) || 8000);
      lines.push('  preSubmit: {');
      lines.push('    enabled: true,');
      lines.push(`    verifyEndpoint: '${snippetVerifyEndpoint || 'https://YOUR_FUNCTION_HOST/api/captcha/verify'}',`);
      lines.push(`    timeoutMs: ${safeTimeout},`);
      if (snippetFailureMessage.trim()) {
        lines.push(`    failureMessage: '${snippetFailureMessage.trim().replace(/'/g, "\\'")}'`);
      }
      lines.push('  }');
    } else {
      lines.push('  preSubmit: {');
      lines.push('    enabled: false');
      lines.push('  }');
    }

    lines.push('});');
    return lines.join('\n');
  }, [
    provider,
    expectedAction,
    recaptchaMode,
    snippetSiteKey,
    snippetDebugEnabled,
    snippetPreSubmitEnabled,
    snippetVerifyEndpoint,
    snippetTimeoutMs,
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
        setMinScore(String(parsed.minscore));
        setRecaptchaMode(parsed.recaptchaMode);
        setProjectId(parsed.projectId);
        setEnterpriseSiteKey(parsed.siteKey);
        setExpectedAction(parsed.expectedAction || 'cij_form_submit');
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
              <div className="theme-toggle" role="tablist" aria-label="Theme">
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

        <section className="grid">
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
            <label>
              <span>reCAPTCHA mode</span>
              <select value={recaptchaMode} onChange={(e) => setRecaptchaMode(e.target.value as RecaptchaMode)}>
                <option value="standard">Standard</option>
                <option value="enterprise">Enterprise</option>
              </select>
            </label>
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
              <input
                value={enterpriseSiteKey}
                onChange={(e) => {
                  setEnterpriseSiteKey(e.target.value);
                  if (!snippetSiteKey) setSnippetSiteKey(e.target.value);
                }}
                placeholder="6Lxxxxxxxxxxxxxxxx"
              />
            </label>
          )}

          {provider === 'recaptcha' && (
            <label>
              <span>Expected action</span>
              <input
                value={expectedAction}
                onChange={(e) => setExpectedAction(e.target.value)}
                placeholder="cij_form_submit"
              />
            </label>
          )}

          {provider === 'recaptcha' && (
            <label>
              <span>Minimum score</span>
              <input
                type="number"
                min={0}
                max={1}
                step={0.1}
                value={minScore}
                onChange={(e) => setMinScore(e.target.value)}
              />
            </label>
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

          <label className="wide">
            <span>Snippet site key</span>
            <input
              value={snippetSiteKey}
              onChange={(e) => setSnippetSiteKey(e.target.value)}
              placeholder="YOUR_SITE_KEY"
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
              value={snippetTimeoutMs}
              onChange={(e) => setSnippetTimeoutMs(e.target.value)}
            />
          </label>

          <label>
            <span>Snippet pre-submit enabled</span>
            <select
              value={snippetPreSubmitEnabled ? 'true' : 'false'}
              onChange={(e) => setSnippetPreSubmitEnabled(e.target.value === 'true')}
            >
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          </label>

          <label>
            <span>Snippet debug logging</span>
            <select
              value={snippetDebugEnabled ? 'true' : 'false'}
              onChange={(e) => setSnippetDebugEnabled(e.target.value === 'true')}
            >
              <option value="false">false</option>
              <option value="true">true</option>
            </select>
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