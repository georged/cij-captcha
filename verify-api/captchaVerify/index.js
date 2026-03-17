const { createVerifier } = require('../server');

const verifier = createVerifier();

function parseCorsOrigins() {
  return String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function buildCorsHeaders(origin) {
  const allowed = parseCorsOrigins();
  const isAllowed = !origin || allowed.length === 0 || allowed.includes(origin);

  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, authorization',
    Vary: 'Origin'
  };

  if (origin && isAllowed) {
    headers['Access-Control-Allow-Origin'] = origin;
  }

  return { headers, isAllowed };
}

module.exports = async function (context, req) {
  const origin = req.headers && (req.headers.origin || req.headers.Origin);
  const cors = buildCorsHeaders(origin);

  if (req.method === 'OPTIONS') {
    context.res = {
      status: cors.isAllowed ? 204 : 403,
      headers: cors.headers
    };
    return;
  }

  if (!cors.isAllowed) {
    context.res = {
      status: 403,
      headers: cors.headers,
      body: { success: false, reason: 'Origin not allowed by CORS policy.' }
    };
    return;
  }

  try {
    const body = req.body || {};
    const remoteip =
      (req.headers && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) ||
      (req.headers && req.headers['x-client-ip']) ||
      '';
    const userAgent = req.headers && String(req.headers['user-agent'] || '').trim() || '';

    const result = await verifier(body, remoteip, userAgent);
    context.res = {
      status: 200,
      headers: {
        ...cors.headers,
        'Content-Type': 'application/json'
      },
      body: result
    };
  } catch (error) {
    context.log.error('[verify-function] verification error', error);
    context.res = {
      status: 500,
      headers: {
        ...cors.headers,
        'Content-Type': 'application/json'
      },
      body: {
        success: false,
        reason: 'Verification service error.'
      }
    };
  }
};
