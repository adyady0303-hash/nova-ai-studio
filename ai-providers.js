"use strict";

const { setTimeout: delay } = require("node:timers/promises");

const DEFAULT_TIMEOUT = 180000;
const MODEL_LIST_TIMEOUT = 10000;
const ANTHROPIC_VERSION = "2023-06-01";
const TRANSIENT_STATUSES = new Set([408, 409, 425, 429, 500, 501, 502, 503, 504, 507, 509, 529]);
const TRANSIENT_CODES = new Set([
  "ABORT_ERR", "ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETDOWN",
  "ENETUNREACH", "ENOTFOUND", "EPIPE", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"
]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const TEXT_ONLY = { text: true, image: false, imageEdit: false, speech: false };
const IMAGE_MEDIA = { text: true, image: true, imageEdit: true, speech: false };
const ALL_MEDIA = { text: true, image: true, imageEdit: true, speech: true };

const PLATFORM_PRESETS = deepFreeze({
  openai: {
    id: "openai", name: "OpenAI", protocol: "openai", baseUrl: "https://api.openai.com/v1",
    textModel: "gpt-5.4", imageModel: "gpt-image-1.5", speechModel: "gpt-4o-mini-tts", voice: "nova",
    capabilities: ALL_MEDIA, requiresKey: true, outputTokenField: "max_completion_tokens"
  },
  gemini: {
    id: "gemini", name: "Google Gemini", protocol: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    textModel: "gemini-2.5-flash", imageModel: "", speechModel: "", voice: "",
    capabilities: IMAGE_MEDIA, requiresKey: true, outputTokenField: "max_tokens"
  },
  anthropic: {
    id: "anthropic", name: "Anthropic", protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1",
    textModel: "claude-sonnet-4-5", imageModel: "", speechModel: "", voice: "",
    capabilities: TEXT_ONLY, requiresKey: true, outputTokenField: "max_tokens"
  },
  openrouter: {
    id: "openrouter", name: "OpenRouter", protocol: "openai", baseUrl: "https://openrouter.ai/api/v1",
    textModel: "openai/gpt-4.1-mini", imageModel: "", speechModel: "", voice: "",
    capabilities: IMAGE_MEDIA, requiresKey: true, outputTokenField: "max_tokens"
  },
  groq: {
    id: "groq", name: "Groq", protocol: "openai", baseUrl: "https://api.groq.com/openai/v1",
    textModel: "llama-3.3-70b-versatile", imageModel: "", speechModel: "", voice: "",
    capabilities: TEXT_ONLY, requiresKey: true, outputTokenField: "max_tokens"
  },
  mistral: {
    id: "mistral", name: "Mistral AI", protocol: "openai", baseUrl: "https://api.mistral.ai/v1",
    textModel: "mistral-small-latest", imageModel: "", speechModel: "", voice: "",
    capabilities: TEXT_ONLY, requiresKey: true, outputTokenField: "max_tokens"
  },
  deepseek: {
    id: "deepseek", name: "DeepSeek", protocol: "openai", baseUrl: "https://api.deepseek.com/v1",
    textModel: "deepseek-chat", imageModel: "", speechModel: "", voice: "",
    capabilities: TEXT_ONLY, requiresKey: true, outputTokenField: "max_tokens"
  },
  xai: {
    id: "xai", name: "xAI", protocol: "openai", baseUrl: "https://api.x.ai/v1",
    textModel: "grok-3-mini", imageModel: "", speechModel: "", voice: "",
    capabilities: TEXT_ONLY, requiresKey: true, outputTokenField: "max_tokens"
  },
  together: {
    id: "together", name: "Together AI", protocol: "openai", baseUrl: "https://api.together.xyz/v1",
    textModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo", imageModel: "", speechModel: "", voice: "",
    capabilities: TEXT_ONLY, requiresKey: true, outputTokenField: "max_tokens"
  },
  custom: {
    id: "custom", name: "OpenAI-compatible custom", protocol: "openai", baseUrl: "",
    textModel: "", imageModel: "", speechModel: "", voice: "nova",
    capabilities: ALL_MEDIA, requiresKey: false, outputTokenField: "max_tokens"
  },
  ollama: {
    id: "ollama", name: "Ollama", protocol: "ollama", baseUrl: "http://127.0.0.1:11434",
    textModel: "llama3.2", imageModel: "", speechModel: "", voice: "",
    capabilities: TEXT_ONLY, requiresKey: false, outputTokenField: "num_predict"
  }
});

const PLATFORM_CATALOG = deepFreeze(Object.values(PLATFORM_PRESETS).map(preset => ({
  id: preset.id, name: preset.name, protocol: preset.protocol, baseUrl: preset.baseUrl,
  textModel: preset.textModel, imageModel: preset.imageModel, speechModel: preset.speechModel,
  voice: preset.voice, capabilities: { ...preset.capabilities }, requiresKey: preset.requiresKey
})));

const PLATFORM_ALIASES = deepFreeze({
  google: "gemini", "google-gemini": "gemini", claude: "anthropic", "x-ai": "xai",
  togetherai: "together", "openai-compatible": "custom", compatible: "custom"
});

const ENVIRONMENT_FIELDS = deepFreeze({
  openai: { apiKey: ["OPENAI_API_KEY"], textModel: ["OPENAI_MODEL"], imageModel: ["OPENAI_IMAGE_MODEL"], speechModel: ["OPENAI_SPEECH_MODEL"], voice: ["OPENAI_VOICE"] },
  gemini: { apiKey: ["GEMINI_API_KEY", "GOOGLE_GEMINI_API_KEY", "GOOGLE_API_KEY"], textModel: ["GEMINI_MODEL", "GOOGLE_GEMINI_MODEL"], imageModel: ["GEMINI_IMAGE_MODEL"] },
  anthropic: { apiKey: ["ANTHROPIC_API_KEY"], textModel: ["ANTHROPIC_MODEL"] },
  openrouter: { apiKey: ["OPENROUTER_API_KEY"], textModel: ["OPENROUTER_MODEL"], imageModel: ["OPENROUTER_IMAGE_MODEL"] },
  groq: { apiKey: ["GROQ_API_KEY"], textModel: ["GROQ_MODEL"] },
  mistral: { apiKey: ["MISTRAL_API_KEY"], textModel: ["MISTRAL_MODEL"] },
  deepseek: { apiKey: ["DEEPSEEK_API_KEY"], textModel: ["DEEPSEEK_MODEL"] },
  xai: { apiKey: ["XAI_API_KEY", "X_AI_API_KEY"], textModel: ["XAI_MODEL", "X_AI_MODEL"] },
  together: { apiKey: ["TOGETHER_API_KEY", "TOGETHERAI_API_KEY"], textModel: ["TOGETHER_MODEL", "TOGETHERAI_MODEL"] },
  custom: {
    baseUrl: ["CUSTOM_OPENAI_BASE_URL", "OPENAI_COMPATIBLE_BASE_URL"], apiKey: ["CUSTOM_OPENAI_API_KEY", "OPENAI_COMPATIBLE_API_KEY"],
    textModel: ["CUSTOM_OPENAI_MODEL", "OPENAI_COMPATIBLE_MODEL"], imageModel: ["CUSTOM_OPENAI_IMAGE_MODEL"],
    speechModel: ["CUSTOM_OPENAI_SPEECH_MODEL"], voice: ["CUSTOM_OPENAI_VOICE"]
  },
  ollama: { baseUrl: ["OLLAMA_URL"], textModel: ["OLLAMA_MODEL"] }
});

function providerError(message, status, extras = {}) {
  const error = new Error(message);
  error.status = status;
  for (const [key, value] of Object.entries(extras)) if (value !== undefined) error[key] = value;
  return error;
}

function own(object, key) {
  return object != null && Object.prototype.hasOwnProperty.call(object, key);
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalPlatformId(value, protocol) {
  const raw = String(value || "").trim().toLowerCase();
  const id = PLATFORM_ALIASES[raw] || raw;
  if (PLATFORM_PRESETS[id]) return id;
  if (!id && protocol === "openai") return "custom";
  throw providerError("Platforma AI nu este recunoscută.", 400);
}

function cleanField(value, field, maximum, { allowEmpty = true } = {}) {
  if (value == null) return "";
  if (typeof value !== "string") throw providerError(`Câmpul ${field} trebuie să fie text.`, 400);
  const cleaned = value.trim();
  if (!allowEmpty && !cleaned) throw providerError(`Câmpul ${field} este obligatoriu.`, 400);
  if (cleaned.length > maximum || /[\u0000-\u001f\u007f]/.test(cleaned)) throw providerError(`Câmpul ${field} este invalid.`, 400);
  return cleaned;
}

function normalizedProviderModelId(providerId, value) {
  const model = String(value || "").trim();
  return providerId === "gemini" ? model.replace(/^models\/+/, "") : model;
}

function normalizeBaseUrl(value, { allowEmpty = false } = {}) {
  const raw = cleanField(value, "baseUrl", 2048, { allowEmpty });
  if (!raw && allowEmpty) return "";
  if (raw.includes("?") || raw.includes("#")) throw providerError("Adresa API nu poate conține query sau fragment.", 400);
  let url;
  try { url = new URL(raw); }
  catch { throw providerError("Adresa API nu este validă.", 400); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw providerError("Adresa API trebuie să fie HTTP(S), fără autentificare, query sau fragment.", 400);
  }
  const localHttp = url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw providerError("Serviciile AI externe trebuie să folosească HTTPS. HTTP este permis numai local.", 400);
  }
  return url.toString().replace(/\/+$/, "");
}

function valueFromUpdate(update, current, key, fallback, aliases = []) {
  for (const candidate of [key, ...aliases]) if (own(update, candidate)) return update[candidate];
  for (const candidate of [key, ...aliases]) if (own(current, candidate)) return current[candidate];
  return fallback;
}

function sanitizeProfileUpdate(update, currentProfile = {}) {
  if (!plainObject(update) || !plainObject(currentProfile)) throw providerError("Profilul AI este invalid.", 400);
  const rawId = valueFromUpdate(update, currentProfile, "id", "", ["platform", "provider"]);
  const protocolHint = valueFromUpdate(update, currentProfile, "protocol", "");
  const id = canonicalPlatformId(rawId, protocolHint);
  const preset = PLATFORM_PRESETS[id];
  const currentId = (() => {
    try { return canonicalPlatformId(currentProfile.id || currentProfile.platform || currentProfile.provider, currentProfile.protocol); }
    catch { return ""; }
  })();
  const current = currentId === id ? currentProfile : {};
  const suppliedBaseUrl = valueFromUpdate(update, current, "baseUrl", preset.baseUrl);
  let baseUrl;
  if (id === "custom") baseUrl = normalizeBaseUrl(suppliedBaseUrl, { allowEmpty: true });
  else if (id === "ollama") baseUrl = normalizeBaseUrl(suppliedBaseUrl || preset.baseUrl);
  else {
    const canonical = normalizeBaseUrl(preset.baseUrl);
    if (suppliedBaseUrl && normalizeBaseUrl(suppliedBaseUrl) !== canonical) {
      throw providerError(`Adresa API pentru ${preset.name} este fixată la hostul oficial. Folosește profilul custom pentru alt host.`, 400);
    }
    baseUrl = canonical;
  }
  const previousBaseUrl = current.baseUrl ? normalizeBaseUrl(current.baseUrl, { allowEmpty: id === "custom" }) : "";
  const previousOrigin = previousBaseUrl ? new URL(previousBaseUrl).origin : "";
  const nextOrigin = baseUrl ? new URL(baseUrl).origin : "";
  const originChanged = currentId === id && previousOrigin !== nextOrigin;
  if (own(update, "apiKey") && typeof update.apiKey !== "string") {
    throw providerError("Câmpul apiKey trebuie să fie text.", 400);
  }
  const hasNewKey = own(update, "apiKey") && typeof update.apiKey === "string" && update.apiKey.trim();
  let apiKey;
  if (update.clearApiKey === true) apiKey = "";
  else if (hasNewKey) apiKey = cleanField(update.apiKey, "apiKey", 4000);
  else if (originChanged) apiKey = "";
  else apiKey = cleanField(current.apiKey, "apiKey", 4000);
  return {
    id,
    name: cleanField(valueFromUpdate(update, current, "name", preset.name), "name", 100, { allowEmpty: false }),
    protocol: preset.protocol,
    baseUrl,
    apiKey,
    textModel: normalizedProviderModelId(id, cleanField(valueFromUpdate(update, current, "textModel", preset.textModel, ["model"]), "textModel", 240)),
    imageModel: normalizedProviderModelId(id, cleanField(valueFromUpdate(update, current, "imageModel", preset.imageModel), "imageModel", 240)),
    speechModel: cleanField(valueFromUpdate(update, current, "speechModel", preset.speechModel), "speechModel", 240),
    voice: cleanField(valueFromUpdate(update, current, "voice", preset.voice), "voice", 80),
    capabilities: { ...preset.capabilities },
    requiresKey: preset.requiresKey
  };
}

function validateProfileUpdate(update, currentProfile = {}) {
  return sanitizeProfileUpdate(update, currentProfile);
}

function firstEnvironmentValue(environment, names = []) {
  for (const name of names) if (typeof environment?.[name] === "string" && environment[name].trim()) return environment[name].trim();
  return "";
}

function createProfilesFromEnv(environment = process.env) {
  if (!plainObject(environment)) throw providerError("Mediul de configurare AI este invalid.", 400);
  const legacyOpenAiBase = firstEnvironmentValue(environment, ["OPENAI_BASE_URL"]);
  let legacyCustomBase = "";
  if (legacyOpenAiBase) {
    const normalizedLegacy = normalizeBaseUrl(legacyOpenAiBase);
    if (normalizedLegacy !== normalizeBaseUrl(PLATFORM_PRESETS.openai.baseUrl)) legacyCustomBase = normalizedLegacy;
  }
  return Object.values(PLATFORM_PRESETS).map(preset => {
    const fields = ENVIRONMENT_FIELDS[preset.id] || {};
    const values = { id: preset.id };
    // A legacy OPENAI_BASE_URL that targets another host represents the custom
    // profile. Keep its credential and model bound to that host only.
    if (!(preset.id === "openai" && legacyCustomBase)) {
      for (const key of ["baseUrl", "apiKey", "textModel", "imageModel", "speechModel", "voice"]) {
        const value = firstEnvironmentValue(environment, fields[key]);
        if (value) values[key] = value;
      }
    }
    if (preset.id === "custom" && !values.baseUrl && legacyCustomBase) {
      values.baseUrl = legacyCustomBase;
      values.apiKey ||= firstEnvironmentValue(environment, ["OPENAI_API_KEY"]);
      values.textModel ||= firstEnvironmentValue(environment, ["OPENAI_MODEL"]) || PLATFORM_PRESETS.openai.textModel;
      values.imageModel ||= firstEnvironmentValue(environment, ["OPENAI_IMAGE_MODEL"]) || PLATFORM_PRESETS.openai.imageModel;
      values.speechModel ||= firstEnvironmentValue(environment, ["OPENAI_SPEECH_MODEL"]) || PLATFORM_PRESETS.openai.speechModel;
      values.voice ||= firstEnvironmentValue(environment, ["OPENAI_VOICE"]) || PLATFORM_PRESETS.openai.voice;
    }
    return sanitizeProfileUpdate(values);
  });
}

function isProfileConfigured(profile) {
  try {
    const normalized = sanitizeProfileUpdate(profile);
    return Boolean(normalized.baseUrl && normalized.textModel && (!normalized.requiresKey || normalized.apiKey));
  } catch { return false; }
}

function normalizedTimeout(value, fallback) {
  if (value == null) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 600000) throw providerError("Timeout-ul furnizorului este invalid.", 400);
  return value;
}

