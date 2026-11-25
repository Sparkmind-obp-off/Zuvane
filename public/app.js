const $ = (selector) => document.querySelector(selector);
const state = { tasks: [], approvals: [], filter: "all", apiOnline: false, clerk: null };

async function api(path, options = {}) {
  const token = await state.clerk?.session?.getToken();
  if (!token) throw new Error("Your session has ended. Sign in again.");
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
function syncIdentity(user) {
  const name = user?.fullName || user?.firstName || "Workspace member";
  const email = user?.primaryEmailAddress?.emailAddress || "Signed in securely";
  $("#user-name").textContent = name;
  $("#user-email").textContent = email;
  $("#user-avatar").textContent = name.trim().charAt(0).toUpperCase() || "Z";
}
function prettyStatus(status) {
  return ({ planned: "Planned", in_progress: "In progress", needs_approval: "Needs approval", completed: "Completed", blocked: "Blocked" })[status] || status;
}
function render() {
  const tasks = state.tasks;
  $("#task-count").textContent = tasks.length;
  $("#metric-total").textContent = tasks.length;
  $("#metric-progress").textContent = tasks.filter(t => t.status === "in_progress").length;
  $("#metric-approvals").textContent = state.approvals.length;
  $("#metric-completed").textContent = tasks.filter(t => t.status === "completed").length;
  $("#approval-count").textContent = state.approvals.length;
  $("#approval-counter").textContent = state.approvals.length;
  const visible = state.filter === "all" ? tasks : tasks.filter(t => t.status === state.filter);
  $("#task-total-label").textContent = `${visible.length} ITEMS`;
  $("#task-list").innerHTML = visible.length ? visible.map(task => `
    <article class="task-row">
      <div class="task-priority ${task.priority}"></div>
      <div class="task-main"><strong>${escapeHtml(task.title)}</strong><p>${escapeHtml(task.description || "No description added.")}</p><span class="mono task-meta">${escapeHtml(task.id.slice(0, 8))} · ${new Date(task.updated_at).toLocaleDateString()}</span></div>
      <span class="status status-${task.status}">${prettyStatus(task.status)}</span>
      <div class="task-actions">${task.status === "planned" ? `<button data-action="start" data-id="${task.id}" class="text-action">Start →</button>` : ""}${task.status === "in_progress" ? `<button data-action="complete" data-id="${task.id}" class="text-action">Complete ✓</button><button data-action="approval" data-id="${task.id}" class="text-action muted-action">Request approval</button>` : ""}${task.status === "needs_approval" ? '<span class="mono tiny">WAITING FOR YOU</span>' : ""}${task.status === "blocked" ? `<button data-action="resume" data-id="${task.id}" class="text-action">Resume →</button>` : ""}</div>
    </article>`).join("") : '<div class="empty-state">Nothing here yet. Create a task to start moving forward.</div>';
  $("#approval-list").innerHTML = state.approvals.length ? state.approvals.map(item => `
    <article class="approval-row"><div class="approval-mark">◷</div><div class="approval-body"><strong>${escapeHtml(item.action)}</strong><p>Task ${escapeHtml(item.task_id.slice(0, 8))}</p><div class="approval-actions"><button data-approval="approved" data-id="${item.id}" class="button mini primary">Approve</button><button data-approval="rejected" data-id="${item.id}" class="button mini secondary">Reject</button></div></div></article>`).join("") : '<div class="empty-state compact">No pending approvals.<br><span>You are all caught up.</span></div>';
}
function toast(message, error = false) {
  const el = $("#toast"); el.textContent = message; el.classList.toggle("error", error); el.classList.add("show");
  window.clearTimeout(toast.timer); toast.timer = window.setTimeout(() => el.classList.remove("show"), 2800);
}
async function refresh() {
  try {
    const [tasks, approvals] = await Promise.all([api("/api/tasks"), api("/api/approvals")]);
    state.tasks = tasks.tasks; state.approvals = approvals.approvals; state.apiOnline = true;
    $("#connection-state").textContent = "Connected"; $(".status-dot").classList.add("online");
    render();
  } catch (error) {
    state.apiOnline = false; $("#connection-state").textContent = "Unavailable";
    $(".status-dot").classList.remove("online");
    $("#task-list").innerHTML = '<div class="empty-state">The workspace API is unavailable. Check the Worker and D1 configuration.</div>';
    toast(error.message, true);
  }
}
$("#new-task-button").addEventListener("click", () => $("#task-dialog").showModal());
$("#close-dialog").addEventListener("click", () => $("#task-dialog").close());
$("#cancel-dialog").addEventListener("click", () => $("#task-dialog").close());
$("#task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await api("/api/tasks", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) });
    event.currentTarget.reset(); $("#task-dialog").close(); await refresh(); toast("Task created.");
  } catch (error) { $("#form-error").textContent = error.message; }
});
document.addEventListener("click", async (event) => {
  const filter = event.target.closest("[data-filter]");
  if (filter) {
    state.filter = filter.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach(tab => tab.classList.toggle("active", tab === filter));
    render(); return;
  }
  const action = event.target.closest("[data-action]");
  const decision = event.target.closest("[data-approval]");
  try {
    if (action) {
      if (action.dataset.action === "approval") {
        const actionText = window.prompt("Describe the action that needs your approval:");
        if (!actionText?.trim()) return;
        await api("/api/approvals", { method: "POST", body: JSON.stringify({ task_id: action.dataset.id, action: actionText.trim() }) });
      } else {
        const next = ({ start: "in_progress", complete: "completed", resume: "in_progress" })[action.dataset.action];
        await api(`/api/tasks/${action.dataset.id}/status`, { method: "PATCH", body: JSON.stringify({ status: next }) });
      }
      await refresh(); toast("Workspace updated.");
    }
    if (decision) {
      await api(`/api/approvals/${decision.dataset.id}/decision`, { method: "POST", body: JSON.stringify({ decision: decision.dataset.approval }) });
      await refresh(); toast(`Approval ${decision.dataset.approval}.`);
    }
  } catch (error) { toast(error.message, true); }
});

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

