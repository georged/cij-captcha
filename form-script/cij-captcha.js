/**
 * cij-captcha.js
 * ───────────────────────────────────────────────────────────────────────────
 * Add this script inside the Customer Insights Journeys form editor under
 *   Form → Custom scripts  (or in a <script> block on the page hosting the embed).
 *
 * Supports two CAPTCHA providers:
 *   'recaptcha'  — Google reCAPTCHA v3 (score-based, always invisible; no visible widget)
 *   'turnstile'  — Cloudflare Turnstile (pass/fail, privacy-friendly; widget appearance
 *                  is configurable via TURNSTILE_SIZE / TURNSTILE_EXECUTION / TURNSTILE_APPEARANCE)
 *
 * What it does
 * ────────────
 *  1. Waits for the CIJ <form> to appear inside the <div data-form-id="…"> embed.
 *  2. Injects a hidden field (name depends on provider) into the form.
 *  3. Loads the chosen provider's script (once).
 *  4. Intercepts the form submit, obtains a fresh token, populates the hidden
 *     field, then re-submits.
 *
 * The Dataverse plugin (CaptchaValidationPlugin.cs) reads that field from the
 * msdynmkt_validateformsubmission message and verifies it server-side.
 *
 * Configuration
 * ─────────────
 *  CAPTCHA_PROVIDER : 'recaptcha' | 'turnstile'
 *  CAPTCHA_SITE_KEY : your public / site key for the chosen provider
 *  CAPTCHA_ACTION   : action label (reCAPTCHA v3 only; alphanumeric + /)
 * ───────────────────────────────────────────────────────────────────────────
 */