function combineSignal(signal, timeout) {
  const timeoutSignal = AbortSignal.timeout(timeout);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function safeExtraHeaders(headers) {
  if (headers == null) return {};
  if (!plainObject(headers) && !(headers instanceof Headers)) throw providerError("Antetele furnizorului sunt invalide.", 400);
  const result = {};
  const entries = headers instanceof Headers ? headers.entries() : Object.entries(headers);
  for (const [rawName, rawValue] of entries) {
    const name = String(rawName).trim().toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name) || ["authorization", "proxy-authorization", "x-api-key", "x-goog-api-key", "host", "cookie", "set-cookie"].includes(name)) {
      throw providerError("Un antet rezervat nu poate fi suprascris.", 400);
    }
    result[name] = cleanField(String(rawValue), `header ${name}`, 2000);
  }
  return result;
}

function authHeaders(profile, geminiNative = false) {
  if (profile.requiresKey && !profile.apiKey) throw providerError(`Cheia API pentru ${profile.name} lipsește.`, 400, { provider: profile.id });
  if (!profile.apiKey) return {};
  if (geminiNative && profile.id === "gemini") return { "x-goog-api-key": profile.apiKey };
  if (profile.protocol === "anthropic") return { "x-api-key": profile.apiKey, "anthropic-version": ANTHROPIC_VERSION };
  return { authorization: `Bearer ${profile.apiKey}` };
}

