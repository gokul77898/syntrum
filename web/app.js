// SYNTRUM browser controller.
// All state comes from the loopback API proxy. No fabricated entities.

import { icon } from "./icons.js";
import * as views from "./views.js";

const SIZES = {
  small: { cpu: 1, memoryMb: 1024, diskGb: 5 },
  medium: { cpu: 2, memoryMb: 4096, diskGb: 40 }
};

const state = {
  authenticated: false,
  csrf: "",
  view: "overview",
  computers: null,
  workers: null,
  health: null,
  gpus: null,
  selectedId: null,
  desktop: null,
  loading: false,
  error: null,
  busy: new Set()
};

const $ = sel => document.querySelector(sel);
const el = {
  root: $("#root"),
  gate: $("#gate"),
  gatePanel: $("#gate-panel"),
  nav: $("#nav"),
  railMeta: $("#rail-meta"),
  title: $("#page-title"),
  sub: $("#page-sub"),
  actions: $("#topbar-actions"),
  main: $("#main"),
  toasts: $("#toasts")
};

/* ── api ──────────────────────────────────────────────── */

async function api(path, { method = "GET", body } = {}) {
  const headers = { "content-type": "application/json" };
  if (method !== "GET" && state.csrf) headers["x-syntrum-csrf"] = state.csrf;

  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch {
    throw new Error("Network request failed. Is the SYNTRUM server still running?");
  }

  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { /* non-JSON */ }

  if (response.status === 401) {
    state.authenticated = false;
    renderGate();
    throw new Error(payload.error ?? "Session expired. Sign in again.");
  }
  if (!response.ok) {
    throw new Error(payload.error ?? `Request failed (${response.status})`);
  }
  return payload;
}

/* ── routing ──────────────────────────────────────────── */

const TITLES = {
  overview: ["Overview", "Fleet health and allocation"],
  computers: ["Computers", "Provision, start and destroy cloud computers"],
  workspace: ["Workspace", "The shared desktop surface"],
  agents: ["Agents", "MCP participants in the guest runtime"],
  settings: ["Diagnostics", "Control plane, workers and gateway state"]
};

function go(view, id) {
  if (id !== undefined) state.selectedId = id;
  state.view = view;
  if (view === "workspace" && !state.selectedId && state.computers?.length) {
    state.selectedId = state.computers[0].id;
  }
  location.hash = view === "workspace" && state.selectedId
    ? `#workspace/${state.selectedId}`
    : `#${view}`;
}

