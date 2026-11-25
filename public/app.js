// ZUVANE workspace SPA. All data comes from the authenticated Worker API.
// Authorization is enforced server-side; UI permission checks only hide controls.

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  clerk: null,
  me: null,
  workspaces: [],
  ws: null,
  catalog: null,
  version: "—",
  activityCursor: null
};

// ---------- utilities ----------

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (value = "") => String(value ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
const short = (id = "") => esc(String(id).replace(/^[a-z]+_/, "").slice(0, 8));
const can = (permission) => Boolean(state.ws?.permissions?.includes(permission));
const wsPath = (path = "") => `/api/workspaces/${encodeURIComponent(state.ws.id)}${path}`;

function timeAgo(iso) {
  if (!iso) return "—";
  const diff = (Date.now() - Date.parse(iso)) / 1000;
  if (diff < 45) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.round(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}
const fullTime = (iso) => (iso ? new Date(iso).toLocaleString() : "—");

const LABELS = {
  planned: "Planned", in_progress: "In progress", needs_approval: "Needs approval", completed: "Completed", blocked: "Blocked",
  queued: "Queued", assigned: "Assigned", running: "Running", waiting_approval: "Waiting approval", failed: "Failed", cancelled: "Cancelled",
  draft: "Draft", active: "Active", paused: "Paused", disabled: "Disabled", error: "Error",
  pending: "Pending", approved: "Approved", rejected: "Rejected", expired: "Expired",
  connected: "Connected", low: "Low", medium: "Medium", high: "High", critical: "Critical", normal: "Normal"
};
const label = (value) => LABELS[value] || esc(value);
const badge = (value, kind = "status") => `<span class="badge ${kind}-${esc(value)}">${label(value)}</span>`;

function toast(message, error = false) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.toggle("error", error);
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 3200);
}

class ApiError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

