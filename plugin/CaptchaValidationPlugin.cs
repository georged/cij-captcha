using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Text.Json.Serialization;
using Microsoft.Xrm.Sdk;

namespace CijCaptcha
{
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
    ///   • Google reCAPTCHA v3   — reads field  g-recaptcha-response
    ///   • Cloudflare Turnstile  — reads field  cf-turnstile-response
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
        // ── Provider verification endpoints ───────────────────────────────────
        private const string RecaptchaVerifyUrl = "https://www.google.com/recaptcha/api/siteverify";
        private const string TurnstileVerifyUrl = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

        // ── Form field names (must match the hidden field name on the CIJ form) ─
        private const string CaptchaFieldName = "captcha-response";

        // ── Runtime configuration (populated from plug-in config at registration) ─
        private readonly CaptchaProvider _provider;
        private readonly string          _secretKey;
        private readonly double          _minScore;

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

            _secretKey = secureConfig.Trim();
            _provider  = ParseProvider(unsecureConfig);
            _minScore  = ParseMinScore(unsecureConfig);
        }

        // ── IPlugin.Execute ────────────────────────────────────────────────────
        public void Execute(IServiceProvider serviceProvider)
        {
            var tracingService = (ITracingService)
                serviceProvider.GetService(typeof(ITracingService));

            var context = (IPluginExecutionContext)
                serviceProvider.GetService(typeof(IPluginExecutionContext));

            tracingService.Trace($"[CijCaptcha] Executing. Provider={_provider}");

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
                    isValid = VerifyRecaptcha(captchaToken, tracingService);
                    break;
            }

            tracingService.Trace($"[CijCaptcha] Final result: isValid={isValid}");

            // ── 4. Write the outcome back to CIJ ──────────────────────────────
            SetValidationResponse(context, isValid, fieldName: CaptchaFieldName, isValid ? null:"Captcha test failed.");
        }

        // ── Provider verification ──────────────────────────────────────────────

        /// <summary>
        /// Verifies a Google reCAPTCHA v3 token and enforces the score threshold.
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

            if (response.score < _minScore)
            {
                tracingService.Trace(
                    $"[CijCaptcha] reCAPTCHA score {response.score} below threshold {_minScore}.");
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