function readHash() {
  const raw = location.hash.replace(/^#/, "");
  const [view, id] = raw.split("/");
  if (["overview", "computers", "workspace", "agents", "settings"].includes(view)) {
    state.view = view;
    if (id) state.selectedId = decodeURIComponent(id);
  }
}

/* ── data ─────────────────────────────────────────────── */

async function loadFleet({ quiet = false } = {}) {
  if (!quiet) { state.loading = true; render(); }
  try {
    const [fleet, workers] = await Promise.all([
      api("/api/computers"),
      api("/api/workers").catch(() => ({ workers: [] }))
    ]);
    state.computers = fleet.computers ?? [];
    state.workers = workers.workers ?? [];
    state.error = null;
    state.health = "healthy";

    if (state.view === "workspace") {
      const target = state.computers.find(c => c.id === state.selectedId) ?? state.computers[0];
      state.selectedId = target?.id ?? null;
      if (target) await loadDesktop(target.id, { quiet: true });
    }
  } catch (error) {
    state.error = error.message;
    state.health = "unreachable";
    if (!quiet) state.computers = state.computers ?? null;
  } finally {
    state.loading = false;
    render();
  }
}

async function loadDesktop(id, { quiet = false } = {}) {
  if (!quiet) { state.desktop = null; state.loading = true; render(); }
  try {
    state.desktop = await api(`/api/computers/${encodeURIComponent(id)}/desktop`);
  } catch (error) {
    state.desktop = {
      available: false,
      gateway: "error",
      reason: error.message,
      required: []
    };
  } finally {
    state.loading = false;
    render();
  }
}

async function operate(op, id) {
  const key = `${op}:${id}`;
  if (state.busy.has(key)) return;
  state.busy.add(key);
  render();
  try {
    const method = op === "delete" ? "DELETE" : "POST";
    await api(`/api/computers/${encodeURIComponent(id)}/${op}`, { method });
    toast(`${op[0].toUpperCase()}${op.slice(1)} requested`, "ok");
    await loadFleet({ quiet: true });
  } catch (error) {
    toast(error.message, "error");
  } finally {
    state.busy.delete(key);
    render();
  }
}

/* ── render ───────────────────────────────────────────── */

function render() {
  if (!state.authenticated) { renderGate(); return; }

  el.root.hidden = false;
  el.gate.hidden = true;

  el.nav.innerHTML = views.nav({ view: state.view, computers: state.computers });
  el.railMeta.innerHTML = views.railMeta({
    health: state.health,
    workers: state.workers
  });

  const [title, sub] = TITLES[state.view] ?? TITLES.overview;
  el.title.textContent = title;
  el.sub.textContent = sub;

  el.actions.innerHTML = "";
  if (state.view === "computers" || state.view === "overview") {
    el.actions.innerHTML = `
      <button class="btn" data-action="refresh" ${state.loading ? "disabled" : ""}>
        ${icon("refresh")} Refresh
      </button>
      <button class="btn btn--primary" data-action="create">${icon("plus")} New computer</button>`;
  } else if (state.view === "workspace") {
    el.actions.innerHTML = `
      <button class="btn" data-nav="computers">${icon("computers")} Fleet</button>`;
  } else {
    el.actions.innerHTML = `
      <button class="btn" data-action="logout">${icon("logout")} Sign out</button>`;
  }

  const computer = state.computers?.find(c => c.id === state.selectedId) ?? null;
  const body = {
    overview: () => views.overview({
      computers: state.computers, loading: state.loading, error: state.error, gp: state.gpus
    }),
    computers: () => views.computersView({
      computers: state.computers, loading: state.loading, error: state.error
    }),
    workspace: () => views.workspace({
      computer, desktop: state.desktop, loading: state.loading, error: state.error
    }),
    agents: () => views.agentsView({ computers: state.computers }),
    settings: () => views.settingsView({
      computers: state.computers, workers: state.workers,
      health: state.health, error: state.error
    })
  }[state.view] ?? (() => "");

  el.main.className = state.view === "workspace" ? "main main--flush" : "main";
  el.main.innerHTML = body();
}

function renderGate() {
  el.root.hidden = true;
  el.gate.hidden = false;
  el.gatePanel.innerHTML = views.gate({ loading: false, error: null });
  $("#gate-token")?.focus();
}

/* ── toasts ───────────────────────────────────────────── */

function toast(message, kind = "ok") {
  const node = document.createElement("div");
  node.className = `toast toast--${kind}`;
  node.innerHTML = `${icon(kind === "error" ? "alert" : "check")}<span>${views.esc(message)}</span>`;
  el.toasts.append(node);
  setTimeout(() => {
    node.style.opacity = "0";
    node.style.transform = "translateY(6px)";
    node.style.transition = "opacity .18s, transform .18s";
    setTimeout(() => node.remove(), 200);
  }, kind === "error" ? 7000 : 3200);
}

/* ── dialogs ──────────────────────────────────────────── */

function openCreate() {
  const host = document.createElement("div");
  host.innerHTML = views.createDialog();
  const dialog = host.firstElementChild;
  document.body.append(dialog);

  const sync = size => {
    const spec = SIZES[size];
    $("#in-cpu").value = spec.cpu;
    $("#in-mem").value = spec.memoryMb;
    $("#in-disk").value = spec.diskGb;
    dialog.querySelectorAll("[data-size]").forEach(btn => {
      btn.setAttribute("aria-pressed", String(btn.dataset.size === size));
    });
  };
  dialog.querySelectorAll("[data-size]").forEach(btn => {
    btn.addEventListener("click", () => sync(btn.dataset.size));
  });

  dialog.addEventListener("close", async () => {
    if (dialog.returnValue === "cancel") { dialog.remove(); return; }
    const body = {
      cpu: Number($("#in-cpu").value),
      memoryMb: Number($("#in-mem").value),
      diskGb: Number($("#in-disk").value),
      desktopEnabled: $("#in-desktop").value === "true"
    };
    const submit = $("#create-submit");
    submit.disabled = true;
    submit.innerHTML = '<span class="spinner"></span> Creating';
    try {
      const created = await api("/api/computers", { method: "POST", body });
      dialog.remove();
      toast(`Computer ${String(created.computer?.id).slice(0, 8)} created`, "ok");
      await loadFleet({ quiet: true });
    } catch (error) {
      submit.disabled = false;
      submit.textContent = "Create computer";
      toast(error.message, "error");
    }
  });

  dialog.showModal();
}

function confirmDestroy(id) {
  const host = document.createElement("div");
  host.innerHTML = views.confirmDialog();
  const dialog = host.firstElementChild;
  document.body.append(dialog);
  dialog.addEventListener("close", async () => {
    if (dialog.returnValue === "cancel") { dialog.remove(); return; }
    await operate("delete", id);
    dialog.remove();
  });
  dialog.showModal();
}

/* ── events ───────────────────────────────────────────── */

document.addEventListener("click", event => {
  const nav = event.target.closest("[data-nav]");
  if (nav) { go(nav.dataset.nav); render(); return; }

  const open = event.target.closest("[data-open]");
  if (open) { go("workspace", open.dataset.open); loadDesktop(open.dataset.open); return; }

  const op = event.target.closest("[data-op]");
  if (op) {
    const { op: name, id } = op.dataset;
    if (name === "delete") { confirmDestroy(id); return; }
    operate(name, id);
    return;
  }

  const action = event.target.closest("[data-action]")?.dataset.action;
  if (!action) return;
  if (action === "refresh") loadFleet();
  if (action === "create") openCreate();
  if (action === "refresh-desktop" && state.selectedId) loadDesktop(state.selectedId);
  if (action === "desktop-fullscreen") {
    const stage = document.getElementById("desktop-stage");
    // The Fullscreen API needs the element, not the iframe's document; a
    // rejection is normal when the browser blocks it outside a user gesture.
    stage?.requestFullscreen?.().catch(() => undefined);
  }
  if (action === "desktop-reconnect") {
    // Reloading the iframe re-runs noVNC's own reconnect path, which is more
    // reliable than reaching into its object graph across the frame boundary.
    const frame = document.getElementById("desktop-frame");
    if (frame) frame.src = frame.src;
  }
  if (action === "logout") {
    api("/api/logout", { method: "POST" })
      .catch(() => undefined)
      .finally(() => {
        state.authenticated = false;
        state.computers = null;
        renderGate();
      });
  }
});

document.addEventListener("submit", async event => {
  if (event.target.id !== "gate-form") return;
  event.preventDefault();
  const token = $("#gate-token").value.trim();
  const button = $("#gate-submit");
  const errorBox = $("#gate-error");
  button.disabled = true;
  button.innerHTML = '<span class="spinner"></span> Verifying';
  errorBox.hidden = true;
  try {
    const result = await api("/api/login", { method: "POST", body: { token } });
    state.csrf = result.csrf;
    state.authenticated = true;
    readHash();
    render();
    await loadFleet();
  } catch (error) {
    button.disabled = false;
    button.textContent = "Continue";
    errorBox.hidden = false;
    errorBox.innerHTML = `${icon("alert")}<span>${views.esc(error.message)}</span>`;
  }
});

window.addEventListener("hashchange", () => {
  if (!state.authenticated) return;
  readHash();
  if (state.view === "workspace" && state.selectedId) loadDesktop(state.selectedId);
  render();
});

/* ── boot ─────────────────────────────────────────────── */

async function boot() {
  try {
    const session = await api("/api/session");
    if (session.authenticated) {
      state.csrf = session.csrf;
      state.authenticated = true;
      readHash();
      render();
      await loadFleet();
      return;
    }
  } catch { /* fall through to gate */ }
  renderGate();
}

boot();
