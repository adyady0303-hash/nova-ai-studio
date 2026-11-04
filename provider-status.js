"use strict";

const { createHash } = require("node:crypto");

const STATUS_TTL_MS = 60000;
const MAX_PROVIDERS = 100;

function profileSignature(profile) {
  return createHash("sha256").update(JSON.stringify([
    profile.id, profile.baseUrl, profile.textModel, profile.apiKey
  ])).digest("hex");
}

function configuredModel(profile) {
  return typeof profile?.textModel === "string" ? profile.textModel : "";
}

function failureState(error) {
  if (error?.failureKind === "network") return "network_error";
  if (error?.failureKind === "timeout") return "timeout";
  if (error?.failureKind === "invalid_response") return "invalid_response";
  const status = Number(error?.status || error?.upstreamStatus);
  if ([401, 403].includes(status)) return "auth_error";
  if (status === 429) return "quota";
  if ([408, 504].includes(status)) return "timeout";
  if ([400, 404, 422].includes(status)) return "model_error";
  return "unavailable";
}

/**
 * Remember recent text-provider outcomes separately from saved configuration.
 * `safeMessage` must be a caller-generated friendly message, never a raw error.
 * No credentials, provider responses or exception objects are retained.
 */
function createProviderStatus({ now = Date.now } = {}) {
  const statuses = new Map();

  function unchecked(profile) {
    return { state: "unchecked", checkedAt: null, model: configuredModel(profile), error: "" };
  }

  function get(profile) {
    const entry = statuses.get(profile?.id);
    if (!entry) return unchecked(profile);
    if (entry.signature !== profileSignature(profile) || now() - entry.timestamp >= STATUS_TTL_MS) {
      statuses.delete(profile.id);
      return unchecked(profile);
    }
    return { state: entry.state, checkedAt: new Date(entry.timestamp).toISOString(), model: entry.model, error: entry.error };
  }

  function remember(profile, state, model, error) {
    if (typeof profile?.id !== "string" || !profile.id) return unchecked(profile);
    // Replacing a provider moves it to the end so eviction keeps recent outcomes.
    statuses.delete(profile.id);
    statuses.set(profile.id, { signature: profileSignature(profile), timestamp: now(), state, model, error });
    while (statuses.size > MAX_PROVIDERS) statuses.delete(statuses.keys().next().value);
    return get(profile);
  }

  function success(profile, result) {
    const model = typeof result?.model === "string" && result.model ? result.model : configuredModel(profile);
    return remember(profile, "available", model, "");
  }

  function failure(profile, error, safeMessage = "") {
    return remember(profile, failureState(error), configuredModel(profile), typeof safeMessage === "string" ? safeMessage : "");
  }

  function clear(id) {
    if (id === undefined) statuses.clear();
    else statuses.delete(id);
  }

  return { get, success, failure, clear };
}

module.exports = { createProviderStatus };