function requestUrl(profile, route) {
  if (typeof route !== "string" || !route.startsWith("/") || route.startsWith("//") || route.includes("\\") || route.includes("#")) {
    throw providerError("Ruta furnizorului este invalidă.", 400);
  }
  if (!profile.baseUrl) throw providerError("Adresa API a profilului lipsește.", 400, { provider: profile.id });
  const base = new URL(profile.baseUrl);
  const url = new URL(`${profile.baseUrl.replace(/\/+$/, "")}${route}`);
  if (url.origin !== base.origin) throw providerError("Ruta furnizorului ar schimba hostul configurat.", 400, { provider: profile.id });
  return url.toString();
}

function responseIsOk(response) {
  if (typeof response?.ok === "boolean") return response.ok;
  return Number.isInteger(response?.status) && response.status >= 200 && response.status < 300;
}

async function responsePayload(response) {
  if (typeof response?.text === "function") {
    const text = await response.text();
    if (!text) return {};
    try { return JSON.parse(text); }
    catch { return { raw: text }; }
  }
  if (typeof response?.json === "function") {
    try { return await response.json(); }
    catch (error) { if (error instanceof SyntaxError) return { raw: "" }; throw error; }
  }
  return {};
}

function payloadErrorMessage(payload, response) {
  const nested = plainObject(payload?.error) ? payload.error.message || payload.error.detail || payload.error.type : payload?.error;
  const message = nested || payload?.message || payload?.detail || payload?.raw;
  return typeof message === "string" && message.trim()
    ? message.trim().slice(0, 2000)
    : `Furnizorul AI a răspuns cu HTTP ${response?.status || 502}.`;
}

