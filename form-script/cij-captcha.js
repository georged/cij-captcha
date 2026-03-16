/**
 * cij-captcha.js
 * Reusable CIJ CAPTCHA helper.
 *
 * Usage:
 *   <script src="https://your-cdn/cij-captcha.js"></script>
 *   <script>
 *     window.CijCaptcha.init({ ...settings });
 *   </script>
 *
 * Minimal examples:
 *   // Turnstile (minimum)
 *   window.CijCaptcha.init({
 *     provider: 'turnstile',
 *     siteKey: 'YOUR_TURNSTILE_SITE_KEY'
 *   });
 *
 *   // reCAPTCHA v3 (minimum)
 *   window.CijCaptcha.init({
 *     provider: 'recaptcha',
 *     siteKey: 'YOUR_RECAPTCHA_SITE_KEY'
 *   });
 *
 * Public init settings:
 *   provider: 'recaptcha' | 'turnstile'     // default 'recaptcha'
 *   siteKey: string                         // site key (public), required
 *   formId?: string                         // optional form identifier override
 *   action: string                          // reCAPTCHA only; default 'cij_form_submit'
 *   enableDebugLogs: boolean                // default false
 *   eagerLoad: boolean                      // default true
 *   recaptcha?: {
 *     mode?: 'standard'|'enterprise'        // default 'standard'
 *   }
 *   preSubmit?: {
 *     enabled?: boolean                     // default false
 *     verifyEndpoint?: string               // required when enabled
 *     timeout?: number                      // default 8000
 *     failureMessage?: string               // optional override for server validation failures
 *   }
 *   turnstile?: {
 *     size?: 'normal'|'compact'|'invisible',               // default 'normal'
 *     execution?: 'execute'|'render',                      // default 'execute'
 *     appearance?: 'always'|'execute'|'interaction-only',  // default 'execute'
 *     theme?: 'auto'|'light'|'dark',                       // default 'auto'
 *     tokenReuseTimeout?: number                           // default 240000 (4 minutes)             
 *   }
 */
