using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Text.Json.Serialization;
using System.Globalization;
using Microsoft.Xrm.Sdk;

namespace Georged.Cij.Captcha
{
    public enum RecaptchaMode
    {
        Standard,
        Enterprise
    }

    /// <summary>
    /// Supported CAPTCHA providers.
    /// </summary>
    public enum CaptchaProvider
    {
        /// <summary>Google reCAPTCHA v3 — score-based, invisible.</summary>
        GoogleRecaptchaV3,

        /// <summary>Cloudflare Turnstile — pass/fail, privacy-friendly.</summary>
        CloudflareTurnstile
    }

    /// <summary>
    /// Dataverse plug-in that validates a CAPTCHA token submitted via a
    /// Customer Insights Journeys (CIJ) embedded form.
    ///
    /// Supports:
    ///   • Google reCAPTCHA v3   
    ///   • Cloudflare Turnstile 
    ///
    /// Registration details (Plugin Registration Tool)
    /// ────────────────────────────────────────────────
    ///   Message              : msdynmkt_validateformsubmission
    ///   Stage                : Post-operation (40)
    ///   Execution Mode       : Synchronous
    ///   Execution Order      : 10
    ///
    /// Configuration — ALL sensitive values are stored in Secure Config only.
    /// ───────────────────────────────────────────────────────────────────────
    ///   Unsecure Config  (non-sensitive, human-readable settings):
    ///     provider=recaptcha            — use Google reCAPTCHA v3
    ///     provider=recaptcha;minscore=0.7  — reCAPTCHA v3 with custom score threshold
    ///     provider=turnstile            — use Cloudflare Turnstile
    ///
    ///   Secure Config  (stored encrypted by Dataverse — put secret key here):
    ///     &lt;your CAPTCHA secret key&gt;
    ///
    /// The plugin will throw an InvalidPluginExecutionException on startup if
    /// the secure config (secret key) is missing, to fail fast rather than
    /// silently accepting all submissions.
    /// </summary>
    public class CaptchaValidationPlugin : IPlugin
    {
        private const string DefaultValidationFailureMessage = "Captcha test failed.";

        // ── Provider verification endpoints ───────────────────────────────────
        private const string RecaptchaVerifyUrl = "https://www.google.com/recaptcha/api/siteverify";
        private const string RecaptchaEnterpriseAssessmentsBaseUrl = "https://recaptchaenterprise.googleapis.com/v1/projects";
        private const string TurnstileVerifyUrl = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

        // ── Form field names (must match the hidden field name on the CIJ form) ─
        private const string CaptchaFieldName = "captcha-response";

        // ── Runtime configuration (populated from plug-in config at registration) ─
        private readonly CaptchaProvider _provider;
        private readonly string          _secretKey;
        private readonly string          _enterpriseApiKey;
        private readonly double          _minScore;
        private readonly RecaptchaMode   _recaptchaMode;
        private readonly string          _recaptchaProjectId;
        private readonly string          _recaptchaSiteKey;
        private readonly string          _recaptchaExpectedAction;
        private readonly Dictionary<string, double> _actionThresholds;
        private readonly string          _validationFailureMessage;

        /// <summary>
        /// Parameterless constructor — requires Unsecure and Secure Config to be
        /// set via the Plugin Registration Tool. Throws if the secret key is absent.
        /// </summary>
        public CaptchaValidationPlugin() : this(string.Empty, string.Empty) { }

