import { useEffect, useMemo, useState } from 'react';
import {
  resolvePluginStep,
  savePluginConfiguration,
  isPluginConfigDebugEnabled,
  ConfigDataAccessError,
  type ResolvedPluginStep
} from './services/pluginConfigService';

type Provider = 'recaptcha' | 'turnstile';
type ThemeMode = 'dark' | 'light' | 'system';

const clamp = (value: number) => Math.max(0, Math.min(1, value));

const normalizeGuid = (value: string) => value.replace(/[{}]/g, '').trim().toLowerCase();

const parseUnsecureConfig = (config?: string): { provider: Provider; minscore: number } => {
  const result: { provider: Provider; minscore: number } = {
    provider: 'recaptcha',
    minscore: 0.5
  };

  if (!config) return result;

  for (const part of config.split(';')) {
    const [rawKey, rawValue] = part.split('=');
    if (!rawKey || !rawValue) continue;

    const key = rawKey.trim().toLowerCase();
    const value = rawValue.trim().toLowerCase();

    if (key === 'provider' && (value === 'recaptcha' || value === 'turnstile')) {
      result.provider = value;
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
  const [minScore, setMinScore] = useState('0.5');
  const [secret, setSecret] = useState('');
  const [stepId, setStepId] = useState('');
  const [status, setStatus] = useState('Ready.');
  const [isSaving, setIsSaving] = useState(false);

  const unsecureConfig = useMemo(() => {
    if (provider === 'turnstile') return 'provider=turnstile';
    const safeScore = clamp(Number(minScore) || 0.5);
    return `provider=recaptcha;minscore=${safeScore}`;
  }, [provider, minScore]);

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
            <span>Unsecure config preview</span>
            <textarea value={unsecureConfig} readOnly />
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