async function api(path, { method = "GET", body } = {}) {
  const token = await state.clerk?.session?.getToken();
  if (!token) throw new ApiError("Your session has ended. Sign in again.", 401, "unauthenticated");
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: { accept: "application/json", authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch {
    setConnection(false);
    throw new ApiError("Network error. Check your connection and retry.", 0, "network");
  }
  const data = await response.json().catch(() => ({}));
  setConnection(response.status < 500);
  if (response.status === 401) {
    toast("Your session expired. Please sign in again.", true);
    await state.clerk?.signOut?.().catch(() => {});
  }
  if (!response.ok) throw new ApiError(data.error || `Request failed (${response.status}).`, response.status, data.code);
  return data;
}

function setConnection(online) {
  $("#status-dot")?.classList.toggle("online", online);
  const el = $("#connection-state");
  if (el) el.textContent = online ? `Connected · v${state.version}` : "Unavailable";
}

// ---------- shared rendering ----------

const view = () => $("#view");

function skeleton(rows = 4) {
  return `<div class="skeleton-wrap" aria-busy="true" aria-label="Loading">${Array.from({ length: rows }, () => '<div class="skeleton-row"></div>').join("")}</div>`;
}

function errorState(error, retry = true) {
  return `<div class="state-card error-card" role="alert"><div class="state-icon">!</div><h3>Something went wrong</h3><p>${esc(error.message)}</p>${retry ? '<button class="button secondary" data-action="retry">Retry</button>' : ""}</div>`;
}

function emptyState(title, copy, action = "") {
  return `<div class="state-card"><div class="state-icon teal">◌</div><h3>${esc(title)}</h3><p>${esc(copy)}</p>${action}</div>`;
}

function pageHead({ eyebrow, title, copy = "", actions = "" }) {
  return `<section class="page-head"><div><div class="eyebrow"><span class="eyebrow-line"></span> ${esc(eyebrow)}</div><h1>${title}</h1>${copy ? `<p>${esc(copy)}</p>` : ""}</div><div class="page-actions">${actions}</div></section>`;
}

function tabs(name, items, active) {
  return `<div class="tabs" role="tablist" aria-label="${esc(name)}">${items.map(([value, text]) => `<button type="button" role="tab" class="tab ${value === active ? "active" : ""}" aria-selected="${value === active}" data-tab="${esc(value)}">${esc(text)}</button>`).join("")}</div>`;
}

function setBreadcrumbs(parts) {
  $("#breadcrumbs").innerHTML = [esc(state.ws?.name || "Workspace"), ...parts].map((p, i, all) => (i === all.length - 1 ? `<span aria-current="page">${p}</span>` : `<span>${p}</span>`)).join('<span class="sep">/</span>');
}

// ---------- dialogs ----------

function field({ name, label: text, type = "text", value = "", required = false, options = null, hint = "", attrs = "" }) {
  const id = `f-${name}`;
  let control;
  if (options) {
    control = `<select id="${id}" name="${name}" ${attrs}>${options.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(value) ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>`;
  } else if (type === "textarea") {
    control = `<textarea id="${id}" name="${name}" rows="3" ${attrs}>${esc(value)}</textarea>`;
  } else {
    control = `<input id="${id}" name="${name}" type="${type}" value="${esc(value)}" ${required ? "required" : ""} ${attrs}>`;
  }
  return `<label for="${id}">${esc(text)}${required ? "" : ' <span>OPTIONAL</span>'}</label>${control}${hint ? `<small class="field-hint">${esc(hint)}</small>` : ""}`;
}

function checks(name, text, all, selected = [], describe = (v) => v) {
  return `<fieldset class="check-group"><legend>${esc(text)}</legend>${all.map((value) => `<label class="check"><input type="checkbox" name="${name}" value="${esc(value)}" ${selected.includes(value) ? "checked" : ""}><span>${describe(value)}</span></label>`).join("")}</fieldset>`;
}

function openForm({ eyebrow, title, body, submit = "Save", onSubmit }) {
  const dialog = $("#form-dialog");
  $("#form-dialog-eyebrow").textContent = eyebrow;
  $("#form-dialog-title").textContent = title;
  $("#form-dialog-body").innerHTML = body;
  $("#form-dialog-error").textContent = "";
  $("#form-dialog-submit").textContent = submit;
  const form = $("#form-dialog-form");
  form.onsubmit = async (event) => {
    event.preventDefault();
    const button = $("#form-dialog-submit");
    button.disabled = true;
    try {
      await onSubmit(new FormData(form), form);
      dialog.close();
    } catch (error) {
      $("#form-dialog-error").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };
  dialog.showModal();
  $("input, textarea, select", form)?.focus();
}

function confirmAction({ eyebrow = "CONFIRM ACTION", title, message, ok = "Confirm", danger = false, withNote = false }) {
  return new Promise((resolve) => {
    const dialog = $("#confirm-dialog");
    $("#confirm-eyebrow").textContent = eyebrow;
    $("#confirm-title").textContent = title;
    $("#confirm-message").textContent = message;
    $("#confirm-extra").innerHTML = withNote ? field({ name: "note", label: "Decision note", type: "textarea", attrs: 'maxlength="500"' }) : "";
    const okButton = $("#confirm-ok");
    okButton.textContent = ok;
    okButton.className = `button ${danger ? "danger" : "primary"}`;
    const finish = (value) => { dialog.close(); resolve(value); };
    $("#confirm-cancel").onclick = () => finish(null);
    dialog.oncancel = (event) => { event.preventDefault(); finish(null); };
    $("#confirm-form").onsubmit = (event) => { event.preventDefault(); finish({ note: $("#f-note", dialog)?.value?.trim() || "" }); };
    dialog.showModal();
    $("#confirm-cancel").focus();
  });
}

// ---------- router ----------

const routes = [
  [/^\/overview$/, renderOverview, "overview"],
  [/^\/tasks$/, renderTasks, "tasks"],
  [/^\/tasks\/([\w-]+)$/, renderTaskDetail, "tasks"],
  [/^\/approvals$/, renderApprovals, "approvals"],
  [/^\/agents$/, renderAgents, "agents"],
  [/^\/agents\/([\w-]+)$/, renderAgentDetail, "agents"],
  [/^\/runs$/, renderRuns, "runs"],
  [/^\/runs\/([\w-]+)$/, renderRunDetail, "runs"],
  [/^\/integrations$/, renderIntegrations, "integrations"],
  [/^\/activity$/, renderActivity, "activity"],
  [/^\/settings$/, renderSettings, "settings"]
];

let routeToken = 0;
async function router() {
  if (!state.ws) return;
  const [path, query = ""] = (location.hash.slice(1) || "/overview").split("?");
  const match = routes.find(([pattern]) => pattern.test(path));
  if (!match) { location.hash = "#/overview"; return; }
  const [pattern, render, nav] = match;
  $$(".nav-item").forEach((item) => {
    const active = item.dataset.nav === nav;
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page"); else item.removeAttribute("aria-current");
  });
  document.body.classList.remove("nav-open");
  $("#menu-toggle").setAttribute("aria-expanded", "false");
  const token = ++routeToken;
  const params = path.match(pattern).slice(1);
  view().innerHTML = skeleton();
  try {
    const html = await render(params, new URLSearchParams(query));
    if (token !== routeToken) return;
    view().innerHTML = html;
  } catch (error) {
    if (token !== routeToken) return;
    view().innerHTML = errorState(error);
  }
  refreshCounts();
}

async function refreshCounts() {
  try {
    const overview = await api(wsPath("/overview"));
    const total = Object.values(overview.tasks).reduce((a, b) => a + b, 0);
    $("#nav-count-tasks").textContent = total || "";
    $("#nav-count-approvals").textContent = overview.pending_approval_count || "";
  } catch { /* non-critical */ }
}

const go = (hash) => { if (location.hash === hash) router(); else location.hash = hash; };

// ---------- overview ----------

async function renderOverview() {
  setBreadcrumbs(["Overview"]);
  const o = await api(wsPath("/overview"));
  const total = Object.values(o.tasks).reduce((a, b) => a + b, 0);
  const activeAgents = o.agents.active || 0;
  const totalAgents = Object.values(o.agents).reduce((a, b) => a + b, 0);
  const name = state.me?.user?.display_name?.split(" ")[0] || state.clerk?.user?.firstName || "there";
  const metric = (labelText, value, foot, tone = "") => `<article class="metric"><div class="metric-label">${esc(labelText)} <span class="metric-icon ${tone}">●</span></div><div class="metric-value">${value}</div><div class="metric-foot">${esc(foot)}</div></article>`;
  const quick = [
    can("task.write") ? '<button class="quick-action" data-action="new-task"><span>＋</span>New task</button>' : "",
    can("agent.manage") ? '<button class="quick-action" data-action="new-agent"><span>◇</span>Register agent</button>' : "",
    can("integration.manage") ? '<a class="quick-action" href="#/integrations"><span>⌘</span>Connect integration</a>' : "",
    '<a class="quick-action" href="#/activity"><span>⌁</span>Review activity</a>'
  ].join("");
  return `
    ${pageHead({ eyebrow: "YOUR COMMAND CENTER", title: `Welcome back, ${esc(name)}.<br><span>Stay in control.</span>`, copy: "Coordinate work, keep agent actions bounded, and decide what happens next." })}
    <section class="metrics" aria-label="Workspace summary">
      ${metric("TOTAL TASKS", total, `${o.tasks.completed || 0} completed`)}
      ${metric("IN PROGRESS", o.tasks.in_progress || 0, "Moving forward", "teal")}
      ${metric("AWAITING APPROVAL", o.pending_approval_count, "Your decision is needed", "amber")}
      ${metric("ACTIVE AGENTS", `${activeAgents}<small>/${totalAgents}</small>`, "Registered in this workspace", "blue")}
    </section>
    <section class="quick-actions" aria-label="Quick actions">${quick}</section>
    <section class="grid-2">
      <section class="panel">
        <div class="panel-head"><div><div class="eyebrow">HUMAN IN THE LOOP</div><h2>Pending approvals</h2></div><a class="text-action" href="#/approvals">View all →</a></div>
        ${o.pending_approvals.length ? `<ul class="list">${o.pending_approvals.map((a) => `<li class="list-row"><span class="row-mark amber">◷</span><div class="row-main"><strong>${esc(a.action)}</strong><span class="mono tiny">${a.run_id ? `RUN ${short(a.run_id)} · ` : ""}${timeAgo(a.requested_at)}</span></div>${badge(a.risk_level, "risk")}</li>`).join("")}</ul>` : '<div class="empty-inline">No pending approvals. You are all caught up.</div>'}
      </section>
      <section class="panel">
        <div class="panel-head"><div><div class="eyebrow">ORCHESTRATION</div><h2>Recent runs</h2></div><a class="text-action" href="#/runs">View all →</a></div>
        ${o.recent_runs.length ? `<ul class="list">${o.recent_runs.map((r) => `<li class="list-row"><a class="row-link" href="#/runs/${esc(r.id)}"><span class="row-mark">▷</span><div class="row-main"><strong>${esc(r.task_title || "Task")}</strong><span class="mono tiny">${esc(r.agent_name || "Agent")} · ${timeAgo(r.created_at)}</span></div>${badge(r.status)}</a></li>`).join("")}</ul>` : '<div class="empty-inline">No agent runs yet. Register an agent and run it on a task.</div>'}
      </section>
    </section>
    <section class="panel">
      <div class="panel-head"><div><div class="eyebrow">AUDIT TRAIL</div><h2>Recent activity</h2></div><a class="text-action" href="#/activity">Full timeline →</a></div>
      ${o.recent_activity.length ? timeline(o.recent_activity) : '<div class="empty-inline">No activity recorded yet.</div>'}
    </section>`;
}

// ---------- tasks ----------

async function renderTasks(_, query) {
  setBreadcrumbs(["Tasks"]);
  const filter = query.get("status") || "all";
  const { tasks } = await api(wsPath(`/tasks${filter !== "all" ? `?status=${encodeURIComponent(filter)}` : ""}`));
  const rows = tasks.map((t) => `
    <li class="task-row">
      <span class="task-priority ${esc(t.priority)}" title="${label(t.priority)} priority"></span>
      <a class="task-main" href="#/tasks/${esc(t.id)}"><strong>${esc(t.title)}</strong><p>${esc(t.description || "No description added.")}</p>
        <span class="mono task-meta">${short(t.id)} · ${t.required_capability ? `NEEDS ${esc(t.required_capability.toUpperCase())} · ` : ""}UPDATED ${timeAgo(t.updated_at)}</span></a>
      ${badge(t.status)}
    </li>`).join("");
  return `
    ${pageHead({ eyebrow: "WORK QUEUE", title: "Tasks", copy: "Plan work, assign agents, and move tasks through a guarded lifecycle.", actions: can("task.write") ? '<button class="button primary" data-action="new-task">＋ New task</button>' : "" })}
    <section class="panel">
      <div class="toolbar">${tabs("Filter tasks", [["all", "All"], ["planned", "Planned"], ["in_progress", "In progress"], ["needs_approval", "Needs approval"], ["blocked", "Blocked"], ["completed", "Completed"]], filter)}<span class="mono tiny">${tasks.length} ITEMS</span></div>
      ${tasks.length ? `<ul class="task-list" data-tab-target="tasks">${rows}</ul>` : emptyState("No tasks here yet", "Create a task to start moving work forward.", can("task.write") ? '<button class="button primary" data-action="new-task">Create task</button>' : "")}
    </section>`;
}

function taskForm(task = {}) {
  const caps = [["", "Any capability"], ...(state.catalog?.capabilities || []).map((c) => [c, c[0].toUpperCase() + c.slice(1)])];
  return field({ name: "title", label: "Task title", required: true, value: task.title || "", attrs: 'minlength="3" maxlength="120" placeholder="What needs to move forward?"' }) +
    field({ name: "description", label: "Description", type: "textarea", value: task.description || "", attrs: 'maxlength="2000" placeholder="Context, expected outcome, constraints…"' }) +
    `<div class="field-row"><div>${field({ name: "priority", label: "Priority", required: true, value: task.priority || "normal", options: [["normal", "Normal"], ["high", "High"], ["low", "Low"]] })}</div>` +
    `<div>${field({ name: "required_capability", label: "Required agent capability", value: task.required_capability || "", options: caps })}</div></div>`;
}

function newTask() {
  openForm({
    eyebrow: "ADD TO WORKSPACE", title: "Create a task", submit: "Create task", body: taskForm(),
    onSubmit: async (form) => {
      const body = Object.fromEntries(form);
      if (!body.required_capability) delete body.required_capability;
      const { task } = await api(wsPath("/tasks"), { method: "POST", body });
      toast("Task created.");
      go(`#/tasks/${task.id}`);
    }
  });
}

const TASK_MOVES = {
  planned: [["in_progress", "Start"], ["blocked", "Mark blocked"]],
  in_progress: [["completed", "Complete"], ["blocked", "Mark blocked"]],
  blocked: [["in_progress", "Resume"], ["planned", "Back to planned"]],
  needs_approval: [],
  completed: []
};

async function renderTaskDetail([taskId]) {
  const { task, runs, approvals, events } = await api(wsPath(`/tasks/${encodeURIComponent(taskId)}`));
  setBreadcrumbs([`<a href="#/tasks">Tasks</a>`, esc(task.title)]);
  const activeRun = runs.find((r) => ["queued", "assigned", "running", "waiting_approval"].includes(r.status));
  const actions = [];
  if (can("task.write") && !activeRun) {
    for (const [status, text] of TASK_MOVES[task.status] || []) actions.push(`<button class="button secondary" data-action="task-status" data-id="${esc(task.id)}" data-status="${status}">${esc(text)}</button>`);
    if (task.status !== "completed") actions.push(`<button class="button secondary" data-action="edit-task" data-id="${esc(task.id)}">Edit</button>`);
  }
  if (can("approval.request") && task.status === "in_progress" && !activeRun) actions.push(`<button class="button secondary" data-action="request-approval" data-id="${esc(task.id)}">Request approval</button>`);
  if (can("run.create") && ["planned", "in_progress", "blocked"].includes(task.status) && !activeRun) actions.push(`<button class="button primary" data-action="run-task" data-id="${esc(task.id)}">▷ Run with agent</button>`);
  state.currentTask = task;
  return `
    ${pageHead({ eyebrow: `TASK ${short(task.id)}`, title: esc(task.title), actions: actions.join("") })}
    <section class="grid-detail">
      <div class="stack">
        <section class="panel pad">
          <div class="detail-grid">
            <div><span class="k">Status</span>${badge(task.status)}</div>
            <div><span class="k">Priority</span>${badge(task.priority, "priority")}</div>
            <div><span class="k">Capability</span><span>${esc(task.required_capability || "Any")}</span></div>
            <div><span class="k">Updated</span><span title="${esc(fullTime(task.updated_at))}">${timeAgo(task.updated_at)}</span></div>
          </div>
          <h3 class="section-title">Description</h3>
          <p class="prose">${esc(task.description || "No description added.")}</p>
          ${activeRun ? `<div class="notice">An agent run is active on this task. <a href="#/runs/${esc(activeRun.id)}">Open run →</a></div>` : ""}
        </section>
        <section class="panel">
          <div class="panel-head"><div><div class="eyebrow">EXECUTION</div><h2>Agent runs</h2></div></div>
          ${runs.length ? `<ul class="list">${runs.map((r) => `<li class="list-row"><a class="row-link" href="#/runs/${esc(r.id)}"><span class="row-mark">▷</span><div class="row-main"><strong>${esc(r.agent_name || "Agent")}</strong><span class="mono tiny">${short(r.id)} · ${r.steps_used} STEPS · ${timeAgo(r.created_at)}${r.error ? ` · ${esc(r.error)}` : ""}</span></div>${badge(r.status)}</a></li>`).join("")}</ul>` : '<div class="empty-inline">No runs for this task yet.</div>'}
        </section>
        <section class="panel">
          <div class="panel-head"><div><div class="eyebrow">DECISIONS</div><h2>Approvals</h2></div></div>
          ${approvals.length ? `<ul class="list">${approvals.map(approvalRow).join("")}</ul>` : '<div class="empty-inline">No approvals requested for this task.</div>'}
        </section>
      </div>
      <section class="panel">
        <div class="panel-head"><div><div class="eyebrow">AUDIT</div><h2>History</h2></div></div>
        ${events.length ? timeline(events) : '<div class="empty-inline">No history yet.</div>'}
      </section>
    </section>`;
}

async function runTask(taskId) {
  const { agents } = await api(wsPath("/agents"));
  const active = agents.filter((a) => a.status === "active");
  if (!active.length) { toast("No active agents. Register and activate an agent first.", true); return; }
  openForm({
    eyebrow: "ORCHESTRATION", title: "Run task with an agent", submit: "Start run",
    body: field({ name: "agent_id", label: "Agent", value: "", options: [["", "Automatic — match by capability"], ...active.map((a) => [a.id, `${a.name} · ${a.capabilities.join(", ")}`])] }) +
      '<p class="dialog-copy">Runs are bounded by the agent’s step, timeout and retry limits. High-impact tool actions pause for human approval.</p>',
    onSubmit: async (form) => {
      const body = { task_id: taskId };
      if (form.get("agent_id")) body.agent_id = form.get("agent_id");
      const { run } = await api(wsPath("/runs"), { method: "POST", body });
      toast(`Run ${LABELS[run.status] || run.status}.`);
      go(`#/runs/${run.id}`);
    }
  });
}

// ---------- approvals ----------

function approvalRow(a) {
  const pending = a.status === "pending";
  const decide = pending && can("approval.decide") ? `<div class="row-actions"><button class="button mini primary" data-action="approve" data-id="${esc(a.id)}">Approve</button><button class="button mini secondary" data-action="reject" data-id="${esc(a.id)}">Reject</button></div>` : "";
  const cancel = pending && (can("approval.decide") || a.requested_by === state.me?.user?.id) ? `<button class="text-action muted-action" data-action="cancel-approval" data-id="${esc(a.id)}">Cancel</button>` : "";
  return `<li class="approval-row">
    <span class="row-mark ${pending ? "amber" : ""}">◷</span>
    <div class="row-main">
      <strong>${esc(a.action)}</strong>
      <span class="mono tiny">${a.task_title ? `${esc(a.task_title)} · ` : ""}${a.agent_name ? `AGENT ${esc(a.agent_name)} · ` : ""}${timeAgo(a.requested_at)}${pending && a.expires_at ? ` · EXPIRES ${esc(new Date(a.expires_at).toLocaleString())}` : ""}</span>
      ${a.params_summary ? `<code class="params">${esc(a.params_summary)}</code>` : ""}
      ${a.decided_at ? `<span class="tiny">Decided ${timeAgo(a.decided_at)}${a.decision_note ? ` — “${esc(a.decision_note)}”` : ""}</span>` : ""}
      ${a.execution_result ? `<span class="tiny result">Result: ${esc(a.execution_result)}</span>` : ""}
      ${decide}
    </div>
    <div class="row-side">${badge(a.risk_level, "risk")}${badge(a.status)}${cancel}</div>
  </li>`;
}

async function renderApprovals(_, query) {
  setBreadcrumbs(["Approvals"]);
  const filter = query.get("status") || "pending";
  const { approvals } = await api(wsPath(`/approvals?status=${encodeURIComponent(filter)}`));
  return `
    ${pageHead({ eyebrow: "HUMAN IN THE LOOP", title: "Approval center", copy: can("approval.decide") ? "Consequential actions pause here until an owner or admin decides." : "You can view approvals. Owners and admins make decisions." })}
    <section class="panel">
      <div class="toolbar">${tabs("Filter approvals", [["pending", "Pending"], ["approved", "Approved"], ["rejected", "Rejected"], ["cancelled", "Cancelled"], ["expired", "Expired"], ["all", "All"]], filter)}<span class="mono tiny">${approvals.length} ITEMS</span></div>
      ${approvals.length ? `<ul class="list" data-tab-target="approvals">${approvals.map(approvalRow).join("")}</ul>` : emptyState(filter === "pending" ? "Nothing waiting for you" : "No approvals in this view", filter === "pending" ? "When an agent or teammate needs a decision, it appears here." : "Try another filter.")}
    </section>`;
}

async function decide(approvalId, decision) {
  const result = await confirmAction({
    eyebrow: decision === "approved" ? "APPROVE ACTION" : "REJECT ACTION",
    title: decision === "approved" ? "Approve this action?" : "Reject this action?",
    message: decision === "approved" ? "The paused run resumes immediately and the approved action executes under the agent’s limits." : "The action will not execute. Any waiting run will stop and the task becomes blocked.",
    ok: decision === "approved" ? "Approve" : "Reject", danger: decision === "rejected", withNote: true
  });
  if (!result) return;
  const body = { decision };
  if (result.note) body.note = result.note;
  const response = await api(wsPath(`/approvals/${encodeURIComponent(approvalId)}/decision`), { method: "POST", body });
  toast(`Approval ${decision}.${response.run ? ` Run is now ${LABELS[response.run.status] || response.run.status}.` : ""}`);
  router();
}

function requestApproval(taskId) {
  openForm({
    eyebrow: "HUMAN IN THE LOOP", title: "Request approval", submit: "Request approval",
    body: field({ name: "action", label: "Action that needs approval", required: true, attrs: 'minlength="3" maxlength="160"' }) +
      field({ name: "params_summary", label: "Safe summary of parameters", type: "textarea", attrs: 'maxlength="500"' }) +
      field({ name: "risk_level", label: "Risk level", required: true, value: "medium", options: [["low", "Low"], ["medium", "Medium"], ["high", "High"], ["critical", "Critical"]] }),
    onSubmit: async (form) => {
      await api(wsPath("/approvals"), { method: "POST", body: { task_id: taskId, ...Object.fromEntries(form) } });
      toast("Approval requested.");
      router();
    }
  });
}

// ---------- agents ----------

const toolLabel = (id) => {
  const tool = state.catalog?.tools?.find((t) => t.id === id);
  return tool ? `${esc(tool.label)} <span class="mono tiny">${esc(id)} · ${esc(tool.risk.toUpperCase())}${tool.approval_required ? " · ALWAYS APPROVAL" : ""}</span>` : esc(id);
};

function agentForm(agent = {}) {
  const c = state.catalog;
  const providers = c.providers.filter((p) => p.enabled);
  const models = providers.flatMap((p) => p.models.map((m) => [`${p.id}::${m}`, `${p.label} — ${m}`]));
  return field({ name: "name", label: "Agent name", required: true, value: agent.name || "", attrs: 'minlength="2" maxlength="80"' }) +
    field({ name: "description", label: "Description", type: "textarea", value: agent.description || "", attrs: 'maxlength="1000"' }) +
    `<div class="field-row"><div>${field({ name: "agent_type", label: "Type", required: true, value: agent.agent_type || "assistant", options: c.agent_types.map((t) => [t, t[0].toUpperCase() + t.slice(1)]) })}</div>` +
    `<div>${field({ name: "provider_model", label: "Provider / model", required: true, value: agent.provider ? `${agent.provider}::${agent.model}` : models[0]?.[0], options: models, hint: "Only configured providers are listed." })}</div></div>` +
    checks("capabilities", "Capabilities", c.capabilities, agent.capabilities || []) +
    checks("allowed_tools", "Allowed tools (least privilege — none by default)", c.tools.map((t) => t.id), agent.allowed_tools || [], toolLabel) +
    `<div class="field-row three"><div>${field({ name: "max_steps", label: "Max steps", type: "number", required: true, value: agent.max_steps ?? 8, attrs: 'min="1" max="20"' })}</div>` +
    `<div>${field({ name: "timeout_ms", label: "Timeout (ms)", type: "number", required: true, value: agent.timeout_ms ?? 10000, attrs: 'min="100" max="30000" step="100"' })}</div>` +
    `<div>${field({ name: "max_retries", label: "Max retries", type: "number", required: true, value: agent.max_retries ?? 1, attrs: 'min="0" max="3"' })}</div></div>`;
}

function agentBody(form) {
  const [provider, model] = String(form.get("provider_model") || "").split("::");
  return {
    name: form.get("name"), description: form.get("description"), agent_type: form.get("agent_type"), provider, model,
    capabilities: form.getAll("capabilities"), allowed_tools: form.getAll("allowed_tools"),
    max_steps: Number(form.get("max_steps")), timeout_ms: Number(form.get("timeout_ms")), max_retries: Number(form.get("max_retries"))
  };
}

function newAgent() {
  openForm({
    eyebrow: "AGENT REGISTRY", title: "Register an agent", submit: "Register agent", body: agentForm(),
    onSubmit: async (form) => {
      const { agent } = await api(wsPath("/agents"), { method: "POST", body: agentBody(form) });
      toast("Agent registered as draft. Activate it when ready.");
      go(`#/agents/${agent.id}`);
    }
  });
}

async function renderAgents() {
  setBreadcrumbs(["Agents"]);
  const { agents } = await api(wsPath("/agents"));
  const cards = agents.map((a) => `
    <a class="agent-card" href="#/agents/${esc(a.id)}">
      <div class="agent-card-head"><span class="agent-glyph">◇</span>${badge(a.status)}</div>
      <strong>${esc(a.name)}</strong>
      <p>${esc(a.description || "No description.")}</p>
      <div class="chips">${a.capabilities.map((c) => `<span class="chip">${esc(c)}</span>`).join("") || '<span class="chip muted">no capabilities</span>'}</div>
      <span class="mono tiny">${esc(a.provider)} / ${esc(a.model)} · ${a.allowed_tools.length} TOOLS · ${a.max_steps} STEPS</span>
    </a>`).join("");
  return `
    ${pageHead({ eyebrow: "AGENT CONTROL CENTER", title: "Agents", copy: "Every agent has explicit capabilities, tool permissions and execution limits. Registration grants nothing by itself.", actions: can("agent.manage") ? '<button class="button primary" data-action="new-agent">＋ Register agent</button>' : "" })}
    ${agents.length ? `<section class="agent-grid">${cards}</section>` : `<section class="panel">${emptyState("No agents registered", "Register an agent, give it capabilities, then activate it to run tasks.", can("agent.manage") ? '<button class="button primary" data-action="new-agent">Register agent</button>' : "")}</section>`}`;
}

const AGENT_MOVES = { draft: [["active", "Activate"], ["disabled", "Disable"]], active: [["paused", "Pause"], ["disabled", "Disable"]], paused: [["active", "Resume"], ["disabled", "Disable"]], disabled: [["draft", "Return to draft"]], error: [["active", "Activate"], ["paused", "Pause"], ["disabled", "Disable"]] };

async function renderAgentDetail([agentId]) {
  const { agent, runs } = await api(wsPath(`/agents/${encodeURIComponent(agentId)}`));
  setBreadcrumbs([`<a href="#/agents">Agents</a>`, esc(agent.name)]);
  state.currentAgent = agent;
  const actions = can("agent.manage") ? [
    ...AGENT_MOVES[agent.status].map(([status, text]) => `<button class="button ${status === "active" ? "primary" : "secondary"}" data-action="agent-status" data-status="${status}" data-id="${esc(agent.id)}">${esc(text)}</button>`),
    `<button class="button secondary" data-action="edit-agent" data-id="${esc(agent.id)}">Configure</button>`
  ].join("") : "";
  return `
    ${pageHead({ eyebrow: `AGENT ${short(agent.id)}`, title: esc(agent.name), copy: agent.description, actions })}
    <section class="grid-detail">
      <div class="stack">
        <section class="panel pad">
          <div class="detail-grid">
            <div><span class="k">Status</span>${badge(agent.status)}</div>
            <div><span class="k">Type</span><span>${esc(agent.agent_type)}</span></div>
            <div><span class="k">Provider</span><span class="mono">${esc(agent.provider)} / ${esc(agent.model)}</span></div>
            <div><span class="k">Updated</span><span>${timeAgo(agent.updated_at)}</span></div>
          </div>
          <h3 class="section-title">Capabilities</h3>
          <div class="chips">${agent.capabilities.map((c) => `<span class="chip">${esc(c)}</span>`).join("") || '<span class="chip muted">None — cannot be activated</span>'}</div>
          <h3 class="section-title">Tool permissions</h3>
          ${agent.allowed_tools.length ? `<ul class="plain">${agent.allowed_tools.map((t) => `<li>${toolLabel(t)}</li>`).join("")}</ul>` : '<p class="prose muted">No tools allowed. The agent can only reason over task text.</p>'}
          <h3 class="section-title">Execution limits</h3>
          <div class="detail-grid">
            <div><span class="k">Max steps</span><span class="mono">${agent.max_steps}</span></div>
            <div><span class="k">Timeout</span><span class="mono">${agent.timeout_ms} ms</span></div>
            <div><span class="k">Retries</span><span class="mono">${agent.max_retries}</span></div>
            <div><span class="k">Scope</span><span>This workspace</span></div>
          </div>
        </section>
      </div>
      <section class="panel">
        <div class="panel-head"><div><div class="eyebrow">HISTORY</div><h2>Executions</h2></div></div>
        ${runs.length ? `<ul class="list">${runs.map((r) => `<li class="list-row"><a class="row-link" href="#/runs/${esc(r.id)}"><div class="row-main"><strong>${esc(r.task_title || "Task")}</strong><span class="mono tiny">${r.steps_used} STEPS · ${timeAgo(r.created_at)}</span></div>${badge(r.status)}</a></li>`).join("")}</ul>` : '<div class="empty-inline">This agent has not run yet.</div>'}
      </section>
    </section>`;
}

// ---------- runs ----------

async function renderRuns(_, query) {
  setBreadcrumbs(["Runs"]);
  const filter = query.get("status") || "all";
  const { runs } = await api(wsPath(`/runs${filter !== "all" ? `?status=${encodeURIComponent(filter)}` : ""}`));
  return `
    ${pageHead({ eyebrow: "ORCHESTRATION", title: "Execution history", copy: "Every run is bounded, traceable, and recorded step by step." })}
    <section class="panel">
      <div class="toolbar">${tabs("Filter runs", [["all", "All"], ["waiting_approval", "Waiting"], ["running", "Running"], ["completed", "Completed"], ["failed", "Failed"], ["cancelled", "Cancelled"]], filter)}<span class="mono tiny">${runs.length} RUNS</span></div>
      ${runs.length ? `<div class="table-wrap" data-tab-target="runs"><table class="table"><thead><tr><th scope="col">Task</th><th scope="col">Agent</th><th scope="col">Status</th><th scope="col">Steps</th><th scope="col">Started</th></tr></thead><tbody>${runs.map((r) => `<tr><td><a href="#/runs/${esc(r.id)}">${esc(r.task_title || "Task")}</a><span class="mono tiny block">${short(r.id)}</span></td><td>${esc(r.agent_name || "—")}</td><td>${badge(r.status)}</td><td class="mono">${r.steps_used}/${r.max_steps}</td><td title="${esc(fullTime(r.created_at))}">${timeAgo(r.created_at)}</td></tr>`).join("")}</tbody></table></div>` : emptyState("No runs in this view", "Start a run from any task detail page.")}
    </section>`;
}

async function renderRunDetail([runId]) {
  const { run, steps, approvals } = await api(wsPath(`/runs/${encodeURIComponent(runId)}`));
  setBreadcrumbs([`<a href="#/runs">Runs</a>`, short(run.id)]);
  const active = ["queued", "assigned", "running", "waiting_approval"].includes(run.status);
  const actions = active && can("run.cancel") ? `<button class="button danger" data-action="cancel-run" data-id="${esc(run.id)}">Cancel run</button>` : "";
  const output = run.output && run.status === "completed" ? `<h3 class="section-title">Result</h3><pre class="output">${esc(run.output.text || run.output.summary)}</pre>${run.output.simulated ? '<p class="tiny">Produced by the deterministic mock provider. No external model or service was called.</p>' : ""}` : "";
  return `
    ${pageHead({ eyebrow: `RUN ${short(run.id)}`, title: esc(run.task_title || "Agent run"), actions })}
    <section class="grid-detail">
      <div class="stack">
        <section class="panel pad">
          <div class="detail-grid">
            <div><span class="k">Status</span>${badge(run.status)}</div>
            <div><span class="k">Agent</span><a href="#/agents/${esc(run.agent_id)}">${esc(run.agent_name || "Agent")}</a></div>
            <div><span class="k">Steps</span><span class="mono">${run.steps_used}/${run.max_steps}</span></div>
            <div><span class="k">Limits</span><span class="mono">${run.timeout_ms}ms · ${run.max_retries} retry</span></div>
          </div>
          <p class="prose"><span class="k">Selection</span> ${esc(run.selection_reason || "—")}</p>
          <p class="prose"><span class="k">Granted tools</span> ${(run.input?.granted_tools || []).map((t) => `<code>${esc(t)}</code>`).join(" ") || "none"}</p>
          ${run.error ? `<div class="notice danger">${esc(run.error)}</div>` : ""}
          ${run.status === "waiting_approval" ? '<div class="notice">This run is paused for a human decision. <a href="#/approvals">Open approval center →</a></div>' : ""}
          <p class="prose"><a href="#/tasks/${esc(run.task_id)}">Open task →</a></p>
          ${output}
        </section>
        ${approvals.length ? `<section class="panel"><div class="panel-head"><div><div class="eyebrow">GATES</div><h2>Approvals</h2></div></div><ul class="list">${approvals.map(approvalRow).join("")}</ul></section>` : ""}
      </div>
      <section class="panel">
        <div class="panel-head"><div><div class="eyebrow">TRACE</div><h2>Steps</h2></div><span class="mono tiny">${esc(run.correlation_id || "")}</span></div>
        ${steps.length ? `<ol class="steps">${steps.map((s) => `<li class="step step-${esc(s.status)}"><span class="step-dot"></span><div><strong>${esc(s.type.toUpperCase())} · ${esc(s.status)}</strong><p>${esc(s.summary)}</p><span class="mono tiny">${new Date(s.created_at).toLocaleTimeString()}${s.detail?.tool ? ` · ${esc(s.detail.tool)}` : ""}${s.detail?.simulated ? " · SIMULATED" : ""}</span></div></li>`).join("")}</ol>` : '<div class="empty-inline">No steps recorded yet.</div>'}
      </section>
    </section>`;
}

// ---------- integrations ----------

async function renderIntegrations() {
  setBreadcrumbs(["Integrations"]);
  const { connections, adapters, providers } = await api(wsPath("/integrations"));
  const manage = can("integration.manage");
  const connected = new Set(connections.map((c) => c.adapter));
  return `
    ${pageHead({ eyebrow: "PROVIDER & TOOL GATEWAY", title: "Integrations", copy: "Tools only work through connected integrations, and agents only receive tools they are explicitly allowed to use." })}
    <section class="panel">
      <div class="panel-head"><div><div class="eyebrow">CONNECTED</div><h2>Workspace connections</h2></div></div>
      ${connections.length ? `<ul class="list">${connections.map((c) => `<li class="list-row">
        <span class="row-mark ${c.status === "connected" ? "teal" : ""}">⌘</span>
        <div class="row-main"><strong>${esc(c.name)}</strong><span class="mono tiny">${esc(c.adapter)} · ${c.rate_limit_per_min}/MIN · ${c.total_calls} CALLS · ${c.requires_approval ? "APPROVAL REQUIRED" : "LOW-RISK AUTO"}</span></div>
        <div class="row-side">${badge(c.status)}${manage ? `<button class="button mini secondary" data-action="edit-connection" data-id="${esc(c.id)}" data-status="${esc(c.status)}" data-approval="${c.requires_approval ? 1 : 0}" data-rate="${c.rate_limit_per_min}">Configure</button>` : ""}</div>
      </li>`).join("")}</ul>` : '<div class="empty-inline">No integrations connected. Agents cannot call any tool yet.</div>'}
    </section>
    <section class="grid-2">
      <section class="panel">
        <div class="panel-head"><div><div class="eyebrow">TOOL ADAPTERS</div><h2>Available adapters</h2></div></div>
        <ul class="list">${adapters.map((a) => `<li class="list-row"><div class="row-main"><strong>${esc(a.label)} <span class="chip muted">MOCK</span></strong><span class="tiny">${esc(a.description)}</span><span class="mono tiny">${a.tools.map(esc).join(" · ")}</span></div>${manage && !connected.has(a.id) ? `<button class="button mini primary" data-action="connect" data-adapter="${esc(a.id)}">Connect</button>` : connected.has(a.id) ? badge("connected") : ""}</li>`).join("")}</ul>
      </section>
      <section class="panel">
        <div class="panel-head"><div><div class="eyebrow">MODEL PROVIDERS</div><h2>Providers</h2></div></div>
        <ul class="list">${providers.map((p) => `<li class="list-row"><div class="row-main"><strong>${esc(p.label)}</strong><span class="tiny">${esc(p.description)}</span><span class="mono tiny">${p.models.map(esc).join(" · ")}</span></div>${p.enabled ? badge("active") : '<span class="badge status-disabled">Not configured</span>'}</li>`).join("")}</ul>
      </section>
    </section>`;
}

function connectAdapter(adapter) {
  const info = state.catalog.adapters.find((a) => a.id === adapter);
  openForm({
    eyebrow: "CONNECT INTEGRATION", title: `Connect ${info?.label || adapter}`, submit: "Connect",
    body: `<p class="dialog-copy">${esc(info?.description || "")} This is a mock adapter: it never contacts an external service.</p>` +
      field({ name: "name", label: "Connection name", required: true, value: info?.label || adapter, attrs: 'maxlength="80"' }) +
      field({ name: "requires_approval", label: "Approval policy for low-risk tools", required: true, value: "1", options: [["1", "Require approval for every tool call"], ["0", "Allow low-risk tools without approval"]], hint: "Medium/high-risk tools (calendar, email) always require approval." }) +
      field({ name: "rate_limit_per_min", label: "Rate limit (calls per minute)", type: "number", required: true, value: 30, attrs: 'min="1" max="600"' }),
    onSubmit: async (form) => {
      await api(wsPath("/integrations"), { method: "POST", body: { adapter, name: form.get("name"), requires_approval: form.get("requires_approval") === "1", rate_limit_per_min: Number(form.get("rate_limit_per_min")) } });
      toast("Integration connected.");
      router();
    }
  });
}

function editConnection(button) {
  openForm({
    eyebrow: "INTEGRATION", title: "Configure connection", submit: "Save",
    body: field({ name: "status", label: "Status", required: true, value: button.dataset.status, options: [["connected", "Connected"], ["disabled", "Disabled"]] }) +
      field({ name: "requires_approval", label: "Approval policy for low-risk tools", required: true, value: button.dataset.approval, options: [["1", "Require approval"], ["0", "Allow without approval"]] }) +
      field({ name: "rate_limit_per_min", label: "Rate limit (calls per minute)", type: "number", required: true, value: button.dataset.rate, attrs: 'min="1" max="600"' }),
    onSubmit: async (form) => {
      await api(wsPath(`/integrations/${encodeURIComponent(button.dataset.id)}`), { method: "PATCH", body: { status: form.get("status"), requires_approval: form.get("requires_approval") === "1", rate_limit_per_min: Number(form.get("rate_limit_per_min")) } });
      toast("Integration updated.");
      router();
    }
  });
}

// ---------- activity ----------

const ACTION_TEXT = {
  "workspace.provisioned": "Workspace provisioned", "workspace.created": "Workspace created", "workspace.renamed": "Workspace renamed",
  "member.added": "Member added", "member.removed": "Member removed", "member.left": "Member left", "member.role_changed": "Member role changed",
  "task.created": "Task created", "task.updated": "Task updated", "task.status_changed": "Task status changed",
  "approval.requested": "Approval requested", "approval.approved": "Approval granted", "approval.rejected": "Approval rejected", "approval.cancelled": "Approval cancelled", "approval.expired": "Approvals expired",
  "agent.created": "Agent registered", "agent.updated": "Agent configured", "agent.status_changed": "Agent status changed",
  "run.queued": "Run queued", "run.assigned": "Run assigned", "run.completed": "Run completed", "run.failed": "Run failed", "run.cancelled": "Run cancelled",
  "tool.executed": "Tool executed", "tool.denied": "Tool call denied",
  "integration.connected": "Integration connected", "integration.updated": "Integration updated"
};

function eventDetail(e) {
  const m = e.metadata || {};
  if (m.from && m.to) return `${label(m.from)} → ${label(m.to)}`;
  if (m.tool) return `${m.tool}${m.simulated ? " (simulated)" : ""}`;
  if (m.title) return m.title;
  if (m.name) return m.name;
  if (m.error) return m.error;
  if (m.reason) return m.reason;
  return "";
}

function timeline(events) {
  return `<ol class="timeline">${events.map((e) => `<li class="tl-item tl-${esc(e.actor_type)}"><span class="tl-dot"></span><div class="tl-body"><strong>${esc(ACTION_TEXT[e.action] || e.action)}</strong>${eventDetail(e) ? `<p>${esc(eventDetail(e))}</p>` : ""}<span class="mono tiny">${esc(e.actor_type.toUpperCase())}${e.actor_id ? ` · ${e.actor_id === state.me?.user?.id ? "YOU" : short(e.actor_id)}` : ""} · <time datetime="${esc(e.created_at)}" title="${esc(fullTime(e.created_at))}">${timeAgo(e.created_at)}</time></span></div></li>`).join("")}</ol>`;
}

async function renderActivity() {
  setBreadcrumbs(["Activity"]);
  const { events } = await api(wsPath("/activity?limit=50"));
  state.activityCursor = events.length === 50 ? events[events.length - 1].created_at : null;
  return `
    ${pageHead({ eyebrow: "AUDIT TRAIL", title: "Activity", copy: "An append-only record of every important action by people, agents, and the orchestrator." })}
    <section class="panel">${events.length ? `<div id="activity-list">${timeline(events)}</div>` : '<div class="empty-inline">No activity yet.</div>'}
    ${state.activityCursor ? '<div class="load-more"><button class="button secondary" data-action="more-activity">Load older events</button></div>' : ""}</section>`;
}

async function moreActivity(button) {
  button.disabled = true;
  try {
    const { events } = await api(wsPath(`/activity?limit=50&before=${encodeURIComponent(state.activityCursor)}`));
    $("#activity-list").insertAdjacentHTML("beforeend", timeline(events));
    state.activityCursor = events.length === 50 ? events[events.length - 1].created_at : null;
    if (!state.activityCursor) button.parentElement.remove();
  } finally { button.disabled = false; }
}

// ---------- settings ----------

async function renderSettings() {
  setBreadcrumbs(["Settings"]);
  const [{ workspace }, { members }] = await Promise.all([api(wsPath("")), api(wsPath("/members"))]);
  const user = state.me?.user || {};
  const manage = can("member.manage");
  const team = workspace.kind === "team";
  return `
    ${pageHead({ eyebrow: "CONFIGURATION", title: "Settings" })}
    <section class="grid-2">
      <section class="panel pad">
        <div class="eyebrow">WORKSPACE</div><h2 class="h2">Workspace settings</h2>
        <form id="workspace-form" class="inline-form">
          ${field({ name: "name", label: "Workspace name", required: true, value: workspace.name, attrs: `minlength="2" maxlength="80" ${can("workspace.update") ? "" : "disabled"}` })}
          ${can("workspace.update") ? '<button class="button primary" type="submit">Save name</button>' : ""}
        </form>
        <div class="detail-grid">
          <div><span class="k">Type</span><span>${workspace.kind === "personal" ? "Personal" : "Team"}</span></div>
          <div><span class="k">Your role</span>${badge(workspace.role, "role")}</div>
          <div><span class="k">Members</span><span class="mono">${workspace.member_count}</span></div>
          <div><span class="k">ID</span><span class="mono tiny">${esc(workspace.id)}</span></div>
        </div>
        <h3 class="section-title">Your permissions</h3>
        <div class="chips">${workspace.permissions.map((p) => `<span class="chip">${esc(p)}</span>`).join("")}</div>
        <h3 class="section-title">New team workspace</h3>
        <p class="prose muted">Team workspaces support members with owner, admin, member and viewer roles.</p>
        <button class="button secondary" data-action="new-workspace">＋ Create team workspace</button>
      </section>
      <section class="panel pad">
        <div class="eyebrow">ACCOUNT</div><h2 class="h2">User settings</h2>
        <div class="detail-grid">
          <div><span class="k">Name</span><span>${esc(user.display_name || state.clerk?.user?.fullName || "—")}</span></div>
          <div><span class="k">Email</span><span>${esc(user.email || state.clerk?.user?.primaryEmailAddress?.emailAddress || "—")}</span></div>
          <div><span class="k">User ID</span><span class="mono tiny">${esc(user.id || "")}</span></div>
          <div><span class="k">Member since</span><span>${user.created_at ? new Date(user.created_at).toLocaleDateString() : "—"}</span></div>
        </div>
        <div class="button-row"><button class="button secondary" data-action="open-profile">Manage account</button><button class="button danger" data-action="sign-out">Sign out</button></div>
        <p class="tiny">Profile, connected Google account and active sessions are managed securely by Clerk.</p>
      </section>
    </section>
    <section class="panel">
      <div class="panel-head"><div><div class="eyebrow">ACCESS</div><h2>Members</h2></div>${manage && team ? '<button class="button primary" data-action="add-member">＋ Add member</button>' : ""}</div>
      ${!team ? '<div class="empty-inline">Personal workspaces are private to you. Create a team workspace to collaborate.</div>' : ""}
      <ul class="list">${members.map((m) => `<li class="list-row"><div class="avatar small">${esc((m.display_name || m.email || "?").charAt(0).toUpperCase())}</div><div class="row-main"><strong>${esc(m.display_name || m.email || short(m.user_id))}${m.user_id === user.id ? ' <span class="chip muted">YOU</span>' : ""}</strong><span class="mono tiny">${esc(m.email || m.user_id)} · JOINED ${timeAgo(m.created_at)}</span></div>
        <div class="row-side">${manage && team && m.user_id !== user.id ? `<select class="mini-select" data-action="member-role" data-id="${esc(m.user_id)}" aria-label="Role for ${esc(m.email || m.user_id)}">${state.catalog.roles.map((r) => `<option value="${r}" ${r === m.role ? "selected" : ""}>${label(r) === r ? r[0].toUpperCase() + r.slice(1) : r}</option>`).join("")}</select><button class="button mini secondary" data-action="remove-member" data-id="${esc(m.user_id)}">Remove</button>` : badge(m.role, "role")}</div></li>`).join("")}</ul>
    </section>`;
}

// ---------- event delegation ----------

document.addEventListener("click", async (event) => {
  const tab = event.target.closest("[data-tab]");
  if (tab) {
    const base = location.hash.slice(1).split("?")[0];
    go(`#${base}${tab.dataset.tab === "all" && !base.includes("approvals") ? "" : `?status=${encodeURIComponent(tab.dataset.tab)}`}`);
    return;
  }
  if (event.target.closest("[data-close-dialog]")) { event.target.closest("dialog")?.close(); return; }
  const el = event.target.closest("[data-action]");
  if (!el || el.tagName === "SELECT") return;
  const { action, id } = el.dataset;
  try {
    switch (action) {
      case "retry": router(); break;
      case "new-task": newTask(); break;
      case "edit-task": {
        const task = state.currentTask;
        openForm({ eyebrow: "EDIT TASK", title: "Edit task", body: taskForm(task), onSubmit: async (form) => {
          const body = Object.fromEntries(form);
          body.required_capability = body.required_capability || null;
          await api(wsPath(`/tasks/${encodeURIComponent(id)}`), { method: "PATCH", body });
          toast("Task updated."); router();
        } });
        break;
      }
      case "task-status": {
        if (el.dataset.status === "completed" || el.dataset.status === "blocked") {
          const ok = await confirmAction({ title: el.dataset.status === "completed" ? "Mark this task completed?" : "Mark this task blocked?", message: el.dataset.status === "completed" ? "Completed tasks cannot be edited or run again." : "Blocked tasks can be resumed later.", ok: el.textContent });
          if (!ok) return;
        }
        await api(wsPath(`/tasks/${encodeURIComponent(id)}/status`), { method: "PATCH", body: { status: el.dataset.status } });
        toast("Task updated."); router(); break;
      }
      case "request-approval": requestApproval(id); break;
      case "run-task": await runTask(id); break;
      case "approve": await decide(id, "approved"); break;
      case "reject": await decide(id, "rejected"); break;
      case "cancel-approval": {
        const ok = await confirmAction({ title: "Cancel this approval request?", message: "The action will not execute. A waiting run will be cancelled and the task blocked.", ok: "Cancel request", danger: true });
        if (!ok) return;
        await api(wsPath(`/approvals/${encodeURIComponent(id)}/cancel`), { method: "POST" });
        toast("Approval cancelled."); router(); break;
      }
      case "new-agent": newAgent(); break;
      case "edit-agent": openForm({ eyebrow: "AGENT CONFIGURATION", title: "Configure agent", body: agentForm(state.currentAgent), onSubmit: async (form) => {
        await api(wsPath(`/agents/${encodeURIComponent(id)}`), { method: "PATCH", body: agentBody(form) });
        toast("Agent configuration saved."); router();
      } }); break;
      case "agent-status": {
        if (el.dataset.status === "disabled") {
          const ok = await confirmAction({ title: "Disable this agent?", message: "Disabled agents cannot be selected for runs until returned to draft and re-activated.", ok: "Disable", danger: true });
          if (!ok) return;
        }
        await api(wsPath(`/agents/${encodeURIComponent(id)}/status`), { method: "POST", body: { status: el.dataset.status } });
        toast(`Agent ${LABELS[el.dataset.status].toLowerCase()}.`); router(); break;
      }
      case "cancel-run": {
        const ok = await confirmAction({ title: "Cancel this run?", message: "The run stops immediately, pending approvals are cancelled, and the task becomes blocked.", ok: "Cancel run", danger: true });
        if (!ok) return;
        await api(wsPath(`/runs/${encodeURIComponent(id)}/cancel`), { method: "POST" });
        toast("Run cancelled."); router(); break;
      }
      case "connect": connectAdapter(el.dataset.adapter); break;
      case "edit-connection": editConnection(el); break;
      case "more-activity": await moreActivity(el); break;
      case "new-workspace": openForm({ eyebrow: "WORKSPACES", title: "Create team workspace", submit: "Create", body: field({ name: "name", label: "Workspace name", required: true, attrs: 'minlength="2" maxlength="80"' }), onSubmit: async (form) => {
        const { workspace } = await api("/api/workspaces", { method: "POST", body: { name: form.get("name") } });
        await loadIdentity(workspace.id);
        toast("Team workspace created."); go("#/settings");
      } }); break;
      case "add-member": openForm({ eyebrow: "ACCESS", title: "Add member", submit: "Add member",
        body: field({ name: "email", label: "Email", type: "email", required: true, hint: "The person must have signed in to ZUVANE at least once." }) +
          field({ name: "role", label: "Role", required: true, value: "member", options: (state.ws.role === "owner" ? [["admin", "Admin"]] : []).concat([["member", "Member"], ["viewer", "Viewer"]]) }),
        onSubmit: async (form) => {
          await api(wsPath("/members"), { method: "POST", body: Object.fromEntries(form) });
          toast("Member added."); router();
        } }); break;
      case "remove-member": {
        const ok = await confirmAction({ title: "Remove this member?", message: "They immediately lose access to this workspace.", ok: "Remove", danger: true });
        if (!ok) return;
        await api(wsPath(`/members/${encodeURIComponent(id)}`), { method: "DELETE" });
        toast("Member removed."); router(); break;
      }
      case "open-profile": state.clerk.openUserProfile(); break;
      case "sign-out": {
        const ok = await confirmAction({ title: "Sign out?", message: "Your session on this device will end.", ok: "Sign out" });
        if (ok) await state.clerk.signOut();
        break;
      }
      default: break;
    }
  } catch (error) {
    toast(error.message, true);
  }
});

document.addEventListener("change", async (event) => {
  const select = event.target.closest('[data-action="member-role"]');
  if (select) {
    try {
      await api(wsPath(`/members/${encodeURIComponent(select.dataset.id)}`), { method: "PATCH", body: { role: select.value } });
      toast("Role updated.");
    } catch (error) { toast(error.message, true); }
    router();
  }
});

document.addEventListener("submit", async (event) => {
  if (event.target.id !== "workspace-form") return;
  event.preventDefault();
  try {
    const name = new FormData(event.target).get("name");
    await api(wsPath(""), { method: "PATCH", body: { name } });
    await loadIdentity(state.ws.id);
    toast("Workspace renamed."); router();
  } catch (error) { toast(error.message, true); }
});

$("#workspace-select").addEventListener("change", (event) => {
  selectWorkspace(event.target.value);
  go("#/overview");
});

$("#menu-toggle").addEventListener("click", () => {
  const open = !document.body.classList.contains("nav-open");
  document.body.classList.toggle("nav-open", open);
  $("#menu-toggle").setAttribute("aria-expanded", String(open));
});

window.addEventListener("hashchange", router);

// ---------- identity & workspace ----------

function selectWorkspace(id) {
  const ws = state.workspaces.find((w) => w.id === id) || state.workspaces[0];
  state.ws = ws;
  try { localStorage.setItem("zuvane.workspace", ws.id); } catch { /* storage unavailable */ }
  $("#user-role").textContent = `${label(ws.role) === ws.role ? ws.role : ws.role} · ${ws.kind === "personal" ? "Personal" : "Team"}`.toUpperCase();
  $("#workspace-kind-pill").innerHTML = `<i></i> ${ws.kind === "personal" ? "PRIVATE WORKSPACE" : "TEAM WORKSPACE"}`;
}

async function loadIdentity(preferred) {
  const me = await api("/api/me");
  state.me = me;
  state.workspaces = me.workspaces;
  const select = $("#workspace-select");
  select.innerHTML = me.workspaces.map((w) => `<option value="${esc(w.id)}">${esc(w.name)}${w.kind === "team" ? " · Team" : ""}</option>`).join("");
  let stored = preferred;
  if (!stored) { try { stored = localStorage.getItem("zuvane.workspace"); } catch { stored = null; } }
  selectWorkspace(stored);
  select.value = state.ws.id;
  const name = me.user?.display_name || state.clerk?.user?.fullName || "Workspace member";
  $("#user-name").textContent = name;
  $("#user-avatar").textContent = name.trim().charAt(0).toUpperCase() || "Z";
}

async function enterWorkspace() {
  view().innerHTML = skeleton(6);
  try {
    const health = await fetch("/api/health").then((r) => r.json()).catch(() => ({}));
    state.version = health.version || "—";
    $("#build-label").textContent = `BUILD ${state.version}`;
    const [catalog] = await Promise.all([api("/api/catalog"), loadIdentity()]);
    state.catalog = catalog;
    setConnection(true);
    if (!location.hash) location.hash = "#/overview"; else router();
  } catch (error) {
    view().innerHTML = errorState(error);
  }
}

// ---------- Clerk bootstrap ----------

function loadScript(src, attributes = {}) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.crossOrigin = "anonymous";
    Object.entries(attributes).forEach(([key, value]) => script.setAttribute(key, value));
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Unable to load ${new URL(src).hostname}. Check the Clerk frontend domain.`));
    document.head.appendChild(script);
  });
}

const clerkAppearance = {
  variables: { colorPrimary: "#53d6c2", colorBackground: "#111a24", colorText: "#eaf0f4", colorTextSecondary: "#9aaab8", colorInputBackground: "#0b141d", colorInputText: "#eaf0f4", colorNeutral: "#eaf0f4", borderRadius: "10px", fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" },
  elements: { card: { boxShadow: "none", border: "1px solid #253342" }, footer: { background: "transparent" } }
};

async function initializeAuth() {
  const gate = $("#auth-gate");
  try {
    const configResponse = await fetch("/api/config", { headers: { accept: "application/json" } });
    const config = await configResponse.json().catch(() => ({}));
    if (!configResponse.ok) throw new Error(config.error || "Clerk frontend configuration is unavailable.");
    const frontendApi = new URL(config.frontendApiUrl).host;
    await loadScript(`https://${frontendApi}/npm/@clerk/ui@1/dist/ui.browser.js`);
    await loadScript(`https://${frontendApi}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`, { "data-clerk-publishable-key": config.publishableKey });
    if (!window.Clerk) throw new Error("ClerkJS did not initialize. Check the publishable key and frontend API domain.");
    state.clerk = window.Clerk;
    await state.clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor }, appearance: clerkAppearance });

    let signedInUser = null;
    const sync = async ({ user, session }) => {
      const signedIn = Boolean(user && session);
      document.body.classList.toggle("is-authenticated", signedIn);
      document.body.classList.toggle("is-signed-out", !signedIn);
      if (signedIn) {
        gate?.setAttribute("aria-hidden", "true");
        const userButton = $("#user-button");
        if (!userButton.dataset.mounted) { state.clerk.mountUserButton(userButton); userButton.dataset.mounted = "true"; }
        if (signedInUser !== user.id) { signedInUser = user.id; await enterWorkspace(); }
      } else {
        signedInUser = null;
        Object.assign(state, { me: null, workspaces: [], ws: null });
        view().innerHTML = "";
        gate?.removeAttribute("aria-hidden");
        const signIn = $("#clerk-sign-in");
        if (signIn && !signIn.dataset.mounted) { signIn.replaceChildren(); state.clerk.mountSignIn(signIn, { appearance: clerkAppearance }); signIn.dataset.mounted = "true"; }
      }
    };
    state.clerk.addListener(sync);
    await sync({ user: state.clerk.user, session: state.clerk.session });
    document.body.classList.remove("auth-pending");
  } catch (error) {
    document.body.classList.remove("auth-pending", "is-authenticated");
    document.body.classList.add("is-signed-out", "auth-error");
    const signIn = $("#clerk-sign-in");
    if (signIn) signIn.innerHTML = `<p class="auth-error-message">${esc(error.message)}</p><button class="button secondary" id="retry-auth" type="button">Retry connection</button>`;
    $("#retry-auth")?.addEventListener("click", () => window.location.reload());
  }
}

initializeAuth();
