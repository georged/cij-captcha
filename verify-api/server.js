const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '.env') });

function asBool(value) {
  return value === true || value === 'true';
}

function parseScore(value, fallback) {
  const parsed = Number(value);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

function validateRequestBody(body) {
  if (!body || typeof body !== 'object') {
    return 'Request body must be a JSON object.';
  }

  const provider = String(body.provider || '').trim().toLowerCase();
  if (provider !== 'recaptcha' && provider !== 'turnstile') {
    return 'provider must be either recaptcha or turnstile.';
  }

  const token = String(body.token || '').trim();
  if (!token) {
    return 'token is required.';
  }

  return null;
}

async function verifyRecaptchaStandard({ token, action, remoteip, env, fetchImpl }) {
  const secret = String(env.RECAPTCHA_SECRET_KEY || '').trim();
  if (!secret) {
    throw new Error('RECAPTCHA_SECRET_KEY is not configured.');
  }

  const params = new URLSearchParams();
  params.set('secret', secret);
  params.set('response', token);
  if (remoteip) params.set('remoteip', remoteip);

  const response = await fetchImpl('https://www.google.com/recaptcha/api/siteverify', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });

  if (!response.ok) {
    throw new Error(`reCAPTCHA siteverify returned ${response.status}.`);
  }

  const result = await response.json();
  const expectedAction = String(env.RECAPTCHA_EXPECTED_ACTION || '').trim();
  const submittedAction = String(action || '').trim();
  const minScore = parseScore(env.RECAPTCHA_MIN_SCORE, 0.5);

  if (!asBool(result.success)) {
    return {
      success: false,
      reason: 'reCAPTCHA token is invalid.',
      provider: 'recaptcha',
      score: typeof result.score === 'number' ? result.score : null,
      errors: result['error-codes'] || []
    };
  }

  if (expectedAction && submittedAction && result.action && result.action !== submittedAction) {
    return {
      success: false,
      reason: 'reCAPTCHA action mismatch.',
      provider: 'recaptcha',
      score: typeof result.score === 'number' ? result.score : null,
      errors: result['error-codes'] || []
    };
  }

  const score = typeof result.score === 'number' ? result.score : null;
  if (score !== null && score < minScore) {
    return {
      success: false,
      reason: `reCAPTCHA score ${score} is below minimum ${minScore}.`,
      provider: 'recaptcha',
      score,
      errors: result['error-codes'] || []
    };
  }

  return {
    success: true,
    provider: 'recaptcha',
    mode: 'standard',
    score,
    errors: result['error-codes'] || []
  };
}

async function verifyRecaptchaEnterprise({ token, action, siteKey, remoteip, env, fetchImpl }) {
  const apiKey = String(env.RECAPTCHA_ENTERPRISE_API_KEY || '').trim();
  const projectId = String(env.RECAPTCHA_ENTERPRISE_PROJECT_ID || '').trim();
  const expectedAction = String(env.RECAPTCHA_EXPECTED_ACTION || '').trim();
  const minScore = parseScore(env.RECAPTCHA_MIN_SCORE, 0.5);
  const effectiveSiteKey = String(siteKey || env.RECAPTCHA_SITE_KEY || '').trim();
  const effectiveAction = String(action || expectedAction).trim();

  if (!apiKey) {
    throw new Error('RECAPTCHA_ENTERPRISE_API_KEY is not configured.');
  }
  if (!projectId) {
    throw new Error('RECAPTCHA_ENTERPRISE_PROJECT_ID is not configured.');
  }
  if (!effectiveSiteKey) {
    throw new Error('siteKey is required for reCAPTCHA Enterprise verification.');
  }

  const endpoint = `https://recaptchaenterprise.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/assessments?key=${encodeURIComponent(apiKey)}`;
  const event = {
    token,
    siteKey: effectiveSiteKey
  };
  if (effectiveAction) {
    event.expectedAction = effectiveAction;
  }
  if (remoteip) {
    event.userIpAddress = remoteip;
  }

  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ event })
  });

  if (!response.ok) {
    throw new Error(`reCAPTCHA Enterprise assessments returned ${response.status}.`);
  }

  const result = await response.json();
  const tokenProperties = result && result.tokenProperties ? result.tokenProperties : {};
  const riskAnalysis = result && result.riskAnalysis ? result.riskAnalysis : {};
  const receivedAction = String(tokenProperties.action || '').trim();
  const score = typeof riskAnalysis.score === 'number' ? riskAnalysis.score : null;

  if (!asBool(tokenProperties.valid)) {
    return {
      success: false,
      reason: `reCAPTCHA Enterprise token is invalid (${tokenProperties.invalidReason || 'unknown'}).`,
      provider: 'recaptcha',
      mode: 'enterprise',
      score,
      errors: tokenProperties.invalidReason ? [tokenProperties.invalidReason] : []
    };
  }

  if (effectiveAction && receivedAction && receivedAction !== effectiveAction) {
    return {
      success: false,
      reason: 'reCAPTCHA Enterprise action mismatch.',
      provider: 'recaptcha',
      mode: 'enterprise',
      score,
      errors: []
    };
  }

  if (score !== null && score < minScore) {
    return {
      success: false,
      reason: `reCAPTCHA score ${score} is below minimum ${minScore}.`,
      provider: 'recaptcha',
      mode: 'enterprise',
      score,
      errors: []
    };
  }

  return {
    success: true,
    provider: 'recaptcha',
    mode: 'enterprise',
    score,
    errors: []
  };
}