function transportFailure(profile, cause) {
  const code = cause?.code || cause?.cause?.code;
  const timedOut = cause?.name === "AbortError" || cause?.name === "TimeoutError" || ["ABORT_ERR", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(code);
  const reportedStatus = Number(cause?.status);
  return providerError(timedOut ? "Conexiunea cu furnizorul AI a expirat." : "Furnizorul AI nu poate fi contactat.",
    Number.isInteger(reportedStatus) && reportedStatus >= 400 && reportedStatus <= 599 ? reportedStatus : timedOut ? 504 : 502,
    { provider: profile.id, code, cause, failureKind: timedOut ? "timeout" : "network" });
}

async function performRequest(profileInput, route, options = {}, fallbackTimeout = DEFAULT_TIMEOUT) {
  const profile = sanitizeProfileUpdate(profileInput);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw providerError("Nu există un client HTTP disponibil pentru furnizor.", 500, { provider: profile.id });
  const timeout = normalizedTimeout(options.timeout, fallbackTimeout);
  const headers = {
    ...safeExtraHeaders(options.headers),
    ...(options.contentType ? { "content-type": options.contentType } : {}),
    ...authHeaders(profile, options.geminiNative === true)
  };
  const target = profile.id === "gemini" && options.geminiNative === true
    ? { ...profile, baseUrl: "https://generativelanguage.googleapis.com/v1beta" } : profile;
  const url = requestUrl(target, route);
  let response;
  try {
    response = await fetchImpl(url, {
      method: options.method || (options.body == null ? "GET" : "POST"),
      headers,
      ...(options.body == null ? {} : { body: options.body }),
      signal: combineSignal(options.signal, timeout),
      redirect: "error"
    });
  } catch (cause) {
    throw transportFailure(profile, cause);
  }
  if (response && !Number.isInteger(response.status) && typeof response.ok === "boolean") {
    // Test doubles and a few embedded fetch bridges expose `ok` without `status`.
    response = { ...response, status: response.ok ? 200 : 502 };
  }
  if (!response || !Number.isInteger(response.status)) throw providerError("Furnizorul AI a returnat un răspuns HTTP invalid.", 502, { provider: profile.id, failureKind: "invalid_response" });
  return { profile, response };
}

function retryAfterMilliseconds(response, payload) {
  const raw = response?.headers?.get?.("retry-after");
  if (typeof raw !== "string" || !raw.trim() || raw.length > 128) {
    const details = payload?.error?.details;
    if (!Array.isArray(details)) return undefined;
    const retry = details.find(detail => detail?.['@type'] === 'type.googleapis.com/google.rpc.RetryInfo');
    const duration = typeof retry?.retryDelay === 'string' && retry.retryDelay.match(/^(\d{1,9})(?:\.(\d{1,9}))?s$/);
    if (!duration) return undefined;
    return Math.ceil(Number(duration[1] + (duration[2] ? '.' + duration[2] : '')) * 1000);
  }
  const value = raw.trim();
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.ceil(Number(value) * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

async function jsonRequest(profileInput, route, options = {}, fallbackTimeout = DEFAULT_TIMEOUT) {
  const { profile, response } = await performRequest(profileInput, route, options, fallbackTimeout);
  let payload;
  try { payload = await responsePayload(response); }
  catch (cause) {
    if (!responseIsOk(response)) throw providerError("Furnizorul AI a refuzat cererea.", response.status, {
      provider: profile.id, failureKind: "http", upstreamStatus: response.status, cause
    });
    throw transportFailure(profile, cause);
  }
  if (!responseIsOk(response)) {
    const remoteError = plainObject(payload?.error) ? payload.error : {};
    throw providerError(payloadErrorMessage(payload, response), response.status, {
      provider: profile.id, code: remoteError.code || remoteError.type || payload?.code, details: payload,
      failureKind: "http", upstreamStatus: response.status, retryAfterMs: retryAfterMilliseconds(response, payload)
    });
  }
  if (!plainObject(payload) || own(payload, "raw")) throw providerError("Furnizorul AI nu a returnat JSON valid.", 502, { provider: profile.id, failureKind: "invalid_response" });
  if (plainObject(payload.error)) {
    const code = Number(payload.error.code);
    const status = Number.isInteger(code) && code >= 400 && code <= 599 ? code : 502;
    throw providerError(payloadErrorMessage(payload, response), status, {
      provider: profile.id, code: payload.error.code, failureKind: "provider_error", upstreamStatus: response.status, retryAfterMs: retryAfterMilliseconds(response, payload)
    });
  }
  return payload;
}

function normalizedRequestOptions(options, timeoutArgument) {
  if (typeof options === "number") return { timeout: options };
  if (!plainObject(options)) throw providerError("Opțiunile cererii către furnizor sunt invalide.", 400);
  return { ...options, ...(timeoutArgument == null ? {} : { timeout: timeoutArgument }) };
}

async function openAiCompatibleJson(profile, route, options = {}, timeoutArgument) {
  const normalized = sanitizeProfileUpdate(profile);
  if (normalized.protocol !== "openai") throw providerError("Profilul nu folosește protocolul OpenAI-compatible.", 400, { provider: normalized.id });
  const requestOptions = normalizedRequestOptions(options, timeoutArgument);
  let body = requestOptions.body;
  if (own(requestOptions, "json")) body = JSON.stringify(requestOptions.json);
  else if (body != null && plainObject(body) && !(body instanceof FormData)) body = JSON.stringify(body);
  return jsonRequest(normalized, route, {
    ...requestOptions,
    body,
    contentType: body != null && !(body instanceof FormData) ? "application/json" : undefined
  });
}

async function openAiCompatibleBytes(profile, route, body, options = {}) {
  const normalized = sanitizeProfileUpdate(profile);
  if (normalized.protocol !== "openai") throw providerError("Profilul nu folosește protocolul OpenAI-compatible.", 400, { provider: normalized.id });
  const requestOptions = typeof options === "number" ? { timeout: options } : normalizedRequestOptions(options);
  const serialized = typeof body === "string" || body instanceof Uint8Array || body instanceof ArrayBuffer ? body : JSON.stringify(body);
  const { response } = await performRequest(normalized, route, {
    ...requestOptions, method: requestOptions.method || "POST", body: serialized,
    contentType: requestOptions.contentType || "application/json"
  });
  if (!responseIsOk(response)) {
    const payload = await responsePayload(response);
    throw providerError(payloadErrorMessage(payload, response), response.status, { provider: normalized.id, details: payload });
  }
  const mime = String(response.headers?.get?.("content-type") || "application/octet-stream").split(";", 1)[0].trim().toLowerCase();
  const expected = requestOptions.expectedMimePrefix || "audio/";
  if (!mime.startsWith(expected) && mime !== "application/octet-stream") {
    throw providerError("Furnizorul media a returnat un tip de fișier neașteptat.", 502, { provider: normalized.id });
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw providerError("Furnizorul media a returnat un fișier gol.", 502, { provider: normalized.id });
  const fallbackMime = expected === "audio/" ? "audio/mpeg" : "application/octet-stream";
  return { mime: mime === "application/octet-stream" ? fallbackMime : mime, base64: bytes.toString("base64") };
}

function imageBytes(image) {
  if (Buffer.isBuffer(image) || image instanceof Uint8Array) return { bytes: image, mime: "image/png", extension: "png" };
  if (!plainObject(image) || !(Buffer.isBuffer(image.bytes) || image.bytes instanceof Uint8Array)) throw providerError("Imaginea pentru editare este invalidă.", 400);
  const mime = ["image/png", "image/jpeg", "image/webp"].includes(image.mime) ? image.mime : "image/png";
  return { bytes: image.bytes, mime, extension: mime === "image/jpeg" ? "jpg" : mime.slice(6) };
}

async function openAiCompatibleImageEdit(profile, image, prompt, options = {}) {
  const normalized = sanitizeProfileUpdate(profile);
  if (normalized.protocol !== "openai") throw providerError("Profilul nu folosește protocolul OpenAI-compatible.", 400, { provider: normalized.id });
  const requestOptions = typeof options === "number" ? { timeout: options } : normalizedRequestOptions(options);
  const source = imageBytes(image);
  const cleanPrompt = cleanField(prompt, "prompt", Infinity, { allowEmpty: false });
  const model = cleanField(requestOptions.model || normalized.imageModel, "imageModel", 240, { allowEmpty: false });
  const form = new FormData();
  form.set("model", model);
  form.set("prompt", cleanPrompt);
  form.set("image", new Blob([source.bytes], { type: source.mime }), `nova-input.${source.extension}`);
  form.set("size", cleanField(requestOptions.size || "1024x1024", "size", 40, { allowEmpty: false }));
  // DALL-E 2 edits reject the GPT-image quality parameter and otherwise
  // return an expiring URL instead of image bytes suitable for saved history.
  if (/(?:^|\/)dall-?e-?2$/i.test(model)) form.set("response_format", "b64_json");
  else form.set("quality", cleanField(requestOptions.quality || "high", "quality", 40, { allowEmpty: false }));
  form.set("n", String(Number.isSafeInteger(requestOptions.n) && requestOptions.n > 0 ? requestOptions.n : 1));
  return openAiCompatibleJson(normalized, "/images/edits", { ...requestOptions, method: "POST", body: form, headers: requestOptions.headers });
}

function uniqueModelIds(items, keys) {
  const seen = new Set();
  const models = [];
  for (const item of items) {
    const candidate = typeof item === "string" ? item : keys.map(key => item?.[key]).find(value => typeof value === "string");
    if (typeof candidate !== "string") continue;
    const id = candidate.trim();
    if (!id || id.length > 240 || /[\u0000-\u001f\u007f]/.test(id) || seen.has(id)) continue;
    seen.add(id);
    models.push(id);
  }
  return models;
}

async function listProfileModels(profileInput, options = {}) {
  const profile = sanitizeProfileUpdate(profileInput);
  const requestOptions = normalizedRequestOptions(options);
  let payload;
  let items;
  if (profile.protocol === "ollama") {
    payload = await jsonRequest(profile, "/api/tags", requestOptions, MODEL_LIST_TIMEOUT);
    if (!Array.isArray(payload.models)) throw providerError("Ollama nu a returnat un catalog de modele valid.", 502, { provider: profile.id });
    items = uniqueModelIds(payload.models, ["model", "name", "id"]);
  } else if (profile.protocol === "anthropic") {
    payload = await jsonRequest(profile, "/models", requestOptions, MODEL_LIST_TIMEOUT);
    if (!Array.isArray(payload.data)) throw providerError("Anthropic nu a returnat un catalog de modele valid.", 502, { provider: profile.id });
    items = uniqueModelIds(payload.data, ["id", "name", "model"]);
  } else {
    payload = await openAiCompatibleJson(profile, "/models", { ...requestOptions, method: "GET", timeout: requestOptions.timeout || MODEL_LIST_TIMEOUT });
    if (!Array.isArray(payload.data)) throw providerError("Furnizorul nu a returnat un catalog de modele valid.", 502, { provider: profile.id });
    const entries = profile.id === "openrouter" ? payload.data.filter(item =>
      !Array.isArray(item?.architecture?.output_modalities) || item.architecture.output_modalities.includes("text")) : payload.data;
    items = uniqueModelIds(entries, ["id", "model", "name"]);
  }
  if (!items.length && requestOptions.fallback !== false && profile.textModel) return [profile.textModel];
  return [...new Set(items.map(item => normalizedProviderModelId(profile.id, item)).filter(Boolean))];
}

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);

function normalizedImageOutput(profile, base64, mime = "image/png") {
  if (!IMAGE_MIMES.has(mime) || typeof base64 !== "string" || !base64
    || base64.length > 32 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw providerError("Motorul a returnat date de imagine invalide sau un format neacceptat.", 502, { provider: profile.id, failureKind: "invalid_response" });
  }
  return { b64_json: base64, output_format: mime.slice(6) };
}

async function generateProfileImage(profileInput, prompt, options = {}) {
  const profile = sanitizeProfileUpdate(profileInput);
  if (!["gemini", "openrouter"].includes(profile.id)) throw providerError("Motorul nu folosește această integrare de imagini.", 400, { provider: profile.id });
  if (!profile.apiKey) throw providerError(`Cheia API pentru ${profile.name} lipsește.`, 400, { provider: profile.id });
  const model = normalizedProviderModelId(profile.id, cleanField(options.model || profile.imageModel, "imageModel", 240, { allowEmpty: false }));
  const text = cleanField(prompt, "prompt", Infinity, { allowEmpty: false });
  const source = options.image == null ? null : imageBytes(options.image);
  const request = { method: "POST", timeout: options.timeout || 300000, signal: options.signal, fetchImpl: options.fetchImpl };
  if (profile.id === "openrouter") {
    const payload = await openAiCompatibleJson(profile, "/images", { ...request, json: {
      model, prompt: text, n: 1,
      ...(source ? { input_references: [{ type: "image_url", image_url: { url: `data:${source.mime};base64,${Buffer.from(source.bytes).toString("base64")}` } }] } : {})
    } });
    const image = payload.data?.[0];
    if (!image?.b64_json) throw providerError("Modelul OpenRouter nu a returnat o imagine. Alege un model de generare a imaginilor.", 502, { provider: profile.id, failureKind: "invalid_response" });
    return { data: [normalizedImageOutput(profile, image.b64_json, image.media_type || "image/png")] };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model)) throw providerError("Identificatorul modelului Gemini pentru imagini este invalid.", 400, { provider: profile.id });
  const payload = await jsonRequest(profile, `/models/${encodeURIComponent(model)}:generateContent`, {
    ...request, geminiNative: true, contentType: "application/json", body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text }, ...(source ? [{ inlineData: { mimeType: source.mime, data: Buffer.from(source.bytes).toString("base64") } }] : [])] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"] }
    })
  });
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const parts = candidates.flatMap(candidate => Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []);
  const image = parts.find(part => part?.thought !== true && (part?.inlineData?.data || part?.inline_data?.data));
  if (!image) {
    const blocked = payload.promptFeedback?.blockReason || candidates.some(candidate => /SAFETY|PROHIBITED|BLOCKLIST|RECITATION/.test(candidate?.finishReason || ""));
    throw providerError(blocked ? "Gemini a refuzat generarea acestei imagini. Reformulează descrierea." : "Modelul Gemini nu a returnat o imagine. Alege un model Gemini cu generare de imagini.",
      blocked ? 422 : 502, { provider: profile.id, failureKind: blocked ? "content_filter" : "invalid_response" });
  }
  const inline = image.inlineData || image.inline_data;
  return { data: [normalizedImageOutput(profile, inline.data, inline.mimeType || inline.mime_type || "image/png")] };
}