        /// <summary>
        /// Constructor called by Dataverse when plug-in config strings are present.
        /// </summary>
        /// <param name="unsecureConfig">
        ///   Non-sensitive settings, e.g. "provider=recaptcha;minscore=0.5"
        ///   or "provider=turnstile".
        /// </param>
        /// <param name="secureConfig">
        ///   The CAPTCHA secret key. Stored encrypted by Dataverse.
        ///   This is the ONLY place the secret key should exist.
        /// </param>
        public CaptchaValidationPlugin(string unsecureConfig, string secureConfig)
        {
            if (string.IsNullOrWhiteSpace(secureConfig))
                throw new InvalidPluginExecutionException(
                    "[CijCaptcha] Secure Config is empty. " +
                    "Provide the CAPTCHA secret key in the Secure Configuration field " +
                    "of the Plugin Registration Tool step.");

            _provider = ParseProvider(unsecureConfig);
            _minScore = ParseMinScore(unsecureConfig);
            _recaptchaMode = ParseRecaptchaMode(unsecureConfig);
            _recaptchaProjectId = ParseConfigValue(unsecureConfig, "projectid");
            _recaptchaSiteKey = ParseConfigValue(unsecureConfig, "sitekey");
            _recaptchaExpectedAction = ParseConfigValue(unsecureConfig, "expectedaction");
            _actionThresholds = ParseActionThresholds(unsecureConfig, _recaptchaExpectedAction, _minScore);
            _validationFailureMessage = ParseConfigValue(unsecureConfig, "failuremessage");

            var secureValues = ParseSecureConfigValues(secureConfig);
            _secretKey = secureValues.secretKey;
            _enterpriseApiKey = secureValues.enterpriseApiKey;

            if (_provider == CaptchaProvider.GoogleRecaptchaV3 && _recaptchaMode == RecaptchaMode.Enterprise)
            {
                if (string.IsNullOrWhiteSpace(_enterpriseApiKey))
                    throw new InvalidPluginExecutionException(
                        "[CijCaptcha] Missing reCAPTCHA Enterprise API key. " +
                        "Set secure config to either the API key value or 'apikey=<value>'.");

                if (string.IsNullOrWhiteSpace(_recaptchaProjectId))
                    throw new InvalidPluginExecutionException(
                        "[CijCaptcha] Missing Enterprise project id in unsecure config. " +
                        "Set 'projectid=<gcp-project-id>'.");

                if (string.IsNullOrWhiteSpace(_recaptchaSiteKey))
                    throw new InvalidPluginExecutionException(
                        "[CijCaptcha] Missing Enterprise site key in unsecure config. " +
                        "Set 'sitekey=<enterprise-site-key>'.");
            }
            else
            {
                if (string.IsNullOrWhiteSpace(_secretKey))
                    throw new InvalidPluginExecutionException(
                        "[CijCaptcha] Secure Config is empty. " +
                        "Provide the CAPTCHA secret key in Secure Config.");
            }
        }

        // ── IPlugin.Execute ────────────────────────────────────────────────────
        public void Execute(IServiceProvider serviceProvider)
        {
            var tracingService = (ITracingService)
                serviceProvider.GetService(typeof(ITracingService));

            var context = (IPluginExecutionContext)
                serviceProvider.GetService(typeof(IPluginExecutionContext));

            tracingService.Trace($"[CijCaptcha] Executing. Provider={_provider}; recaptchaMode={_recaptchaMode}");

            // ── 1. Read the raw form submission JSON ───────────────────────────
            if (!context.InputParameters.Contains("msdynmkt_formsubmissionrequest"))
            {
                tracingService.Trace("[CijCaptcha] Input parameter 'msdynmkt_formsubmissionrequest' not found – skipping.");
                return;
            }

            var requestString = (string)context.InputParameters["msdynmkt_formsubmissionrequest"];
            var requestObject = Deserialize<FormSubmissionRequest>(requestString);
            tracingService.Trace($"[CijCaptcha] Raw form submission: {requestString}");
            if(requestObject.Fields!=null)
            tracingService.Trace($"[CijCaptcha] Parsed fields: {string.Join(", ", requestObject.Fields.Select(f => $"{f.Key}={f.Value}"))}");

            // ── 2. Resolve the expected field name for the active provider ─────
            var captchaToken = (requestObject?.Fields?.FirstOrDefault(f => f.Key == CaptchaFieldName))?.Value;
            if (string.IsNullOrWhiteSpace(captchaToken))
            {
                tracingService.Trace($"[CijCaptcha] '{CaptchaFieldName}' is not present or empty – failing submission.");
                SetValidationResponse(context, isValid: false, fieldName: CaptchaFieldName, error: "Captcha is not present or empty.");
                return;
            }

            // ── 3. Verify with the selected provider ───────────────────────────
            bool isValid;

            switch (_provider)
            {
                case CaptchaProvider.CloudflareTurnstile:
                    isValid = VerifyTurnstile(captchaToken, tracingService);
                    break;

                default: // GoogleRecaptchaV3
                    isValid = _recaptchaMode == RecaptchaMode.Enterprise
                        ? VerifyRecaptchaEnterprise(captchaToken, tracingService)
                        : VerifyRecaptcha(captchaToken, tracingService);
                    break;
            }

            tracingService.Trace($"[CijCaptcha] Final result: isValid={isValid}");

            // ── 4. Write the outcome back to CIJ ──────────────────────────────
            SetValidationResponse(
                context,
                isValid,
                fieldName: CaptchaFieldName,
                isValid ? null : GetValidationFailureMessage());
        }

