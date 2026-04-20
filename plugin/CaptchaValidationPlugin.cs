using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
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
        CloudflareTurnstile,

        /// <summary>hCaptcha — pass/fail challenge-response.</summary>
        HCaptcha
    }

    /// <summary>
    /// Dataverse plug-in that validates a CAPTCHA token submitted via a
    /// Customer Insights Journeys (CIJ) embedded form.
    ///
    /// Supports:
    ///   • Google reCAPTCHA v3   
    ///   • Cloudflare Turnstile 
    ///   • hCaptcha
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
    ///   Unsecure Config (non-sensitive JSON):
    ///     {"provider":"recaptcha","recaptchaMode":"standard","actionThresholds":{"cij_form_submit":0.5}}
    ///     {"provider":"recaptcha","recaptchaMode":"enterprise","actionThresholds":{"cij_form_submit":0.7}}
    ///     {"provider":"turnstile"}
    ///     {"provider":"hcaptcha"}
    ///
    ///   Secure Config (stored encrypted by Dataverse, JSON):
    ///     {"secretKey":"...","enterpriseApiKey":"...","enterpriseProjectId":"...","enterpriseSiteKey":"..."}
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
        private const string HcaptchaVerifyUrl = "https://api.hcaptcha.com/siteverify";

        // ── Form field names (must match the hidden field name on the CIJ form) ─
        private const string CaptchaFieldName = "captcha-response";
        private const string CaptchaActionFieldName = "captcha-action";
        private const string CaptchaFormIdFieldName = "captcha-formid";

        // ── Runtime configuration (populated from plug-in config at registration) ─
        private readonly CaptchaProvider _provider;
        private readonly string          _secretKey;
        private readonly string          _enterpriseApiKey;
        private readonly RecaptchaMode   _recaptchaMode;
        private readonly string          _recaptchaProjectId;
        private readonly string          _recaptchaSiteKey;
        private readonly Dictionary<string, double> _actionThresholds;
        private readonly string          _validationFailureMessage;

        /// <summary>
        /// Parameterless constructor — requires Unsecure and Secure Config to be
        /// set via the Plugin Registration Tool. Throws if the secret key is absent.
        /// </summary>
        public CaptchaValidationPlugin() : this(string.Empty, string.Empty) { }

        /// <summary>
        /// Constructor called by Dataverse when plug-in config strings are present.
        /// Both configs are JSON objects.
        /// </summary>
        /// <param name="unsecureConfig">
        ///   Non-sensitive settings as JSON, e.g.:
        ///   {"provider":"recaptcha","recaptchaMode":"enterprise","actionThresholds":{"cij_form_submit":0.5}}
        /// </param>
        /// <param name="secureConfig">
        ///   Sensitive provider values as JSON, e.g.:
        ///   {"secretKey":"...","enterpriseApiKey":"...","enterpriseProjectId":"...","enterpriseSiteKey":"..."}
        /// </param>
        public CaptchaValidationPlugin(string unsecureConfig, string secureConfig)
        {
            if (string.IsNullOrWhiteSpace(secureConfig))
                throw new InvalidPluginExecutionException(
                    "[CijCaptcha] Secure Config is empty. " +
                    "Provide the CAPTCHA secret key (JSON) in the Secure Configuration field " +
                    "of the Plugin Registration Tool step.");

            // ── Parse unsecure config (JSON) ───────────────────────────────────
            UnsecureConfigJson unsecure;
            try
            {
                unsecure = DeserializeConfig<UnsecureConfigJson>(unsecureConfig ?? "{}");
            }
            catch (Exception ex)
            {
                throw new InvalidPluginExecutionException(
                    "[CijCaptcha] Unsecure Config is not valid JSON. " + ex.Message);
            }

            _provider   = ParseProvider(unsecure.Provider);
            _recaptchaMode = ParseRecaptchaMode(unsecure.RecaptchaMode);
            _validationFailureMessage = string.IsNullOrWhiteSpace(unsecure.FailureMessage)
                ? null : unsecure.FailureMessage.Trim();

            if (unsecure.ActionThresholds != null && unsecure.ActionThresholds.Count > 0)
            {
                _actionThresholds = new Dictionary<string, double>(StringComparer.Ordinal);
                foreach (var kvp in unsecure.ActionThresholds)
                {
                    if (!string.IsNullOrWhiteSpace(kvp.Key))
                        _actionThresholds[kvp.Key.Trim()] = Math.Max(0.0, Math.Min(1.0, kvp.Value));
                }
            }
            else
            {
                _actionThresholds = new Dictionary<string, double>(StringComparer.Ordinal)
                    { ["cij_form_submit"] = 0.5 };
            }

            // ── Parse secure config (JSON) ─────────────────────────────────────
            SecureConfigJson secure;
            try
            {
                secure = DeserializeConfig<SecureConfigJson>(secureConfig);
            }
            catch (Exception ex)
            {
                throw new InvalidPluginExecutionException(
                    "[CijCaptcha] Secure Config is not valid JSON. " + ex.Message);
            }

            _secretKey           = secure.SecretKey?.Trim();
            _enterpriseApiKey    = secure.EnterpriseApiKey?.Trim();
            _recaptchaProjectId  = secure.EnterpriseProjectId?.Trim();
            _recaptchaSiteKey    = secure.EnterpriseSiteKey?.Trim();

            if (string.IsNullOrWhiteSpace(_secretKey))
                throw new InvalidPluginExecutionException(
                    "[CijCaptcha] Missing CAPTCHA secret key. " +
                    "Set secure config JSON with \"secretKey\".");

            if (_provider == CaptchaProvider.GoogleRecaptchaV3 && _recaptchaMode == RecaptchaMode.Enterprise)
            {
                if (string.IsNullOrWhiteSpace(_enterpriseApiKey))
                    throw new InvalidPluginExecutionException(
                        "[CijCaptcha] Missing reCAPTCHA Enterprise API key. " +
                        "Set secure config JSON with \"enterpriseApiKey\".");

                if (string.IsNullOrWhiteSpace(_recaptchaProjectId))
                    throw new InvalidPluginExecutionException(
                        "[CijCaptcha] Missing Enterprise project id. " +
                        "Set secure config JSON with \"enterpriseProjectId\".");

                if (string.IsNullOrWhiteSpace(_recaptchaSiteKey))
                    throw new InvalidPluginExecutionException(
                        "[CijCaptcha] Missing Enterprise site key. " +
                        "Set secure config JSON with \"enterpriseSiteKey\".");
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
            var submittedAction = (requestObject?.Fields?.FirstOrDefault(f => f.Key == CaptchaActionFieldName))?.Value;
            var submittedFormId = (requestObject?.Fields?.FirstOrDefault(f => f.Key == CaptchaFormIdFieldName))?.Value;
            if (string.IsNullOrWhiteSpace(captchaToken))
            {
                tracingService.Trace($"[CijCaptcha] '{CaptchaFieldName}' is not present or empty – failing submission.");
                SetValidationResponse(context, isValid: false, error: "Captcha is not present or empty.");
                return;
            }

            tracingService.Trace($"[CijCaptcha] Submitted action='{submittedAction}', formid='{submittedFormId}'");

            if (_provider == CaptchaProvider.GoogleRecaptchaV3 && string.IsNullOrWhiteSpace(submittedAction))
            {
                tracingService.Trace($"[CijCaptcha] '{CaptchaActionFieldName}' is not present or empty – failing submission.");
                SetValidationResponse(context, isValid: false, error: "Captcha action is not present or empty.");
                return;
            }

            // ── 3. Verify with the selected provider ───────────────────────────
            bool isValid;

            switch (_provider)
            {
                case CaptchaProvider.CloudflareTurnstile:
                    isValid = VerifyTurnstile(captchaToken, tracingService);
                    break;

                case CaptchaProvider.HCaptcha:
                    isValid = VerifyHCaptcha(captchaToken, tracingService);
                    break;

                default: // GoogleRecaptchaV3
                    isValid = _recaptchaMode == RecaptchaMode.Enterprise
                        ? VerifyRecaptchaEnterprise(captchaToken, submittedAction, tracingService)
                        : VerifyRecaptcha(captchaToken, submittedAction, tracingService);
                    break;
            }

            tracingService.Trace($"[CijCaptcha] Final result: isValid={isValid}");

            // ── 4. Write the outcome back to CIJ ──────────────────────────────
            SetValidationResponse(context, isValid, isValid ? null : GetValidationFailureMessage());
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
        private bool VerifyRecaptchaEnterprise(string token, string submittedAction, ITracingService tracingService)
        {
            var expectedAction = string.IsNullOrWhiteSpace(submittedAction)
                ? null
                : submittedAction.Trim();

            if (string.IsNullOrWhiteSpace(expectedAction))
            {
                tracingService.Trace("[CijCaptcha] Submitted action is missing; enterprise verification requires action.");
                return false;
            }

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

            tracingService.Trace("[CijCaptcha] Enterprise request URL: " + endpoint);
            tracingService.Trace("[CijCaptcha] Enterprise request payload: " + payload);

            var raw = SendVerifyRequest(endpoint, new StringContent(payload, Encoding.UTF8, "application/json"), tracingService);
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

            if (!TryGetRequiredThresholdForAction(action, expectedAction, out var requiredThreshold, out var reason))
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
        private bool VerifyRecaptcha(string token, string submittedAction, ITracingService tracingService)
        {
            var payload = new Dictionary<string, string>
            {
                { "secret",   _secretKey },
                { "response", token      }
            };

            var raw = SendVerifyRequest(RecaptchaVerifyUrl, new FormUrlEncodedContent(payload), tracingService);
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

            var expectedAction = string.IsNullOrWhiteSpace(submittedAction)
                ? null
                : submittedAction.Trim();

            if (!TryGetRequiredThresholdForAction(response.action, expectedAction, out var requiredThreshold, out var reason))
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

        private bool TryGetRequiredThresholdForAction(string providerAction, string submittedAction, out double threshold, out string reason)
        {
            threshold = 0.5;
            reason = null;

            if (string.IsNullOrWhiteSpace(submittedAction))
            {
                reason = "action is missing from submitted form fields.";
                return false;
            }

            if (string.IsNullOrWhiteSpace(providerAction))
            {
                reason = "action is missing from provider response.";
                return false;
            }

            var expectedAction = submittedAction.Trim();
            var actualAction = providerAction.Trim();

            if (!string.Equals(actualAction, expectedAction, StringComparison.Ordinal))
            {
                reason = "action mismatch. Received '" + actualAction + "', expected '" + expectedAction + "'.";
                return false;
            }

            if (_actionThresholds == null || _actionThresholds.Count == 0)
            {
                reason = "no action thresholds are configured.";
                return false;
            }

            if (!_actionThresholds.TryGetValue(expectedAction, out threshold))
            {
                reason = "action '" + expectedAction + "' is not configured.";
                return false;
            }

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

            var raw = SendVerifyRequest(TurnstileVerifyUrl, new FormUrlEncodedContent(payload), tracingService);
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
        /// Verifies an hCaptcha token (pass/fail — no score threshold check).
        /// </summary>
        private bool VerifyHCaptcha(string token, ITracingService tracingService)
        {
            var payload = new Dictionary<string, string>
            {
                { "secret",   _secretKey },
                { "response", token      }
            };

            var raw = SendVerifyRequest(HcaptchaVerifyUrl, new FormUrlEncodedContent(payload), tracingService);
            if (raw == null) return false;

            var response = Deserialize<HcaptchaVerifyResponse>(raw);

            tracingService.Trace(
                "[CijCaptcha] hCaptcha: success=" + response.success + ", " +
                "hostname=" + response.hostname + ", score=" + response.score);

            if (!response.success)
            {
                var errors = response.error_codes != null
                    ? string.Join(", ", response.error_codes) : "none";
                tracingService.Trace("[CijCaptcha] hCaptcha failed. Error codes: " + errors);
            }

            return response.success;
        }

        /// <summary>
        /// Sends a POST with the given content and returns the raw response body, or null on failure.
        /// </summary>
        private string SendVerifyRequest(string url, HttpContent content, ITracingService tracingService)
        {
            using (var client = new HttpClient())
            {
                try
                {
                    var response = client.PostAsync(url, content).Result;
                    var body = response.Content.ReadAsStringAsync().Result;

                    if (!response.IsSuccessStatusCode)
                    {
                        var detail = string.IsNullOrWhiteSpace(body) ? "<empty>" : body;
                        tracingService.Trace(
                            "[CijCaptcha] Verify endpoint " + url +
                            " returned HTTP " + (int)response.StatusCode +
                            " " + response.ReasonPhrase +
                            ". Response body: " + detail);
                        return null;
                    }

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
            string error = null)
        {
            var resp = new ValidateFormSubmissionResponse
            {
                IsValid = isValid,
                // Always strip all CAPTCHA-related fields from the CIJ submission record UI.
                ValidationOnlyFields = new List<string> { CaptchaFieldName, CaptchaActionFieldName, CaptchaFormIdFieldName },
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
            if (lower.Contains("hcaptcha"))   return CaptchaProvider.HCaptcha;
            if (lower.Contains("recaptcha"))  return CaptchaProvider.GoogleRecaptchaV3;

            return CaptchaProvider.GoogleRecaptchaV3;
        }

        private static RecaptchaMode ParseRecaptchaMode(string value)
        {
            if (string.Equals(value, "enterprise", StringComparison.OrdinalIgnoreCase))
                return RecaptchaMode.Enterprise;
            return RecaptchaMode.Standard;
        }

        private static T DeserializeConfig<T>(string json)
        {
            var settings = new DataContractJsonSerializerSettings { UseSimpleDictionaryFormat = true };
            var serializer = new DataContractJsonSerializer(typeof(T), settings);
            using (var ms = new MemoryStream(Encoding.UTF8.GetBytes(json ?? "{}")))
            {
                return (T)serializer.ReadObject(ms);
            }
        }

        private static string EscapeJson(string value)
        {
            return (value ?? string.Empty)
                .Replace("\\", "\\\\")
                .Replace("\"", "\\\"");
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
    // ── Plugin config POCOs ────────────────────────────────────────────────

    [DataContract]
    internal sealed class UnsecureConfigJson
    {
        [DataMember(Name = "provider")]
        public string Provider { get; set; }

        [DataMember(Name = "recaptchaMode")]
        public string RecaptchaMode { get; set; }

        [DataMember(Name = "actionThresholds")]
        public Dictionary<string, double> ActionThresholds { get; set; }

        [DataMember(Name = "failureMessage")]
        public string FailureMessage { get; set; }
    }

    [DataContract]
    internal sealed class SecureConfigJson
    {
        [DataMember(Name = "secretKey")]
        public string SecretKey { get; set; }

        [DataMember(Name = "enterpriseApiKey")]
        public string EnterpriseApiKey { get; set; }

        [DataMember(Name = "enterpriseProjectId")]
        public string EnterpriseProjectId { get; set; }

        [DataMember(Name = "enterpriseSiteKey")]
        public string EnterpriseSiteKey { get; set; }
    }

    // ── Provider response contracts ───────────────────────────────────────────
    public sealed class FormSubmissionRequest
    {
        [DataMember(Name = "PublishedFormUrl")]
        public string PublishedFormUrl { get; set; }

        [DataMember(Name = "Fields")]
        public List<FormField> Fields { get; set; }
    }

    public sealed class FormField
    {
        [DataMember(Name = "Key")]
        public string Key { get; set; }

        [DataMember(Name = "Value")]
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

    /// <summary>hCaptcha /siteverify response.</summary>
    [DataContract]
    public class HcaptchaVerifyResponse
    {
        [DataMember(Name = "success")]
        public bool success { get; set; }

        [DataMember(Name = "challenge_ts")]
        public string challenge_ts { get; set; }

        [DataMember(Name = "hostname")]
        public string hostname { get; set; }

        [DataMember(Name = "credit")]
        public bool credit { get; set; }

        [DataMember(Name = "error-codes")]
        public List<string> error_codes { get; set; }

        [DataMember(Name = "score")]
        public double? score { get; set; }
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