async function listProfileImageModels(profileInput, options = {}) {
  const profile = sanitizeProfileUpdate(profileInput);
  if (!profile.capabilities.image) return [];
  const request = { ...normalizedRequestOptions(options), method: "GET", timeout: options.timeout || MODEL_LIST_TIMEOUT };
  if (profile.id === "gemini") {
    const signal = combineSignal(options.signal, request.timeout), models = [], tokens = new Set();
    let token = "";
    do {
      signal.throwIfAborted();
      const payload = await jsonRequest(profile, `/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`, { ...request, signal, geminiNative: true });
      if (!Array.isArray(payload.models)) throw providerError("Gemini nu a returnat un catalog de modele valid.", 502, { provider: profile.id, failureKind: "invalid_response" });
      models.push(...uniqueModelIds(payload.models.filter(item => /^models\/gemini-.*image/i.test(item?.name || "")
        && (!Array.isArray(item.supportedGenerationMethods) || item.supportedGenerationMethods.includes("generateContent"))), ["name"]));
      token = typeof payload.nextPageToken === "string" ? payload.nextPageToken : "";
      if (token && tokens.has(token)) throw providerError("Catalogul Gemini a repetat pagina de modele.", 502, { provider: profile.id, failureKind: "invalid_response" });
      tokens.add(token);
    } while (token);
    return [...new Set(models.map(model => normalizedProviderModelId(profile.id, model)))];
  }
  if (profile.id === "openrouter") {
    const payload = await openAiCompatibleJson(profile, "/images/models", request);
    if (!Array.isArray(payload.data)) throw providerError("OpenRouter nu a returnat un catalog de imagini valid.", 502, { provider: profile.id, failureKind: "invalid_response" });
    return uniqueModelIds(payload.data.filter(item => (!Array.isArray(item?.architecture?.output_modalities) || item.architecture.output_modalities.includes("image"))
      && (!options.imageEdit || !Array.isArray(item?.architecture?.input_modalities) || item.architecture.input_modalities.includes("image"))), ["id"]);
  }
  return (await listProfileModels(profile, { ...request, fallback: false })).filter(model => /(gpt-image|dall-?e|imagen|flux|stable[-_. ]?diffusion|image[-_. ]?(?:gen|generation))/i.test(model));
}