        private string GetValidationFailureMessage()
        {
            return string.IsNullOrWhiteSpace(_validationFailureMessage)
                ? DefaultValidationFailureMessage
                : _validationFailureMessage;
        }

        /// <summary>
        /// Verifies token with reCAPTCHA Enterprise assessments API.
        /// </summary>
        private bool VerifyRecaptchaEnterprise(string token, ITracingService tracingService)
        {
            var expectedAction = _actionThresholds.Count == 1
                ? _actionThresholds.Keys.FirstOrDefault()
                : null;

            var endpoint =
                RecaptchaEnterpriseAssessmentsBaseUrl + "/" + Uri.EscapeDataString(_recaptchaProjectId) +
                "/assessments?key=" + Uri.EscapeDataString(_enterpriseApiKey);

            var payload = "{\"event\":{\"token\":\"" + EscapeJson(token) +
                "\",\"siteKey\":\"" + EscapeJson(_recaptchaSiteKey) + "\"";

            if (!string.IsNullOrWhiteSpace(expectedAction))
            {
                payload += ",\"expectedAction\":\"" + EscapeJson(expectedAction) + "\"";
            }

            payload += "}}";

            var raw = PostJsonToVerifyEndpoint(endpoint, payload, tracingService);
            if (raw == null) return false;

            var response = Deserialize<RecaptchaEnterpriseAssessResponse>(raw);
            var valid = response != null && response.tokenProperties != null && response.tokenProperties.valid;

            var score = response != null && response.riskAnalysis != null ? response.riskAnalysis.score : 0.0;
            var action = response != null && response.tokenProperties != null ? response.tokenProperties.action : null;
            var invalidReason = response != null && response.tokenProperties != null
                ? response.tokenProperties.invalidReason
                : null;

            tracingService.Trace(
                "[CijCaptcha] reCAPTCHA Enterprise: " +
                "valid=" + valid + ", score=" + score + ", action=" + action + ", invalidReason=" + invalidReason);

            if (!valid)
            {
                tracingService.Trace("[CijCaptcha] Enterprise token is invalid.");
                return false;
            }

            if (!TryGetRequiredThresholdForAction(action, out var requiredThreshold, out var reason))
            {
                tracingService.Trace("[CijCaptcha] Enterprise action check failed: " + reason);
                return false;
            }

            if (score < requiredThreshold)
            {
                tracingService.Trace(
                    "[CijCaptcha] Enterprise score " + score + " below threshold " + requiredThreshold + ".");
                return false;
            }

            return true;
        }

        // ── Provider verification ──────────────────────────────────────────────

        /// <summary>
        /// Verifies a Google reCAPTCHA v3 token and enforces action + score checks.
        /// </summary>
        private bool VerifyRecaptcha(string token, ITracingService tracingService)
        {
            var payload = new Dictionary<string, string>
            {
                { "secret",   _secretKey },
                { "response", token      }
            };

            var raw = PostToVerifyEndpoint(RecaptchaVerifyUrl, payload, tracingService);
            if (raw == null) return false;

            var response = Deserialize<RecaptchaVerifyResponse>(raw);

            if (response == null)
            {
                tracingService.Trace("[CijCaptcha] reCAPTCHA response was empty or invalid JSON.");
                return false;
            }

            tracingService.Trace(
                $"[CijCaptcha] reCAPTCHA: success={response.success}, " +
                $"score={response.score}, action={response.action}");

            if (!response.success)
            {
                var errors = response.error_codes != null
                    ? string.Join(", ", response.error_codes) : "none";
                tracingService.Trace($"[CijCaptcha] reCAPTCHA failed. Error codes: {errors}");
                return false;
            }

            if (!TryGetRequiredThresholdForAction(response.action, out var requiredThreshold, out var reason))
            {
                tracingService.Trace("[CijCaptcha] reCAPTCHA action check failed: " + reason);
                return false;
            }

            if (response.score < requiredThreshold)
            {
                tracingService.Trace(
                    $"[CijCaptcha] reCAPTCHA score {response.score} below threshold {requiredThreshold}.");
                return false;
            }

            return true;
        }