async function initializeAuth() {
  const gate = $("#auth-gate");
  try {
    const configResponse = await fetch("/api/config", { headers: { accept: "application/json" } });
    const config = await configResponse.json().catch(() => ({}));
    if (!configResponse.ok) throw new Error(config.error || "Clerk frontend configuration is unavailable.");
    const frontendApi = new URL(config.frontendApiUrl).host;
    await loadScript(`https://${frontendApi}/npm/@clerk/ui@1/dist/ui.browser.js`);
    await loadScript(`https://${frontendApi}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`, {
      "data-clerk-publishable-key": config.publishableKey
    });
    if (!window.Clerk) throw new Error("ClerkJS did not initialize. Check the publishable key and frontend API domain.");
    state.clerk = window.Clerk;
    await state.clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });

    const sync = async ({ user, session }) => {
      const signedIn = Boolean(user && session);
      document.body.classList.toggle("is-authenticated", signedIn);
      document.body.classList.toggle("is-signed-out", !signedIn);
      if (signedIn) {
        syncIdentity(user);
        const userButton = $("#user-button");
        if (!userButton.dataset.mounted) {
          state.clerk.mountUserButton(userButton);
          userButton.dataset.mounted = "true";
        }
        if (gate) gate.setAttribute("aria-hidden", "true");
        await refresh();
      } else {
        state.tasks = [];
        state.approvals = [];
        if (gate) gate.removeAttribute("aria-hidden");
        const signIn = $("#clerk-sign-in");
        if (signIn && !signIn.dataset.mounted) {
          signIn.replaceChildren();
          state.clerk.mountSignIn(signIn);
          signIn.dataset.mounted = "true";
        }
      }
    };
    state.clerk.addListener(sync);
    await sync({ user: state.clerk.user, session: state.clerk.session });
    document.body.classList.remove("auth-pending");
  } catch (error) {
    document.body.classList.remove("auth-pending", "is-authenticated");
    document.body.classList.add("is-signed-out", "auth-error");
    const signIn = $("#clerk-sign-in");
    if (signIn) signIn.innerHTML = `<p class="auth-error-message">${escapeHtml(error.message)}</p><button class="button secondary" id="retry-auth">Retry connection</button>`;
    $("#retry-auth")?.addEventListener("click", () => window.location.reload());
  }
}
initializeAuth();