function requestedModel(profile, model) {
  return normalizedProviderModelId(profile.id, cleanField(model || profile.textModel, "model", 240, { allowEmpty: false }));
}

function normalizedMaxTokens(value) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000000) throw providerError("Limita de răspuns a modelului este invalidă.", 400);
  return value;
}

function toolName(tool) {
  return typeof tool?.function?.name === "string" ? tool.function.name : typeof tool?.name === "string" ? tool.name : "";
}

function webToolChoice(tools, anthropic = false) {
  const name = Array.isArray(tools) && tools.some(tool => toolName(tool) === "web_search") ? "web_search" : "";
  if (!name) return undefined;
  return anthropic ? { type: "tool", name } : { type: "function", function: { name } };
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) return content.map(block => {
    if (typeof block === "string") return block;
    return block?.type === "text" && typeof block.text === "string" ? block.text : "";
  }).join("");
  return String(content);
}

function googleThoughtSignature(value) {
  const signature = value?.extra_content?.google?.thought_signature;
  return typeof signature === "string" && signature
    ? { extra_content: { google: { thought_signature: signature } } } : {};
}

function normalizedToolCalls(toolCalls, preserveGoogleSignature = false) {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.flatMap((call, index) => {
    const name = toolName(call);
    if (!name) return [];
    let args = call?.function?.arguments ?? call?.input ?? {};
    if (typeof args !== "string") {
      try { args = JSON.stringify(args ?? {}); }
      catch { args = "{}"; }
    }
    return [{
      id: cleanField(String(call.id || `call_${index + 1}`), "tool call id", 240, { allowEmpty: false }),
      type: "function",
      function: { name: cleanField(name, "tool name", 240, { allowEmpty: false }), arguments: args },
      ...(preserveGoogleSignature ? googleThoughtSignature(call) : {})
    }];
  });
}