        private bool TryGetRequiredThresholdForAction(string action, out double threshold, out string reason)
        {
            threshold = 0.5;
            reason = null;

            if (_actionThresholds != null && _actionThresholds.Count > 0)
            {
                if (string.IsNullOrWhiteSpace(action))
                {
                    reason = "action is missing from provider response.";
                    return false;
                }

                var normalized = action.Trim();
                if (!_actionThresholds.TryGetValue(normalized, out threshold))
                {
                    reason = "action '" + normalized + "' is not configured.";
                    return false;
                }

                return true;
            }

            var expectedAction = string.IsNullOrWhiteSpace(_recaptchaExpectedAction)
                ? "cij_form_submit"
                : _recaptchaExpectedAction;

            if (string.IsNullOrWhiteSpace(action))
            {
                reason = "action is missing from provider response.";
                return false;
            }

            if (!string.Equals(action, expectedAction, StringComparison.Ordinal))
            {
                reason = "action mismatch. Received '" + action + "', expected '" + expectedAction + "'.";
                return false;
            }

            threshold = _minScore;
            return true;
        }

        /// <summary>
        /// Verifies a Cloudflare Turnstile token (pass/fail — no score).
        /// </summary>
        private bool VerifyTurnstile(string token, ITracingService tracingService)
        {
            var payload = new Dictionary<string, string>
            {
                { "secret",   _secretKey },
                { "response", token      }
            };

            var raw = PostToVerifyEndpoint(TurnstileVerifyUrl, payload, tracingService);
            if (raw == null) return false;

            var response = Deserialize<TurnstileVerifyResponse>(raw);

            tracingService.Trace(
                $"[CijCaptcha] Turnstile: success={response.success}, " +
                $"hostname={response.hostname}, action={response.action}");

            if (!response.success)
            {
                var errors = response.error_codes != null
                    ? string.Join(", ", response.error_codes) : "none";
                tracingService.Trace($"[CijCaptcha] Turnstile failed. Error codes: {errors}");
            }

            return response.success;
        }

        /// <summary>
        /// Sends a form-encoded POST and returns the raw response body, or null on failure.
        /// </summary>
        private string PostToVerifyEndpoint(
            string url,
            Dictionary<string, string> payload,
            ITracingService tracingService)
        {
            using (var client = new HttpClient())
            {
                try
                {
                    var content  = new FormUrlEncodedContent(payload);
                    var response = client.PostAsync(url, content).Result;

                    if (!response.IsSuccessStatusCode)
                    {
                        tracingService.Trace(
                            $"[CijCaptcha] Verify endpoint {url} returned HTTP {(int)response.StatusCode}.");
                        return null;
                    }

                    var body = response.Content.ReadAsStringAsync().Result;
                    tracingService.Trace($"[CijCaptcha] Verify response: {body}");
                    return body;
                }
                catch (Exception ex)
                {
                    tracingService.Trace($"[CijCaptcha] Exception calling {url}: {ex.Message}");
                    return null;
                }
            }
        }

        /// <summary>
        /// Sends a JSON POST and returns response body, or null when the call fails.
        /// </summary>
        private string PostJsonToVerifyEndpoint(string url, string payload, ITracingService tracingService)
        {
            using (var client = new HttpClient())
            {
                try
                {
                    var content = new StringContent(payload, Encoding.UTF8, "application/json");
                    var response = client.PostAsync(url, content).Result;

                    if (!response.IsSuccessStatusCode)
                    {
                        tracingService.Trace(
                            "[CijCaptcha] Verify endpoint " + url +
                            " returned HTTP " + (int)response.StatusCode + ".");
                        return null;
                    }

                    var body = response.Content.ReadAsStringAsync().Result;
                    tracingService.Trace("[CijCaptcha] Verify response: " + body);
                    return body;
                }
                catch (Exception ex)
                {
                    tracingService.Trace("[CijCaptcha] Exception calling " + url + ": " + ex.Message);
                    return null;
                }
            }
        }

        // ── Output helper ──────────────────────────────────────────────────────