(function () {
  'use strict';

  // ── ✏️  Configuration – edit these values ──────────────────────────────────

  // Which CAPTCHA provider to use.
  //   'recaptcha' — Google reCAPTCHA v3. Always fully invisible; analyses
  //                 behaviour and returns a fraud score (0.0 = bot, 1.0 = human).
  //                 The server-side plugin rejects submissions below a threshold
  //                 (default 0.5, configurable via plug-in Unsecure Config).
  //   'turnstile' — Cloudflare Turnstile. Privacy-friendly alternative; no score,
  //                 just pass/fail. Widget appearance is controlled below.
  var CAPTCHA_PROVIDER = 'recaptcha';            // 'recaptcha' | 'turnstile'

  // Your PUBLIC site key (safe to include in client-side code).
  //   reCAPTCHA → https://www.google.com/recaptcha/admin
  //   Turnstile  → https://dash.cloudflare.com/?to=/:account/turnstile
  var CAPTCHA_SITE_KEY = 'YOUR_CAPTCHA_SITE_KEY';

  // Action name attached to each reCAPTCHA v3 token.
  // Appears in the Google reCAPTCHA Admin Console for analytics/filtering.
  // Allowed characters: alphanumeric, hyphens, slashes.
  // Ignored entirely when CAPTCHA_PROVIDER === 'turnstile'.
  var CAPTCHA_ACTION = 'cij_form_submit';

  // ── Turnstile widget options (only used when CAPTCHA_PROVIDER = 'turnstile') ─

  // TURNSTILE_SIZE — physical dimensions / mode of the rendered widget.
  //   'normal'    — full-width tick-box (300 × 65 px). Shows "Verifying…" then
  //                 a green tick. Most recognisable UX.
  //   'compact'   — smaller tick-box (130 × 120 px). Good for tight layouts.
  //   'invisible' — no visible widget at all. Cloudflare may still surface an
  //                 interactive challenge in a modal overlay if it is not
  //                 confident the visitor is human.
  //
  // Pair with TURNSTILE_EXECUTION:
  //   'invisible' size  → use execution: 'execute'  (triggered on submit)
  //   'normal'/'compact' → use execution: 'render'   (auto-runs on page load)
  var TURNSTILE_SIZE = 'invisible';              // 'normal' | 'compact' | 'invisible'

  // TURNSTILE_EXECUTION — when the challenge is initiated.
  //   'execute' — challenge runs only when turnstile.execute() is called
  //               programmatically. Use with size: 'invisible' so the
  //               challenge fires at form submit time, not on page load.
  //   'render'  — challenge runs automatically as soon as the widget is
  //               rendered. Use with size: 'normal' or 'compact'.
  var TURNSTILE_EXECUTION = 'execute';           // 'execute' | 'render'

  // TURNSTILE_APPEARANCE — controls when the widget container is made visible.
  //   'always'           — widget is always shown (useful for 'normal'/'compact').
  //   'execute'          — widget appears only when execute() is called.
  //   'interaction-only' — widget stays hidden unless Cloudflare requires the
  //                        user to solve an interactive challenge. Recommended
  //                        for invisible mode — zero UI unless needed.
  var TURNSTILE_APPEARANCE = 'interaction-only'; // 'always' | 'execute' | 'interaction-only'

  // TURNSTILE_THEME — colour scheme of the widget UI (no effect in invisible mode).
  //   'auto'  — follows the user's OS light/dark-mode preference.
  //   'light' — always light background.
  //   'dark'  — always dark background.
  var TURNSTILE_THEME = 'auto';                  // 'auto' | 'light' | 'dark'

  // ──────────────────────────────────────────────────────────────────────────

  // Hidden field names expected by the server-side plugin.
  // These must match the field name set on the hidden field in the CIJ form editor.
  var FIELD_NAME_RECAPTCHA = 'g-recaptcha-response';  // Google reCAPTCHA v3
  var FIELD_NAME_TURNSTILE = 'cf-turnstile-response'; // Cloudflare Turnstile

  // Resolved once at boot — no repeated ternary throughout the code
  var fieldName   = CAPTCHA_PROVIDER === 'turnstile' ? FIELD_NAME_TURNSTILE : FIELD_NAME_RECAPTCHA;
  var loadPromise = null;

  // Registry of Turnstile widgets — one per <form> element, reused across submits
  var turnstileWidgets = [];

  // ═══════════════════════════════════════════════════════════════════════════
  // PROVIDER: Google reCAPTCHA v3
  // ═══════════════════════════════════════════════════════════════════════════

  function loadRecaptchaScript() {
    if (loadPromise) return loadPromise;
    loadPromise = new Promise(function (resolve, reject) {
      if (window.grecaptcha && window.grecaptcha.execute) {
        window.grecaptcha.ready(function () { resolve(); });
        return;
      }
      var s = document.createElement('script');
      s.src   = 'https://www.google.com/recaptcha/api.js?render=' +
                encodeURIComponent(CAPTCHA_SITE_KEY);
      s.async = true;
      s.onload  = function () { window.grecaptcha.ready(function () { resolve(); }); };
      s.onerror = function () {
        loadPromise = null;
        reject(new Error('[CIJ Captcha] Failed to load reCAPTCHA script.'));
      };
      document.head.appendChild(s);
    });
    return loadPromise;
  }

  function getRecaptchaToken() {
    return loadRecaptchaScript().then(function () {
      return window.grecaptcha.execute(CAPTCHA_SITE_KEY, { action: CAPTCHA_ACTION });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PROVIDER: Cloudflare Turnstile (invisible / explicit execution)
  // ═══════════════════════════════════════════════════════════════════════════

  function loadTurnstileScript() {
    if (loadPromise) return loadPromise;
    loadPromise = new Promise(function (resolve, reject) {
      if (window.turnstile) { resolve(); return; }
      var s = document.createElement('script');
      // render=explicit — prevents auto-rendering of any [cf-turnstile] elements
      s.src   = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.defer = true;
      s.onload  = function () { resolve(); };
      s.onerror = function () {
        loadPromise = null;
        reject(new Error('[CIJ Captcha] Failed to load Turnstile script.'));
      };
      document.head.appendChild(s);
    });
    return loadPromise;
  }

  /**
   * Returns a Promise<string> resolving with a fresh Turnstile token.
   * Re-uses (and resets) an already-rendered invisible widget for the form.
   */
  function getTurnstileToken(formEl) {
    return loadTurnstileScript().then(function () {
      return new Promise(function (resolve, reject) {
        var entry = getOrCreateTurnstileWidget(formEl, resolve, reject);
        // Reset so a brand-new token is issued — tokens are single-use
        window.turnstile.reset(entry.widgetId);
        // Only call execute() when using execution: 'execute' (invisible mode).
        // In execution: 'render' mode the widget handles this automatically.
        if (TURNSTILE_EXECUTION === 'execute') {
          window.turnstile.execute(entry.widgetId);
        }
      });
    });
  }

  function getOrCreateTurnstileWidget(formEl, resolve, reject) {
    for (var i = 0; i < turnstileWidgets.length; i++) {
      if (turnstileWidgets[i].formEl === formEl) {
        turnstileWidgets[i].resolve = resolve;
        turnstileWidgets[i].reject  = reject;
        return turnstileWidgets[i];
      }
    }

    // Hidden container — Turnstile attaches its iframe here.
    // display:none keeps it off-screen; if a challenge modal is needed,
    // Cloudflare renders it as a full-page overlay regardless.
    var container = document.createElement('div');
    container.style.display = 'none';
    formEl.appendChild(container);

    var entry = { formEl: formEl, widgetId: null, resolve: resolve, reject: reject };
    turnstileWidgets.push(entry);

    entry.widgetId = window.turnstile.render(container, {
      sitekey: CAPTCHA_SITE_KEY,

      // Widget dimensions / mode — see TURNSTILE_SIZE above for all options
      size: TURNSTILE_SIZE,

      // When the challenge fires — see TURNSTILE_EXECUTION above for all options
      execution: TURNSTILE_EXECUTION,

      // When the widget UI is shown — see TURNSTILE_APPEARANCE above for all options
      appearance: TURNSTILE_APPEARANCE,

      // Widget colour scheme — see TURNSTILE_THEME above for all options
      theme: TURNSTILE_THEME,

      // Called when Turnstile has issued a valid token.
      // entry.resolve may be null during the pre-render warm-up call
      // (wireForm passes null callbacks just to create the widget early).
      callback: function (token) {
        if (entry.resolve) entry.resolve(token);
      },

      // Called on unrecoverable errors (e.g. invalid site key, network failure).
      // Error codes: https://developers.cloudflare.com/turnstile/troubleshooting/client-side-errors/
      'error-callback': function (code) {
        console.error('[CIJ Captcha] Turnstile error:', code);
        if (entry.reject) entry.reject(new Error('[CIJ Captcha] Turnstile error: ' + code));
      },

      // Called when an issued token expires before use (tokens last 300 seconds).
      // Clearing the callbacks means the next submit will trigger reset()+execute()
      // to obtain a fresh token instead of resolving with a stale one.
      'expired-callback': function () {
        entry.resolve = null;
        entry.reject  = null;
      }
    });

    return entry;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Generic token getter — delegates to the selected provider
  // ═══════════════════════════════════════════════════════════════════════════

  function getToken(formEl) {
    return CAPTCHA_PROVIDER === 'turnstile'
      ? getTurnstileToken(formEl)
      : getRecaptchaToken();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Form instrumentation
  // ═══════════════════════════════════════════════════════════════════════════

  function injectHiddenField(formEl) {
    if (formEl.querySelector('input[name="' + fieldName + '"]')) return;
    var input   = document.createElement('input');
    input.type  = 'hidden';
    input.name  = fieldName;
    input.value = '';
    formEl.appendChild(input);
  }

  function wireForm(formEl) {
    injectHiddenField(formEl);

    // For Turnstile: pre-render the invisible widget so it is ready faster
    if (CAPTCHA_PROVIDER === 'turnstile') {
      loadTurnstileScript().then(function () {
        getOrCreateTurnstileWidget(formEl, null, null);
      });
    }

    formEl.addEventListener('submit', function (event) {
      var hiddenField = formEl.querySelector('input[name="' + fieldName + '"]');

      // Token already populated — let submit proceed normally
      if (hiddenField && hiddenField.value) return;

      // Pause submit, fetch token, then re-submit
      event.preventDefault();
      event.stopImmediatePropagation();

      getToken(formEl)
        .then(function (token) {
          hiddenField.value = token;
          formEl.submit();
        })
        .catch(function (err) {
          console.error('[CIJ Captcha] Could not obtain CAPTCHA token:', err);
          // Allow submit so users are not permanently blocked;
          // the server-side plugin will receive an empty token and reject it.
          formEl.submit();
        });

    }, /* useCapture */ true); // capture so we run before CIJ's own submit handler
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DOM observation — waits for CIJ to render the <form> asynchronously
  // ═══════════════════════════════════════════════════════════════════════════

  function findAndWireForms(root) {
    var forms = (root || document).querySelectorAll(
      'div[data-form-id] form, form[data-validate-submission]'
    );
    forms.forEach(function (f) {
      if (!f._cijCaptchaWired) {
        f._cijCaptchaWired = true;
        wireForm(f);
      }
    });
  }

  function observeForForms() {
    findAndWireForms(document);

    var observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        m.addedNodes.forEach(function (node) {
          if (node.nodeType !== 1) return;
          var shadow = node.shadowRoot;
          if (shadow) findAndWireForms(shadow);
          findAndWireForms(node);
        });
      });
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Boot — eager load so the CAPTCHA is warm on first submit
  // ═══════════════════════════════════════════════════════════════════════════

  var eagerLoad = CAPTCHA_PROVIDER === 'turnstile' ? loadTurnstileScript : loadRecaptchaScript;
  eagerLoad().catch(function (e) { console.warn(e); });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', observeForForms);
  } else {
    observeForForms();
  }
})();