(function (global) {
  'use strict';

  // If the script was already loaded, keep the existing API instance.
  if (global.CijCaptcha && global.CijCaptcha.__cijCaptchaLoaded) {
    return;
  }

  var CIJ_FIELD_NAME = 'captcha-response';
  var CIJ_ACTION_FIELD_NAME = 'captcha-action';
  var CIJ_FORM_ID_FIELD_NAME = 'captcha-formid';
  var CIJ_FORM_SELECTOR = 'form.marketingForm';
  var CIJ_SUBMIT_EVENT = 'd365mkt-formsubmit';

  var DEFAULTS = {
    provider: 'recaptcha',
    siteKey: '',
    formId: '',
    action: 'cij_form_submit',
    enableDebugLogs: false,
    eagerLoad: true,
    recaptcha: {
      mode: 'standard'
    },
    preSubmit: {
      enabled: false,
      verifyEndpoint: '',
      timeout: 8000,
      failureMessage: 'Captcha verification failed. Please try again.'
    },
    turnstile: {
      size: 'normal',
      execution: 'execute',
      appearance: 'execute',
      theme: 'auto',
      tokenReuseTimeout: 240000
    }
  };

  function pickAllowed(value, allowedValues, fallback) {
    for (var i = 0; i < allowedValues.length; i++) {
      if (value === allowedValues[i]) return value;
    }
    return fallback;
  }

  function normalizeRecaptchaSettings(input, defaults) {
    var source = input || {};

    return {
      mode: pickAllowed(source.mode, ['standard', 'enterprise'], defaults.mode)
    };
  }

  function normalizePreSubmitSettings(input, defaults) {
    var source = input || {};
    var timeout = defaults.timeout;
    if (typeof source.timeout === 'number' && source.timeout > 0) {
      timeout = source.timeout;
    }

    return {
      enabled: !!source.enabled,
      verifyEndpoint: String(source.verifyEndpoint || '').trim(),
      timeout: timeout,
      failureMessage: typeof source.failureMessage === 'string'
        ? String(source.failureMessage).trim()
        : '',
      fallbackFailureMessage: defaults.fallbackFailureMessage || defaults.failureMessage
    };
  }

  function normalizeTurnstileSettings(input, defaults) {
    var source = input || {};

    var normalizedTimeout = defaults.tokenReuseTimeout;
    if (typeof source.tokenReuseTimeout === 'number' && source.tokenReuseTimeout > 0) {
      normalizedTimeout = source.tokenReuseTimeout;
    }

    return {
      size: pickAllowed(source.size, ['normal', 'compact', 'invisible'], defaults.size),
      execution: pickAllowed(source.execution, ['execute', 'render'], defaults.execution),
      appearance: pickAllowed(
        source.appearance,
        ['always', 'execute', 'interaction-only'],
        defaults.appearance
      ),
      theme: pickAllowed(source.theme, ['auto', 'light', 'dark'], defaults.theme),
      tokenReuseTimeout: normalizedTimeout
    };
  }

  function mergeSettings(base, override) {
    var result = {
      provider: base.provider,
      siteKey: base.siteKey,
      formId: base.formId,
      action: base.action,
      enableDebugLogs: base.enableDebugLogs,
      eagerLoad: base.eagerLoad,
      recaptcha: normalizeRecaptchaSettings(null, base.recaptcha),
      preSubmit: normalizePreSubmitSettings(null, base.preSubmit),
      turnstile: normalizeTurnstileSettings(null, base.turnstile)
    };

    if (!override) return result;

    for (var key in override) {
      if (!Object.prototype.hasOwnProperty.call(override, key)) continue;
      if (key === 'turnstile' || key === 'preSubmit' || key === 'recaptcha') continue;
      result[key] = override[key];
    }

    result.recaptcha = normalizeRecaptchaSettings(override.recaptcha, result.recaptcha);
    result.preSubmit = normalizePreSubmitSettings(override.preSubmit, result.preSubmit);
    result.turnstile = normalizeTurnstileSettings(override.turnstile, result.turnstile);

    return result;
  }

  function createInstance(settings) {
    var config = mergeSettings(DEFAULTS, settings);

    if (!config.siteKey) {
      throw new Error('[CIJ Captcha] Missing required setting: siteKey');
    }

    var state = {
      loadPromise: null,
      turnstileWidgets: [],
      observer: null,
      initialized: false
    };

    function debug(...args) {
      if (!config.enableDebugLogs) return;
      console.log('[CIJ Captcha]', ...args);
    }

    function loadRecaptchaScript() {
      if (state.loadPromise) return state.loadPromise;
      state.loadPromise = new Promise(function (resolve, reject) {
        if (global.grecaptcha &&
          ((config.recaptcha.mode === 'enterprise' && global.grecaptcha.enterprise && global.grecaptcha.enterprise.execute) ||
            (config.recaptcha.mode !== 'enterprise' && global.grecaptcha.execute))) {
          if (config.recaptcha.mode === 'enterprise') {
            global.grecaptcha.enterprise.ready(function () { resolve(); });
          } else {
            global.grecaptcha.ready(function () { resolve(); });
          }
          return;
        }
        var s = document.createElement('script');
        var recaptchaBase = config.recaptcha.mode === 'enterprise'
          ? 'https://www.google.com/recaptcha/enterprise.js?render='
          : 'https://www.google.com/recaptcha/api.js?render=';
        s.src = recaptchaBase + encodeURIComponent(config.siteKey);
        s.async = true;
        s.onload = function () {
          if (config.recaptcha.mode === 'enterprise') {
            global.grecaptcha.enterprise.ready(function () { resolve(); });
          } else {
            global.grecaptcha.ready(function () { resolve(); });
          }
        };
        s.onerror = function () {
          state.loadPromise = null;
          reject(new Error('[CIJ Captcha] Failed to load reCAPTCHA script.'));
        };
        document.head.appendChild(s);
      });
      return state.loadPromise;
    }

    function getRecaptchaToken() {
      return loadRecaptchaScript().then(function () {
        if (config.recaptcha.mode === 'enterprise') {
          if (!global.grecaptcha || !global.grecaptcha.enterprise || !global.grecaptcha.enterprise.execute) {
            throw new Error('[CIJ Captcha] reCAPTCHA Enterprise API is not available.');
          }
          return global.grecaptcha.enterprise.execute(config.siteKey, { action: config.action });
        }

        return global.grecaptcha.execute(config.siteKey, { action: config.action });
      });
    }

    function loadTurnstileScript() {
      if (state.loadPromise) return state.loadPromise;
      state.loadPromise = new Promise(function (resolve, reject) {
        if (global.turnstile) {
          resolve();
          return;
        }
        var s = document.createElement('script');
        s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        s.async = true;
        s.defer = true;
        s.onload = function () { resolve(); };
        s.onerror = function () {
          state.loadPromise = null;
          reject(new Error('[CIJ Captcha] Failed to load Turnstile script.'));
        };
        document.head.appendChild(s);
      });
      return state.loadPromise;
    }

    function getOrCreateTurnstileWidget(formEl, resolve, reject) {
      for (var i = 0; i < state.turnstileWidgets.length; i++) {
        if (state.turnstileWidgets[i].formEl === formEl) {
          state.turnstileWidgets[i].resolve = resolve;
          state.turnstileWidgets[i].reject = reject;
          return state.turnstileWidgets[i];
        }
      }

      var container = document.createElement('div');
      var captchaBlock = document.createElement('div');
      captchaBlock.className = 'submitButtonWrapper';
      captchaBlock.setAttribute('data-cij-captcha-turnstile', 'true');
      captchaBlock.appendChild(container);

      var submitWrapper = formEl.querySelector('div.submitButtonWrapper');
      if (submitWrapper && submitWrapper.parentNode) {
        submitWrapper.parentNode.insertBefore(captchaBlock, submitWrapper);
      } else {
        formEl.appendChild(captchaBlock);
      }

      var entry = {
        formEl: formEl,
        widgetId: null,
        resolve: resolve,
        reject: reject,
        token: null,
        tokenAt: 0
      };
      state.turnstileWidgets.push(entry);

      entry.widgetId = global.turnstile.render(container, {
        sitekey: config.siteKey,
        'response-field': false,
        size: config.turnstile.size,
        execution: config.turnstile.execution,
        appearance: config.turnstile.appearance,
        theme: config.turnstile.theme,
        callback: function (token) {
          entry.token = token;
          entry.tokenAt = Date.now();

          var captchaField = entry.formEl.querySelector('input[name="' + CIJ_FIELD_NAME + '"]');
          if (captchaField) captchaField.value = token;
          if (entry.resolve) entry.resolve(token);
        },
        'error-callback': function (code) {
          console.error('[CIJ Captcha] Turnstile error:', code);
          if (entry.reject) entry.reject(new Error('[CIJ Captcha] Turnstile error: ' + code));
        },
        'expired-callback': function () {
          entry.token = null;
          entry.tokenAt = 0;

          var captchaField = entry.formEl.querySelector('input[name="' + CIJ_FIELD_NAME + '"]');
          if (captchaField) captchaField.value = '';

          entry.resolve = null;
          entry.reject = null;
        }
      });

      return entry;
    }

    function placeErrorElement(formEl, errorEl) {
      var turnstileBlock = formEl.querySelector('[data-cij-captcha-turnstile="true"]');
      var submitWrappers = formEl.querySelectorAll('div.submitButtonWrapper');
      var submitWrapper = null;

      for (var i = 0; i < submitWrappers.length; i++) {
        if (submitWrappers[i] !== turnstileBlock) {
          submitWrapper = submitWrappers[i];
          break;
        }
      }

      if (submitWrapper) {
        var submitControl = submitWrapper.querySelector('button[type="submit"], input[type="submit"]');
        if (submitControl && submitControl.parentNode === submitWrapper) {
          submitWrapper.insertBefore(errorEl, submitControl);
        } else {
          submitWrapper.insertBefore(errorEl, submitWrapper.firstChild);
        }
        return;
      }

      formEl.appendChild(errorEl);
    }

    function getTurnstileToken(formEl, options) {
      var forceFresh = !!(options && options.forceFresh);
      return loadTurnstileScript().then(function () {
        return new Promise(function (resolve, reject) {
          var entry = getOrCreateTurnstileWidget(formEl, resolve, reject);

          if (
            !forceFresh &&
            config.turnstile.execution === 'render' &&
            entry.token &&
            entry.tokenAt &&
            (Date.now() - entry.tokenAt) < config.turnstile.tokenReuseTimeout
          ) {
            resolve(entry.token);
            return;
          }

          entry.token = null;
          entry.tokenAt = 0;
          global.turnstile.reset(entry.widgetId);
          if (config.turnstile.execution === 'execute') {
            global.turnstile.execute(entry.widgetId);
          }
        });
      });
    }

    function getToken(formEl, options) {
      return config.provider === 'turnstile'
        ? getTurnstileToken(formEl, options)
        : getRecaptchaToken();
    }

    function getErrorElement(formEl) {
      var errorEl = formEl.querySelector('[data-cij-captcha-error]');
      if (errorEl) {
        placeErrorElement(formEl, errorEl);
        return errorEl;
      }

      errorEl = document.createElement('div');
      errorEl.setAttribute('data-cij-captcha-error', 'true');
      errorEl.style.color = '#b91c1c';
      errorEl.style.fontSize = '14px';
      errorEl.style.marginTop = '8px';
      errorEl.style.marginBottom = '8px';
      errorEl.style.display = 'none';
      placeErrorElement(formEl, errorEl);
      return errorEl;
    }

    function setError(formEl, message) {
      var errorEl = getErrorElement(formEl);
      errorEl.textContent =
        message ||
        config.preSubmit.failureMessage ||
        config.preSubmit.fallbackFailureMessage;
      errorEl.style.display = 'block';
    }

    function clearError(formEl) {
      var errorEl = formEl.querySelector('[data-cij-captcha-error]');
      if (!errorEl) return;
      errorEl.textContent = '';
      errorEl.style.display = 'none';
    }

    function verifyPreSubmitToken(formEl, token) {
      if (!config.preSubmit.enabled) return Promise.resolve();
      if (!config.preSubmit.verifyEndpoint) {
        return Promise.reject(new Error('[CIJ Captcha] preSubmit.verifyEndpoint is required when preSubmit.enabled=true.'));
      }

      var effectiveFormId = resolveFormId(formEl);

      var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timeoutId = null;
      if (controller) {
        timeoutId = setTimeout(function () {
          controller.abort();
        }, config.preSubmit.timeout);
      }

      var payload = {
        provider: config.provider,
        token: token,
        action: config.action,
        formId: effectiveFormId,
        siteKey: config.siteKey,
        recaptchaMode: config.recaptcha.mode
      };

      var request = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload)
      };
      if (controller) request.signal = controller.signal;

      return fetch(config.preSubmit.verifyEndpoint, request)
        .catch(function (error) {
          // Endpoint is unreachable (network error or timeout). Allow submit to continue.
          var reachabilityError = new Error('[CIJ Captcha] Pre-submit verification endpoint is unreachable.');
          reachabilityError.cijAllowProceed = true;
          reachabilityError.cause = error;
          throw reachabilityError;
        })
        .then(function (response) {
          if (!response.ok) {
            return response.json()
              .catch(function () {
                return null;
              })
              .then(function (json) {
                var reason =
                  config.preSubmit.failureMessage ||
                  (json && json.reason ? String(json.reason) : '') ||
                  '[CIJ Captcha] Pre-submit verification endpoint returned ' + response.status + '.';
                throw new Error(reason);
              });
          }
          return response.json();
        })
        .then(function (json) {
          if (!json || (json.success !== true && json.valid !== true)) {
            var reason =
              config.preSubmit.failureMessage ||
              (json && json.reason ? String(json.reason) : '') ||
              config.preSubmit.fallbackFailureMessage;
            throw new Error(reason);
          }
        })
        .finally(function () {
          if (timeoutId) clearTimeout(timeoutId);
        });
    }

    function isPreSubmitReachabilityError(err) {
      if (!err) return false;
      if (err.cijAllowProceed === true) return true;
      var name = String(err.name || '').toLowerCase();
      if (name === 'aborterror') return true;
      var message = String(err.message || '').toLowerCase();
      return message.indexOf('failed to fetch') >= 0 || message.indexOf('network') >= 0;
    }

    function injectHiddenField(formEl) {
      var input = formEl.querySelector('input[name="' + CIJ_FIELD_NAME + '"]');
      if (!input) {
        input = document.createElement('input');
        input.type = 'hidden';
        input.name = CIJ_FIELD_NAME;
        input.value = '';
        formEl.appendChild(input);
      }
      return input;
    }

    function injectActionField(formEl) {
      var input = formEl.querySelector('input[name="' + CIJ_ACTION_FIELD_NAME + '"]');
      if (!input) {
        input = document.createElement('input');
        input.type = 'hidden';
        input.name = CIJ_ACTION_FIELD_NAME;
        input.value = '';
        formEl.appendChild(input);
      }
      return input;
    }

    function injectFormIdField(formEl) {
      var input = formEl.querySelector('input[name="' + CIJ_FORM_ID_FIELD_NAME + '"]');
      if (!input) {
        input = document.createElement('input');
        input.type = 'hidden';
        input.name = CIJ_FORM_ID_FIELD_NAME;
        input.value = '';
        formEl.appendChild(input);
      }
      return input;
    }

    function resolveFormId(formEl) {
      var fromConfig = String(config.formId || '').trim();
      if (fromConfig) return fromConfig;

      // CIJ markup stores the canonical form id on the containing form block div.
      var holder = formEl.closest ? formEl.closest('div[data-form-id]') : null;
      var holderFormId = holder ? String(holder.getAttribute('data-form-id') || '').trim() : '';
      if (holderFormId) return holderFormId;

      return '';
    }

    function getFormFromCijEvent(event) {
      var target = event && event.target;
      if (!target) return null;
      if (target.tagName === 'FORM') return target;
      if (target.querySelector) {
        var nested = target.querySelector('form');
        if (nested) return nested;
      }
      if (target.closest) return target.closest('form');
      return null;
    }

    function onCijFormSubmit(event) {
      var formEl = getFormFromCijEvent(event);
      if (!formEl || !formEl._cijCaptchaWired) return;
      if (formEl._cijCaptchaResubmitting) return;

      var captchaField = injectHiddenField(formEl);
      var actionField = injectActionField(formEl);
      var formIdField = injectFormIdField(formEl);
      actionField.value = String(config.action || '').trim();
      formIdField.value = resolveFormId(formEl);
      if (captchaField && captchaField.value) return;

      event.preventDefault();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();

      if (formEl._cijCaptchaSubmitPending) return;
      formEl._cijCaptchaSubmitPending = true;
      clearError(formEl);
      captchaField.value = '';

      debug('Intercepted submit, obtaining token...');
      getToken(formEl)
        .then(function (token) {
          if (!config.preSubmit.enabled) {
            debug('Pre-submit verification disabled; using initial token for submission.');
            return token;
          }

          debug('Pre-submit verification enabled; verifying token before submit.');
          return verifyPreSubmitToken(formEl, token)
            .then(function () {
              debug('Pre-submit token verified; requesting fresh token for backend submission.');
              // Provider verification tokens are single-use; submit a fresh token to backend.
              return getToken(formEl, { forceFresh: true });
            })
            .catch(function (err) {
              if (isPreSubmitReachabilityError(err)) {
                console.warn('[CIJ Captcha] Pre-submit verification skipped because endpoint is unreachable. Proceeding with submit.', err);
                // The token was not consumed by server-side pre-submit verification, so it can be submitted as-is.
                return token;
              }
              throw err;
            });
        })
        .then(function (submissionToken) {
          debug('Submission token ready; proceeding with form submit.');
          captchaField.value = submissionToken;
        })
        .then(function () {
          formEl._cijCaptchaSubmitPending = false;
          formEl._cijCaptchaResubmitting = true;

          if (formEl.requestSubmit) formEl.requestSubmit();
          else formEl.submit();

          setTimeout(function () {
            formEl._cijCaptchaResubmitting = false;
          }, 0);
        })
        .catch(function (err) {
          console.error('[CIJ Captcha] Could not obtain CAPTCHA token:', err);
          formEl._cijCaptchaSubmitPending = false;

          if (config.preSubmit.enabled) {
            setError(formEl, err && err.message ? err.message : null);
            return;
          }

          formEl._cijCaptchaResubmitting = true;

          if (formEl.requestSubmit) formEl.requestSubmit();
          else formEl.submit();

          setTimeout(function () {
            formEl._cijCaptchaResubmitting = false;
          }, 0);
        });
    }

    function onCijAfterSubmit(event) {
      debug('After submit event:', event);
    }

    function wireForm(formEl) {
      injectHiddenField(formEl);

      if (config.provider === 'turnstile') {
        loadTurnstileScript().then(function () {
          getOrCreateTurnstileWidget(formEl, null, null);
        });
      }
    }

    function findAndWireForms(root) {
      var forms = (root || document).querySelectorAll(CIJ_FORM_SELECTOR);
      forms.forEach(function (formEl) {
        if (!formEl._cijCaptchaWired) {
          formEl._cijCaptchaWired = true;
          wireForm(formEl);
          debug('Wired form:', formEl);
        }
      });
    }

    function observeForForms() {
      findAndWireForms(document);

      state.observer = new MutationObserver(function (mutations) {
        mutations.forEach(function (mutation) {
          mutation.addedNodes.forEach(function (node) {
            if (node.nodeType !== 1) return;
            if (node.shadowRoot) findAndWireForms(node.shadowRoot);
            findAndWireForms(node);
          });
        });
      });

      var observeRoot = document.body || document.documentElement;
      if (!observeRoot) return;
      state.observer.observe(observeRoot, { childList: true, subtree: true });
    }

    function init() {
      if (state.initialized) {
        debug('Already initialized; skipping duplicate init.');
        return api;
      }

      if (config.provider !== 'turnstile' && config.provider !== 'recaptcha') {
        throw new Error('[CIJ Captcha] Invalid provider. Use "turnstile" or "recaptcha".');
      }
      if (!config.siteKey) {
        throw new Error('[CIJ Captcha] siteKey is required.');
      }
      if (config.preSubmit.enabled && !config.preSubmit.verifyEndpoint) {
        throw new Error('[CIJ Captcha] preSubmit.verifyEndpoint is required when preSubmit.enabled=true.');
      }

      var eagerLoad = config.provider === 'turnstile' ? loadTurnstileScript : loadRecaptchaScript;
      if (config.eagerLoad) eagerLoad().catch(function (err) { console.warn(err); });

      document.addEventListener(CIJ_SUBMIT_EVENT, onCijFormSubmit);
      observeForForms();

      state.initialized = true;
      debug('Initialized with settings:', config);
      return api;
    }

    function destroy() {
      if (!state.initialized) return;

      document.removeEventListener(CIJ_SUBMIT_EVENT, onCijFormSubmit);

      if (state.observer) {
        state.observer.disconnect();
        state.observer = null;
      }

      state.initialized = false;
    }

    var api = {
      init: init,
      destroy: destroy,
      getSettings: function () { return config; }
    };

    return api;
  }

  var rootApi = {
    create: function (settings) {
      return createInstance(settings);
    },
    init: function (settings) {
      if (!rootApi._defaultInstance) {
        rootApi._defaultInstance = createInstance(settings);
      }
      return rootApi._defaultInstance.init();
    },
    version: '2.0.0'
  };

  rootApi.__cijCaptchaLoaded = true;

  global.CijCaptcha = rootApi;
})(window);