function normalizedChatResult(profile, model, message) {
  if (!plainObject(message)) throw providerError("Furnizorul AI nu a returnat un mesaj valid.", 502, { provider: profile.id, failureKind: "invalid_response" });
  const toolCalls = normalizedToolCalls(message.tool_calls, profile.id === "gemini");
  return {
    message: {
      role: typeof message.role === "string" && message.role ? message.role : "assistant",
      content: messageText(message.content),
      ...(profile.id === "gemini" ? googleThoughtSignature(message) : {}),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {})
    },
    model,
    provider: profile.id,
    providerName: profile.name
  };
}

function parseToolArguments(value) {
  if (value == null || value === "") return {};
  if (plainObject(value) || Array.isArray(value)) return value;
  if (typeof value !== "string") throw providerError("Argumentele instrumentului sunt invalide.", 400);
  try {
    const parsed = JSON.parse(value);
    if (!plainObject(parsed) && !Array.isArray(parsed)) throw new Error("not an object");
    return parsed;
  } catch { throw providerError("Argumentele instrumentului nu sunt JSON valid.", 400); }
}

function anthropicContentBlocks(content, role) {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return content == null ? [] : [{ type: "text", text: String(content) }];
  const blocks = [];
  for (const block of content) {
    if (typeof block === "string") blocks.push({ type: "text", text: block });
    else if (block?.type === "text" && typeof block.text === "string") blocks.push({ type: "text", text: block.text });
    else if (role === "assistant" && block?.type === "tool_use" && block.id && block.name) {
      blocks.push({ type: "tool_use", id: String(block.id), name: String(block.name), input: parseToolArguments(block.input) });
    } else if (role === "user" && block?.type === "tool_result" && block.tool_use_id) {
      blocks.push({ type: "tool_result", tool_use_id: String(block.tool_use_id), content: block.content == null ? "" : block.content, ...(block.is_error ? { is_error: true } : {}) });
    } else if (role === "user" && block?.type === "image" && plainObject(block.source)) {
      blocks.push({ type: "image", source: block.source });
    } else if (role === "user" && block?.type === "image_url" && typeof block.image_url?.url === "string") {
      const match = block.image_url.url.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([a-zA-Z0-9+/]+={0,2})$/);
      if (match) blocks.push({ type: "image", source: { type: "base64", media_type: match[1], data: match[2] } });
    }
  }
  return blocks;
}

function appendAnthropicMessage(messages, role, blocks) {
  if (!blocks.length) return;
  const previous = messages.at(-1);
  if (previous?.role === role && Array.isArray(previous.content)) previous.content.push(...blocks);
  else messages.push({ role, content: blocks });
}

function toAnthropicRequest(messages, tools) {
  if (!Array.isArray(messages)) throw providerError("Lista de mesaje este invalidă.", 400);
  const system = [];
  const converted = [];
  for (const message of messages) {
    if (!plainObject(message)) throw providerError("Un mesaj AI este invalid.", 400);
    const role = String(message.role || "").toLowerCase();
    if (role === "system" || role === "developer") {
      const text = messageText(message.content).trim();
      if (text) system.push(text);
      continue;
    }
    if (role === "tool" || role === "function") {
      const toolUseId = cleanField(message.tool_call_id || message.id || message.name, "tool_call_id", 240, { allowEmpty: false });
      appendAnthropicMessage(converted, "user", [{ type: "tool_result", tool_use_id: toolUseId, content: message.content == null ? "" : message.content }]);
      continue;
    }
    if (role !== "user" && role !== "assistant") throw providerError(`Rolul de mesaj ${role || "lipsă"} nu este acceptat.`, 400);
    const blocks = anthropicContentBlocks(message.content, role);
    if (role === "assistant") {
      for (const call of normalizedToolCalls(message.tool_calls)) {
        blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input: parseToolArguments(call.function.arguments) });
      }
    }
    appendAnthropicMessage(converted, role, blocks);
  }
  if (!converted.length) throw providerError("Conversația nu conține mesaje pentru model.", 400);
  const convertedTools = Array.isArray(tools) ? tools.flatMap(tool => {
    const source = tool?.type === "function" ? tool.function : tool;
    if (!source || typeof source.name !== "string" || !source.name.trim()) return [];
    const schema = plainObject(source.parameters) ? source.parameters : plainObject(source.input_schema) ? source.input_schema : { type: "object", properties: {} };
    return [{
      name: cleanField(source.name, "tool name", 240, { allowEmpty: false }),
      ...(typeof source.description === "string" && source.description.trim() ? { description: source.description.trim().slice(0, 2000) } : {}),
      input_schema: schema
    }];
  }) : [];
  return { system: system.join("\n\n"), messages: converted, tools: convertedTools };
}

async function anthropicChat(profile, request) {
  const converted = toAnthropicRequest(request.messages, request.tools);
  const choice = request.forceWebTool ? webToolChoice(request.tools, true) : undefined;
  const payload = await jsonRequest(profile, "/messages", {
    method: "POST",
    body: JSON.stringify({
      model: request.model, max_tokens: request.maxOutputTokens || 4096,
      ...(converted.system ? { system: converted.system } : {}), messages: converted.messages,
      ...(converted.tools.length ? { tools: converted.tools } : {}), ...(choice ? { tool_choice: choice } : {})
    }),
    contentType: "application/json", fetchImpl: request.fetchImpl, timeout: request.timeout, signal: request.signal
  });
  if (!Array.isArray(payload.content)) throw providerError("Anthropic nu a returnat un mesaj valid.", 502, { provider: profile.id, failureKind: "invalid_response" });
  const text = payload.content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text).join("");
  const toolCalls = payload.content.filter(block => block?.type === "tool_use" && block.id && block.name).map(block => ({
    id: String(block.id), type: "function", function: { name: String(block.name), arguments: JSON.stringify(block.input ?? {}) }
  }));
  return normalizedChatResult(profile, String(payload.model || request.model), {
    role: "assistant", content: text, ...(toolCalls.length ? { tool_calls: toolCalls } : {})
  });
}