        private void SetValidationResponse(
            IPluginExecutionContext context,
            bool isValid,
            string fieldName,
            string error = null)
        {
            var resp = new ValidateFormSubmissionResponse
            {
                IsValid = isValid,
                // Strip the raw CAPTCHA token from the CIJ submission record UI.
                ValidationOnlyFields = new List<string> { fieldName },
                Error = error
            };

            context.OutputParameters["msdynmkt_validationresponse"] = Serialize(resp);
        }

        // ── Config parsers ────────────────────────────────────────────────────

        private static CaptchaProvider ParseProvider(string config)
        {
            if (string.IsNullOrWhiteSpace(config)) return CaptchaProvider.GoogleRecaptchaV3;

            var lower = config.ToLowerInvariant();
            if (lower.Contains("turnstile"))  return CaptchaProvider.CloudflareTurnstile;
            if (lower.Contains("recaptcha"))  return CaptchaProvider.GoogleRecaptchaV3;

            return CaptchaProvider.GoogleRecaptchaV3;
        }

        private static RecaptchaMode ParseRecaptchaMode(string config)
        {
            var value = ParseConfigValue(config, "recaptchamode");
            if (string.Equals(value, "enterprise", StringComparison.OrdinalIgnoreCase))
            {
                return RecaptchaMode.Enterprise;
            }

            return RecaptchaMode.Standard;
        }

        private static string ParseConfigValue(string config, string key)
        {
            if (string.IsNullOrWhiteSpace(config)) return null;

            foreach (var part in config.Split(';'))
            {
                var kv = part.Trim().Split('=');
                if (kv.Length < 2) continue;

                if (kv[0].Trim().Equals(key, StringComparison.OrdinalIgnoreCase))
                {
                    return DecodeConfigValue(string.Join("=", kv.Skip(1)).Trim());
                }
            }

            return null;
        }

        private static string DecodeConfigValue(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return value;

            try
            {
                return Uri.UnescapeDataString(value);
            }
            catch
            {
                return value;
            }
        }

        private static (string secretKey, string enterpriseApiKey) ParseSecureConfigValues(string secureConfig)
        {
            var raw = (secureConfig ?? string.Empty).Trim();
            if (!raw.Contains("="))
            {
                return (raw, raw);
            }

            string secret = null;
            string apiKey = null;

            foreach (var part in raw.Split(';'))
            {
                var kv = part.Trim().Split('=');
                if (kv.Length < 2) continue;

                var key = kv[0].Trim().ToLowerInvariant();
                var value = string.Join("=", kv.Skip(1)).Trim();
                if (key == "secret" || key == "secretkey") secret = value;
                if (key == "apikey" || key == "enterpriseapikey") apiKey = value;
            }

            return (secret, apiKey);
        }

        private static string EscapeJson(string value)
        {
            return (value ?? string.Empty)
                .Replace("\\", "\\\\")
                .Replace("\"", "\\\"");
        }

        private static double ParseMinScore(string config)
        {
            if (string.IsNullOrWhiteSpace(config)) return 0.5;

            foreach (var part in config.Split(';'))
            {
                var kv = part.Trim().Split('=');
                if (kv.Length == 2 &&
                    kv[0].Trim().Equals("minscore", StringComparison.OrdinalIgnoreCase) &&
                    double.TryParse(kv[1].Trim(), out double score))
                {
                    return Math.Max(0.0, Math.Min(1.0, score));
                }
            }

            return 0.5;
        }

        private static Dictionary<string, double> ParseActionThresholds(
            string config,
            string fallbackAction,
            double fallbackThreshold)
        {
            var thresholds = new Dictionary<string, double>(StringComparer.Ordinal);
            var raw = ParseConfigValue(config, "actionthresholds");

            if (!string.IsNullOrWhiteSpace(raw))
            {
                foreach (var entry in raw.Split(','))
                {
                    var pair = entry.Split(':');
                    if (pair.Length < 2) continue;

                    var action = pair[0].Trim();
                    var thresholdRaw = pair[1].Trim();
                    if (string.IsNullOrWhiteSpace(action)) continue;

                    if (double.TryParse(thresholdRaw, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed))
                    {
                        thresholds[action] = Math.Max(0.0, Math.Min(1.0, parsed));
                    }
                }
            }

            if (thresholds.Count == 0)
            {
                var action = string.IsNullOrWhiteSpace(fallbackAction)
                    ? "cij_form_submit"
                    : fallbackAction;

                thresholds[action] = Math.Max(0.0, Math.Min(1.0, fallbackThreshold));
            }

            return thresholds;
        }

