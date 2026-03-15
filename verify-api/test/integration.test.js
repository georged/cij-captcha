const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');

function createMockFetch(impl) {
  return async (url, options) => impl(url, options);
}

async function withServer({ env, fetchImpl }, fn) {
  const app = createApp({ env, fetchImpl });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });

  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function postJson(baseUrl, body) {
  const response = await fetch(`${baseUrl}/api/captcha/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'http://localhost:8000'
    },
    body: JSON.stringify(body)
  });

  const json = await response.json();
  return { status: response.status, json };
}

test('returns 400 for invalid provider', async () => {
  await withServer({
    env: { CORS_ORIGINS: 'http://localhost:8000' },
    fetchImpl: createMockFetch(async () => ({ ok: true, json: async () => ({}) }))
  }, async (baseUrl) => {
    const result = await postJson(baseUrl, {
      provider: 'unknown',
      token: 'abc'
    });

    assert.equal(result.status, 400);
    assert.equal(result.json.success, false);
  });
});

test('standard recaptcha success', async () => {
  await withServer({
    env: {
      CORS_ORIGINS: 'http://localhost:8000',
      RECAPTCHA_MODE: 'standard',
      RECAPTCHA_SECRET_KEY: 'test-secret',
      RECAPTCHA_MIN_SCORE: '0.5',
      RECAPTCHA_ACTION_THRESHOLDS: 'cij_form_submit:0.5,newsletter_signup:0.8'
    },
    fetchImpl: createMockFetch(async (url) => {
      assert.match(String(url), /google\.com\/recaptcha\/api\/siteverify/);
      return {
        ok: true,
        json: async () => ({ success: true, score: 0.9, action: 'cij_form_submit' })
      };
    })
  }, async (baseUrl) => {
    const result = await postJson(baseUrl, {
      provider: 'recaptcha',
      token: 'token-1',
      action: 'cij_form_submit'
    });

    assert.equal(result.status, 200);
    assert.equal(result.json.success, true);
    assert.equal(result.json.mode, 'standard');
  });
});

test('enterprise recaptcha action mismatch fails', async () => {
  await withServer({
    env: {
      CORS_ORIGINS: 'http://localhost:8000',
      RECAPTCHA_MODE: 'enterprise',
      RECAPTCHA_ENTERPRISE_API_KEY: 'api-key',
      RECAPTCHA_ENTERPRISE_PROJECT_ID: 'proj-1',
      RECAPTCHA_ACTION_THRESHOLDS: 'cij_form_submit:0.5',
      RECAPTCHA_MIN_SCORE: '0.5'
    },
    fetchImpl: createMockFetch(async (url) => {
      assert.match(String(url), /recaptchaenterprise\.googleapis\.com/);
      return {
        ok: true,
        json: async () => ({
          tokenProperties: {
            valid: true,
            action: 'other-action'
          },
          riskAnalysis: {
            score: 0.8
          }
        })
      };
    })
  }, async (baseUrl) => {
    const result = await postJson(baseUrl, {
      provider: 'recaptcha',
      token: 'token-2',
      action: 'cij_form_submit',
      siteKey: 'site-key-1'
    });

    assert.equal(result.status, 200);
    assert.equal(result.json.success, false);
    assert.equal(result.json.mode, 'enterprise');
    assert.match(String(result.json.reason), /mismatch/i);
  });
});

test('request actionThresholds override enforces threshold by action', async () => {
  await withServer({
    env: {
      CORS_ORIGINS: 'http://localhost:8000',
      RECAPTCHA_MODE: 'standard',
      RECAPTCHA_SECRET_KEY: 'test-secret',
      RECAPTCHA_MIN_SCORE: '0.1'
    },
    fetchImpl: createMockFetch(async () => ({
      ok: true,
      json: async () => ({ success: true, score: 0.6, action: 'checkout' })
    }))
  }, async (baseUrl) => {
    const result = await postJson(baseUrl, {
      provider: 'recaptcha',
      token: 'token-4',
      action: 'checkout',
      actionThresholds: {
        checkout: 0.7
      }
    });

    assert.equal(result.status, 200);
    assert.equal(result.json.success, false);
    assert.match(String(result.json.reason), /below threshold 0.7/i);
  });
});

test('turnstile failure returns invalid reason', async () => {
  await withServer({
    env: {
      CORS_ORIGINS: 'http://localhost:8000',
      TURNSTILE_SECRET_KEY: 'turnstile-secret'
    },
    fetchImpl: createMockFetch(async (url) => {
      assert.match(String(url), /challenges\.cloudflare\.com\/turnstile/);
      return {
        ok: true,
        json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] })
      };
    })
  }, async (baseUrl) => {
    const result = await postJson(baseUrl, {
      provider: 'turnstile',
      token: 'token-3'
    });

    assert.equal(result.status, 200);
    assert.equal(result.json.success, false);
    assert.equal(result.json.provider, 'turnstile');
  });
});