async function openAiChat(profile, request) {
  if (!Array.isArray(request.messages) || !request.messages.length) throw providerError("Lista de mesaje este invalidă.", 400);
  const preset = PLATFORM_PRESETS[profile.id] || PLATFORM_PRESETS.custom;
  const choice = request.forceWebTool ? webToolChoice(request.tools) : undefined;
  const tools = profile.id === "gemini" && Array.isArray(request.tools) ? request.tools.map(tool => {
    const parameters = tool?.function?.parameters;
    if (tool?.type !== "function" || parameters?.type !== "object"
      || !plainObject(parameters.properties) || Object.keys(parameters.properties).length
      || parameters.required?.length) return tool;
    // Google represents parameterless functions by omitting the schema.
    const { parameters: unused, ...declaration } = tool.function;
    return { ...tool, function: declaration };
  }) : request.tools;
  const body = {
    model: request.model, messages: request.messages,
    ...(Array.isArray(tools) && tools.length ? { tools } : {}),
    ...(choice ? { tool_choice: choice } : {}),
    ...(request.maxOutputTokens ? { [preset.outputTokenField]: request.maxOutputTokens } : {})
  };
  const payload = await openAiCompatibleJson(profile, "/chat/completions", {
    method: "POST", json: body, fetchImpl: request.fetchImpl, timeout: request.timeout, signal: request.signal
  });
  try { return normalizedChatResult(profile, String(payload.model || request.model), payload.choices?.[0]?.message); }
  catch (cause) {
    if (cause?.status) throw cause;
    throw providerError("Răspunsul modelului nu poate fi interpretat.", 502, { provider: profile.id, failureKind: "invalid_response", cause });
  }
}

async function ollamaChat(profile, request) {
  if (!Array.isArray(request.messages) || !request.messages.length) throw providerError("Lista de mesaje este invalidă.", 400);
  let tools = Array.isArray(request.tools) && request.tools.length ? request.tools : undefined;
  if (request.forceWebTool && tools?.some(tool => toolName(tool) === "web_search")) tools = tools.filter(tool => toolName(tool) === "web_search");
  const callNames = new Map();
  const messages = request.messages.map(message => {
    for (const call of normalizedToolCalls(message?.tool_calls)) callNames.set(call.id, call.function.name);
    if (message?.role !== "tool") return message;
    const toolNameValue = message.tool_name || message.name || callNames.get(String(message.tool_call_id || ""));
    return { role: "tool", content: message.content == null ? "" : String(message.content), ...(toolNameValue ? { tool_name: toolNameValue } : {}) };
  });
  const payload = await jsonRequest(profile, "/api/chat", {
    method: "POST",
    body: JSON.stringify({
      model: request.model, stream: false, messages, ...(tools ? { tools } : {}),
      options: { temperature: 0.2, ...(request.maxOutputTokens ? { num_predict: request.maxOutputTokens } : {}) }
    }),
    contentType: "application/json", fetchImpl: request.fetchImpl, timeout: request.timeout, signal: request.signal
  });
  return normalizedChatResult(profile, String(payload.model || request.model), payload.message);
}

async function openRouterChat(profile, request) {
  const callerSignal = request.signal;
  const deadline = AbortSignal.timeout(request.timeout);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
  const checkActive = () => {
    callerSignal?.throwIfAborted();
    if (deadline.aborted) throw providerError("Conexiunea cu furnizorul AI a expirat.", 504, { provider: profile.id, failureKind: "timeout" });
  };
  const started = Date.now();
  try {
    try { return await openAiChat(profile, { ...request, signal }); }
    catch (error) {
      checkActive();
      const retryable = Number(error.status) === 502 && (
        ["http", "provider_error", "invalid_response"].includes(error.failureKind)
        || error.failureKind === "network" && ["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "EAI_AGAIN"].includes(error.code));
      if (!retryable) throw error;
      const pause = Math.max(1000, error.retryAfterMs || 0);
      if (!Number.isFinite(pause) || pause >= request.timeout - (Date.now() - started)) throw error;
      await delay(pause, undefined, { signal });
      checkActive();
      return await openAiChat(profile, { ...request, signal });
    }
  } catch (error) {
    checkActive();
    throw error;
  }
}

async function chatWithProfile(profileInput, options = {}) {
  if (!plainObject(options)) throw providerError("Opțiunile conversației sunt invalide.", 400);
  const profile = sanitizeProfileUpdate(profileInput);
  if (!isProfileConfigured(profile)) throw providerError(`Profilul ${profile.name} nu este configurat complet.`, 400, { provider: profile.id });
  const request = {
    model: requestedModel(profile, options.model), messages: options.messages, tools: options.tools,
    maxOutputTokens: normalizedMaxTokens(options.maxOutputTokens), forceWebTool: options.forceWebTool === true,
    fetchImpl: options.fetchImpl, timeout: normalizedTimeout(options.timeout, DEFAULT_TIMEOUT), signal: options.signal
  };
  if (profile.id === "openrouter") return openRouterChat(profile, request);
  if (profile.protocol === "anthropic") return anthropicChat(profile, request);
  if (profile.protocol === "ollama") return ollamaChat(profile, request);
  return openAiChat(profile, request);
}

function isTransientProviderError(error, seen = new Set()) {
  if (!error || (typeof error !== "object" && typeof error !== "function") || seen.has(error)) return false;
  seen.add(error);
  const status = Number(error.status || error.statusCode || error.response?.status);
  if (TRANSIENT_STATUSES.has(status) || status >= 500 && status <= 599) return true;
  const code = String(error.code || error.cause?.code || "").toUpperCase();
  if (TRANSIENT_CODES.has(code) || code.startsWith("UND_ERR_")) return true;
  if (["AbortError", "TimeoutError"].includes(error.name)) return true;
  const remoteType = String(error.type || error.details?.error?.type || "").toLowerCase();
  if (["overloaded_error", "rate_limit_error", "timeout_error"].includes(remoteType)) return true;
  return isTransientProviderError(error.cause, seen);
}

module.exports = {
  PLATFORM_PRESETS,
  PLATFORM_CATALOG,
  catalog: PLATFORM_CATALOG,
  platformCatalog: PLATFORM_CATALOG,
  createProfilesFromEnv,
  sanitizeProfileUpdate,
  validateProfileUpdate,
  validateAndSanitizeProfileUpdate: sanitizeProfileUpdate,
  isProfileConfigured,
  listProfileModels,
  listProfileImageModels,
  generateProfileImage,
  chatWithProfile,
  openAiCompatibleJson,
  openAiCompatibleBytes,
  openAiCompatibleImageEdit,
  isTransientProviderError
};
