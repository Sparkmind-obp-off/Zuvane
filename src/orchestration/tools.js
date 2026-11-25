// Tool gateway catalog. All adapters below are MOCK adapters: they never contact
// external services. Every result is explicitly marked `simulated: true`.

export const ADAPTERS = Object.freeze({
  "mock.workspace": { label: "Workspace (mock)", description: "Simulated access to workspace notes and drafts." },
  "mock.web": { label: "Web search (mock)", description: "Simulated web search. Returns deterministic placeholder results." },
  "mock.email": { label: "Email (mock)", description: "Simulated outbound email. No message is ever sent." },
  "mock.calendar": { label: "Calendar (mock)", description: "Simulated calendar. No event is created in any real calendar." }
});

// approval: "always" cannot be disabled by workspace policy (high-impact actions).
export const TOOL_CATALOG = Object.freeze({
  "notes.search": { adapter: "mock.workspace", label: "Search notes", risk: "low", approval: "policy" },
  "document.draft": { adapter: "mock.workspace", label: "Draft document", risk: "low", approval: "policy" },
  "web.search": { adapter: "mock.web", label: "Web search", risk: "low", approval: "policy" },
  "calendar.create_event": { adapter: "mock.calendar", label: "Create calendar event", risk: "medium", approval: "always" },
  "email.send": { adapter: "mock.email", label: "Send email", risk: "high", approval: "always" }
});

export function toolRequiresApproval(toolId, connection) {
  const tool = TOOL_CATALOG[toolId];
  if (!tool) return true;
  if (tool.approval === "always" || tool.risk === "high" || tool.risk === "critical") return true;
  return Boolean(connection?.requires_approval);
}

export function describeToolCall(toolId, task) {
  const tool = TOOL_CATALOG[toolId];
  const subject = task.title.slice(0, 80);
  return {
    action: `${tool?.label || toolId} for "${subject}"`,
    params_summary: `tool=${toolId}; adapter=${tool?.adapter || "unknown"}; task=${task.id}`
  };
}

export function executeMockTool(toolId, task) {
  const subject = task.title.slice(0, 80);
  const results = {
    "notes.search": `Found 0 matching workspace notes for "${subject}" (simulated).`,
    "document.draft": `Prepared a draft outline for "${subject}" (simulated).`,
    "web.search": `Simulated search for "${subject}" returned placeholder references.`,
    "calendar.create_event": `Simulated calendar event recorded for "${subject}". No real calendar was changed.`,
    "email.send": `Simulated email for "${subject}" recorded. No message was sent.`
  };
  if (!results[toolId]) throw new Error("Unknown tool.");
  return { simulated: true, tool: toolId, summary: results[toolId] };
}

export function toolCatalogView() {
  return Object.entries(TOOL_CATALOG).map(([id, t]) => ({ id, ...t, approval_required: t.approval === "always" }));
}

export function adapterCatalogView() {
  return Object.entries(ADAPTERS).map(([id, a]) => ({
    id, ...a, mock: true,
    tools: Object.entries(TOOL_CATALOG).filter(([, t]) => t.adapter === id).map(([toolId]) => toolId)
  }));
}
