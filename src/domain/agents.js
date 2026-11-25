// Agent registry rules: validation, lifecycle and least-privilege defaults.
import { badRequest } from "../http.js";
import { TOOL_CATALOG } from "../orchestration/tools.js";
import { PROVIDER_CATALOG } from "../orchestration/providers.js";

export const AGENT_TYPES = Object.freeze(["assistant", "researcher", "operator", "reviewer", "custom"]);
export const AGENT_STATUSES = Object.freeze(["draft", "active", "paused", "disabled", "error"]);
export const CAPABILITIES = Object.freeze(["research", "drafting", "summarization", "review", "operations"]);

const AGENT_TRANSITIONS = Object.freeze({
  draft: ["active", "disabled"],
  active: ["paused", "disabled"],
  paused: ["active", "disabled"],
  disabled: ["draft"],
  error: ["active", "paused", "disabled"]
});

export function canTransitionAgent(from, to) {
  return Boolean(AGENT_TRANSITIONS[from]?.includes(to));
}

function uniqueSubset(value, allowed, field) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 20) throw badRequest(`${field} must be an array of at most 20 values.`);
  const out = [];
  for (const item of value) {
    if (typeof item !== "string" || !allowed.includes(item)) throw badRequest(`${field} contains an unsupported value: ${String(item).slice(0, 40)}.`);
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

function intField(value, field, min, max) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < min || value > max) throw badRequest(`${field} must be an integer between ${min} and ${max}.`);
  return value;
}

/**
 * Validates agent create/update input. With partial=true only supplied fields are validated.
 * New agents start as draft with no tools: least privilege by default.
 */
export function validateAgentInput(input, { partial = false } = {}) {
  if (!input || typeof input !== "object") throw badRequest("Agent data is required.");
  const out = {};
  if (!partial || input.name !== undefined) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (name.length < 2 || name.length > 80) throw badRequest("Agent name must be between 2 and 80 characters.");
    out.name = name;
  }
  if (input.description !== undefined) {
    if (typeof input.description !== "string" || input.description.trim().length > 1000) throw badRequest("Description must be 1,000 characters or fewer.");
    out.description = input.description.trim();
  } else if (!partial) out.description = "";
  if (!partial || input.agent_type !== undefined) {
    const type = input.agent_type ?? "assistant";
    if (!AGENT_TYPES.includes(type)) throw badRequest("Unsupported agent type.");
    out.agent_type = type;
  }
  if (!partial || input.provider !== undefined || input.model !== undefined) {
    const provider = input.provider ?? "mock";
    const entry = PROVIDER_CATALOG[provider];
    if (!entry || !entry.enabled) throw badRequest("Provider is not available. Only configured providers can be used.");
    const model = input.model ?? entry.models[0];
    if (!entry.models.includes(model)) throw badRequest("Model is not available for this provider.");
    out.provider = provider;
    out.model = model;
  }
  const caps = uniqueSubset(input.capabilities, CAPABILITIES, "capabilities");
  if (caps !== undefined) out.capabilities = caps; else if (!partial) out.capabilities = [];
  const tools = uniqueSubset(input.allowed_tools, Object.keys(TOOL_CATALOG), "allowed_tools");
  if (tools !== undefined) out.allowed_tools = tools; else if (!partial) out.allowed_tools = [];
  const maxSteps = intField(input.max_steps, "max_steps", 1, 20);
  const timeout = intField(input.timeout_ms, "timeout_ms", 100, 30000);
  const retries = intField(input.max_retries, "max_retries", 0, 3);
  if (maxSteps !== undefined) out.max_steps = maxSteps; else if (!partial) out.max_steps = 8;
  if (timeout !== undefined) out.timeout_ms = timeout; else if (!partial) out.timeout_ms = 10000;
  if (retries !== undefined) out.max_retries = retries; else if (!partial) out.max_retries = 1;
  if (partial && Object.keys(out).length === 0) throw badRequest("No updatable agent fields were supplied.");
  return out;
}

/**
 * Deterministic capability matching. Only active agents are eligible.
 * Preference: fewest capabilities (most specialised), then name, then id.
 */
export function selectAgent(agents, requiredCapability) {
  const eligible = agents.filter((agent) => agent.status === "active" &&
    (!requiredCapability || agent.capabilities.includes(requiredCapability)));
  if (!eligible.length) return null;
  eligible.sort((a, b) => a.capabilities.length - b.capabilities.length || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return eligible[0];
}