        // ── JSON helpers (DataContractJsonSerializer — no extra dependencies) ──

        private static DataContractJsonSerializer _serializer;

        private static T Deserialize<T>(string json)
        {
            _serializer = new DataContractJsonSerializer(typeof(T));
            using (var ms = new MemoryStream(Encoding.UTF8.GetBytes(json)))
            {
                return (T)_serializer.ReadObject(ms);
            }
        }

        private static string Serialize<T>(T obj)
        {
            _serializer = new DataContractJsonSerializer(typeof(T));
            using (var ms = new MemoryStream())
            {
                _serializer.WriteObject(ms, obj);
                return Encoding.UTF8.GetString(ms.ToArray());
            }
        }
    }

    // ── Data contracts ─────────────────────────────────────────────────────────

    public sealed class FormSubmissionRequest
    {
        [JsonPropertyName("PublishedFormUrl")]
        public string PublishedFormUrl { get; set; }

        [JsonPropertyName("Fields")]
        public List<FormField> Fields { get; set; }
    }

    public sealed class FormField
    {
        [JsonPropertyName("Key")]
        public string Key { get; set; }

        [JsonPropertyName("Value")]
        public string Value { get; set; }
    }

    /// <summary>Google reCAPTCHA v3 /siteverify response.</summary>
    [DataContract]
    public class RecaptchaVerifyResponse
    {
        [DataMember(Name = "success")]
        public bool success { get; set; }

        /// <summary>Score: 1.0 = human, 0.0 = bot.</summary>
        [DataMember(Name = "score")]
        public double score { get; set; }

        [DataMember(Name = "action")]
        public string action { get; set; }

        [DataMember(Name = "challenge_ts")]
        public string challenge_ts { get; set; }

        [DataMember(Name = "hostname")]
        public string hostname { get; set; }

        [DataMember(Name = "error-codes")]
        public List<string> error_codes { get; set; }
    }

    /// <summary>Cloudflare Turnstile /siteverify response.</summary>
    [DataContract]
    public class TurnstileVerifyResponse
    {
        [DataMember(Name = "success")]
        public bool success { get; set; }

        [DataMember(Name = "challenge_ts")]
        public string challenge_ts { get; set; }

        [DataMember(Name = "hostname")]
        public string hostname { get; set; }

        [DataMember(Name = "error-codes")]
        public List<string> error_codes { get; set; }

        [DataMember(Name = "action")]
        public string action { get; set; }

        [DataMember(Name = "cdata")]
        public string cdata { get; set; }
    }

    [DataContract]
    public class RecaptchaEnterpriseAssessResponse
    {
        [DataMember(Name = "tokenProperties")]
        public RecaptchaEnterpriseTokenProperties tokenProperties { get; set; }

        [DataMember(Name = "riskAnalysis")]
        public RecaptchaEnterpriseRiskAnalysis riskAnalysis { get; set; }
    }

    [DataContract]
    public class RecaptchaEnterpriseTokenProperties
    {
        [DataMember(Name = "valid")]
        public bool valid { get; set; }

        [DataMember(Name = "action")]
        public string action { get; set; }

        [DataMember(Name = "invalidReason")]
        public string invalidReason { get; set; }
    }

    [DataContract]
    public class RecaptchaEnterpriseRiskAnalysis
    {
        [DataMember(Name = "score")]
        public double score { get; set; }
    }

    [DataContract]
    public class ValidateFormSubmissionResponse
    {
        /// <summary>True to accept the submission; false to reject it.</summary>
        [DataMember(Name = "IsValid")]
        public bool IsValid { get; set; }

        /// <summary>
        /// Fields listed here are hidden from the CIJ submission record UI.
        /// Always include the CAPTCHA token field so raw tokens are not stored visibly.
        /// </summary>
        [DataMember(Name = "ValidationOnlyFields")]
        public List<string> ValidationOnlyFields { get; set; }

        [DataMember(Name = "Error")]
        public string Error { get; set; }
    }
}