async function verifyRecaptcha({ token, action, siteKey, remoteip, env, fetchImpl }) {
  const mode = String(env.RECAPTCHA_MODE || 'standard').trim().toLowerCase();
  if (mode === 'enterprise') {
    return verifyRecaptchaEnterprise({ token, action, siteKey, remoteip, env, fetchImpl });
  }

  return verifyRecaptchaStandard({ token, action, remoteip, env, fetchImpl });
}

async function verifyTurnstile({ token, remoteip, env, fetchImpl }) {
  const secret = String(env.TURNSTILE_SECRET_KEY || '').trim();
  if (!secret) {
    throw new Error('TURNSTILE_SECRET_KEY is not configured.');
  }

  const body = {
    secret,
    response: token
  };
  if (remoteip) body.remoteip = remoteip;

  const response = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Turnstile siteverify returned ${response.status}.`);
  }

  const result = await response.json();
  if (!asBool(result.success)) {
    return {
      success: false,
      reason: 'Turnstile token is invalid.',
      provider: 'turnstile',
      errors: result['error-codes'] || []
    };
  }

  return {
    success: true,
    provider: 'turnstile',
    errors: result['error-codes'] || []
  };
}

function createApp(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const app = express();
  const verifier = createVerifier({ env, fetchImpl });

  const corsOrigins = String(env.CORS_ORIGINS || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

  app.use(cors({
    origin(origin, callback) {
      if (!origin || corsOrigins.length === 0 || corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error('Origin not allowed by CORS policy.'));
    }
  }));
  app.use(express.json({ limit: '20kb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.post('/api/captcha/verify', async (req, res) => {
    try {
      const bodyError = validateRequestBody(req.body);
      if (bodyError) {
        res.status(400).json({ success: false, reason: bodyError });
        return;
      }

      const forwardedFor = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      const remoteip = forwardedFor || req.ip;
      const result = await verifier(req.body, remoteip);

      res.json(result);
    } catch (error) {
      console.error('[verify-api] verification error', error);
      res.status(500).json({
        success: false,
        reason: 'Verification service error.'
      });
    }
  });

  return app;
}

function createVerifier(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;

  return async function verify(body, remoteip) {
    const provider = String(body.provider || '').trim().toLowerCase();
    const token = String(body.token || '').trim();
    const action = String(body.action || '').trim();
    const siteKey = String(body.siteKey || '').trim();

    return provider === 'recaptcha'
      ? verifyRecaptcha({ token, action, siteKey, remoteip, env, fetchImpl })
      : verifyTurnstile({ token, remoteip, env, fetchImpl });
  };
}

function startServer() {
  const app = createApp();
  const port = Number(process.env.PORT || 8787);
  app.listen(port, () => {
    console.log(`[verify-api] listening on http://localhost:${port}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createApp,
  createVerifier,
  startServer
};
