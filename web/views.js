// Pure view builders. Every value rendered here comes from the SYNTRUM cloud API
// or an explicit "unavailable" state. Nothing is invented.

import { icon } from "./icons.js";

export const esc = value =>
  String(value ?? "").replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));

const shortId = id => String(id ?? "").slice(0, 8);
const gib = mb => `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GiB`;

export function relativeTime(iso) {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diff = Math.max(0, Date.now() - then);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function statusBadge(status) {
  const label = String(status ?? "unknown");
  const cls = ["running", "stopped", "error", "provisioning", "starting", "stopping",
    "restarting", "deleting", "deleted"].includes(label) ? label : "";
  return `<span class="status status--${cls}"><span class="status__dot"></span>${esc(label)}</span>`;
}

export function nav({ view, computers }) {
  const running = (computers ?? []).filter(c => c.status === "running").length;
  const total = (computers ?? []).length;
  const items = [
    { id: "overview", label: "Overview", glyph: "overview" },
    { id: "computers", label: "Computers", glyph: "computers", count: total || undefined },
    { id: "workspace", label: "Workspace", glyph: "workspace" },
    { id: "agents", label: "Agents", glyph: "agents" },
    { id: "settings", label: "Diagnostics", glyph: "settings" }
  ];
  return `
    <div class="rail__section">Runtime</div>
    ${items.map(item => `
      <button class="nav-item" data-nav="${item.id}"
        ${view === item.id ? 'aria-current="page"' : ""}>
        ${icon(item.glyph)}
        <span class="label">${item.label}</span>
        ${item.count !== undefined ? `<span class="nav-item__count">${item.count}</span>` : ""}
      </button>`).join("")}
    <div class="rail__section">Fleet</div>
    <div class="rail__meta" style="padding:0 12px">
      <span>${running} running · ${total} total</span>
    </div>`;
}

export function railMeta({ health, workers }) {
  const reachable = health === "healthy";
  const worker = workers?.[0];
  return `
    <div class="status status--${reachable ? "running" : "error"}">
      <span class="status__dot"></span>
      Control plane ${reachable ? "connected" : "unreachable"}
    </div>
    ${worker ? `
      <div class="status">
        <span class="status__dot" style="background:var(--text-faint)"></span>
        ${esc(worker.host ?? "worker")} · ${esc(worker.architecture ?? "?")}
      </div>` : `
      <div class="status"><span class="status__dot"></span>No worker registered</div>`}`;
}

/* ── Overview ─────────────────────────────────────────── */

export function overview({ computers, loading, error, gp }) {
  if (loading && !computers) return loadingState("Reading fleet");
  if (error && !computers) return errorState(error);

  const list = computers ?? [];
  const running = list.filter(c => c.status === "running").length;
  const stopped = list.filter(c => c.status === "stopped").length;
  const busy = list.filter(c =>
    ["provisioning", "starting", "restarting", "stopping", "deleting"].includes(c.status)).length;
  const failed = list.filter(c => c.status === "error").length;

  const cpu = list.reduce((n, c) => n + (Number(c.cpu) || 0), 0);
  const mem = list.reduce((n, c) => n + (Number(c.memoryMb) || 0), 0);
  const disk = list.reduce((n, c) => n + (Number(c.diskGb) || 0), 0);
  const withDesktop = list.filter(c => c.desktopEnabled).length;

  const metrics = `
    <div class="metrics">
      ${metric("Running", running, `${list.length} computer${list.length === 1 ? "" : "s"}`)}
      ${metric("Allocated vCPU", cpu, "sum of limits")}
      ${metric("Allocated memory", gib(mem), "sum of limits")}
      ${metric("Storage", `${disk} GiB`, "sum of volumes")}
      ${metric("Desktops", withDesktop, withDesktop ? "provisioned" : "none yet")}
    </div>`;

  const fleetPanel = `
    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">Fleet</span>
        <span class="spacer" style="flex:1"></span>
        <button class="btn btn--ghost btn--sm" data-action="refresh" ${loading ? "disabled" : ""}>
          ${icon("refresh")} Refresh
        </button>
      </div>
      ${list.length === 0 ? emptyFleet() : `
        <div class="fleet">
          ${list.slice(0, 6).map(row).join("")}
        </div>
        ${list.length > 6 ? `<div style="padding:12px 16px;border-top:1px solid var(--line)">
          <button class="btn btn--ghost btn--sm" data-nav="computers">View all ${list.length}</button>
        </div>` : ""}
      `}
    </section>`;

  const healthPanel = `
    <section class="panel">
      <div class="panel__head"><span class="panel__title">Lifecycle</span></div>
      <div class="panel__body">
        <div class="kv">
          ${kv("Running", running)}
          ${kv("Stopped", stopped)}
          ${kv("Transitioning", busy)}
          ${kv("Failed", failed)}
          ${kv("GPU allocations", (gp?.allocations ?? []).length)}
        </div>
        ${failed > 0 ? `
          <div class="notice notice--error" style="margin-top:12px">
            ${icon("alert")}
            <span>${failed} computer${failed === 1 ? "" : "s"} in an error state. Open the computer to read the worker's exact message.</span>
          </div>` : ""}
      </div>
    </section>`;

  return `${metrics}<div class="grid-2">${fleetPanel}<div style="display:flex;flex-direction:column;gap:16px">${healthPanel}</div></div>`;
}

function metric(label, value, foot) {
  return `<div class="metric">
    <div class="metric__label">${esc(label)}</div>
    <div class="metric__value">${esc(value)}</div>
    <div class="metric__foot">${esc(foot)}</div>
  </div>`;
}

function kv(k, v) {
  return `<div class="kv__row"><dt class="kv__k">${esc(k)}</dt><dd class="kv__v">${esc(v)}</dd></div>`;
}

function emptyFleet() {
  return `<div class="empty"><div class="empty__inner">
    <div class="empty__icon">${icon("layers")}</div>
    <h3 class="empty__title">No cloud computers yet</h3>
    <p class="empty__body">Create a Linux computer to begin. Provisioning runs on the configured Incus worker.</p>
    <div class="empty__actions">
      <button class="btn btn--primary" data-action="create">${icon("plus")} New computer</button>
    </div>
  </div></div>`;
}

function row(c) {
  return `<button class="row" data-open="${esc(c.id)}">
    <div class="row__id">
      <div class="row__name">${esc(shortId(c.id))} <span class="pill">${esc(c.image)}</span></div>
      <div class="row__sub">${esc(c.id)}</div>
    </div>
    <div class="row__res">${esc(c.cpu)} vCPU</div>
    <div class="row__res">${esc(gib(c.memoryMb))}</div>
    <span class="status--col">${statusBadge(c.status)}</span>
  </button>`;
}

/* ── Computers ────────────────────────────────────────── */

export function computersView({ computers, loading, error }) {
  if (loading && !computers) return loadingState("Reading fleet");
  if (error && !computers) return errorState(error);

  const list = computers ?? [];

  if (list.length === 0) {
    return `<section class="panel">${emptyFleet()}</section>`;
  }

  return `<section class="panel" style="overflow:hidden">
    <table class="table">
      <thead><tr>
        <th>Computer</th><th>Status</th><th>Size</th><th>Desktop</th><th>Created</th><th></th>
      </tr></thead>
      <tbody>
        ${list.map(c => `<tr>
          <td>
            <button class="btn btn--ghost btn--sm" data-open="${esc(c.id)}" style="padding:0;height:auto">
              <span class="mono">${esc(shortId(c.id))}</span>
            </button>
            <div class="mono" style="color:var(--text-faint);font-size:10.5px">${esc(c.image)}</div>
          </td>
          <td>${statusBadge(c.status)}</td>
          <td class="mono">${esc(c.cpu)} vCPU · ${esc(gib(c.memoryMb))} · ${esc(c.diskGb)} GiB</td>
          <td>${c.desktopEnabled
            ? `<span class="pill">provisioned</span>`
            : `<span class="pill" style="color:var(--text-faint)">headless</span>`}</td>
          <td class="mono" style="color:var(--text-dim)">${esc(relativeTime(c.createdAt))}</td>
          <td>
            <div class="table__actions">
              ${c.status === "stopped" ? `<button class="btn btn--sm" data-op="start" data-id="${esc(c.id)}">${icon("play")} Start</button>` : ""}
              ${c.status === "running" ? `<button class="btn btn--sm" data-op="stop" data-id="${esc(c.id)}">${icon("stop")} Stop</button>` : ""}
              ${c.status === "running" ? `<button class="btn btn--sm" data-op="restart" data-id="${esc(c.id)}">${icon("restart")} Restart</button>` : ""}
              ${c.status === "stopped" ? `<button class="btn btn--sm btn--danger" data-op="delete" data-id="${esc(c.id)}">${icon("trash")}</button>` : ""}
            </div>
          </td>
        </tr>`).join("")}
      </tbody>
    </table>
  </section>`;
}

/* ── Workspace ────────────────────────────────────────── */

export function workspace({ computer, desktop, loading, error }) {
  if (loading && !computer) return loadingState("Opening workspace");
  if (error && !computer) return errorState(error);
  if (!computer) {
    return `<section class="panel">${emptyState(
      "workspace",
      "No computer selected",
      "Pick a computer from the fleet to open its workspace.",
      `<button class="btn btn--primary" data-nav="computers">${icon("computers")} Choose computer</button>`
    )}</section>`;
  }

  const d = desktop ?? {};
  const status = String(computer.status);
  const ready = status === "running";

  const viewport = d.available
    ? `<div class="viewport__stage" id="desktop-stage"></div>`
    : `<div class="viewport__state">
        <div class="viewport__badge">${icon("plug")} Desktop not attached</div>
        <h2 class="viewport__title">${ready ? "Gateway not implemented" : `Computer ${esc(status)}`}</h2>
        <p class="viewport__text">${esc(d.reason ?? "No desktop session is available for this computer.")}</p>
        ${Array.isArray(d.required) && d.required.length ? `
          <ul class="viewport__reqs">
            ${d.required.map(item => `<li>${icon("check")}<span>${esc(item)}</span></li>`).join("")}
          </ul>` : ""}
      </div>`;

  return `<div class="workspace">
    <div class="workspace__main">
      <div class="viewport__chrome">
        <span class="status status--${esc(status)}"><span class="status__dot"></span>${esc(status)}</span>
        <span class="pill">${esc(shortId(computer.id))}</span>
        <span class="spacer"></span>
        ${ready
          ? `<button class="btn btn--sm" disabled>${icon("plug")} ${d.available ? "Attach" : "Attach unavailable"}</button>`
          : `<button class="btn btn--sm" data-op="start" data-id="${esc(computer.id)}">${icon("play")} Start</button>`}
        <button class="btn btn--sm btn--ghost" data-action="refresh-desktop" ${!ready ? "disabled" : ""}>
          ${icon("refresh")} Retry
        </button>
      </div>
      <div class="viewport">${viewport}</div>
    </div>

    <aside class="side" aria-label="Computer details">
      <div class="side__section">
        <div class="side__head"><span class="side__title">Computer</span></div>
        <div class="kv">
          <div class="kv__row"><span class="kv__k">ID</span><span class="kv__v">${esc(shortId(computer.id))}</span></div>
          <div class="kv__row"><span class="kv__k">Status</span><span class="kv__v">${esc(status)}</span></div>
          <div class="kv__row"><span class="kv__k">Image</span><span class="kv__v">${esc(computer.image)}</span></div>
          <div class="kv__row"><span class="kv__k">vCPU</span><span class="kv__v">${esc(computer.cpu)}</span></div>
          <div class="kv__row"><span class="kv__k">Memory</span><span class="kv__v">${esc(gib(computer.memoryMb))}</span></div>
          <div class="kv__row"><span class="kv__k">Disk</span><span class="kv__v">${esc(computer.diskGb)} GiB</span></div>
          <div class="kv__row"><span class="kv__k">Desktop</span><span class="kv__v">${computer.desktopEnabled ? "yes" : "no"}</span></div>
          <div class="kv__row"><span class="kv__k">Created</span><span class="kv__v">${esc(relativeTime(computer.createdAt))}</span></div>
        </div>
      </div>

      <div class="side__section">
        <div class="side__head"><span class="side__title">Agents</span></div>
        <div class="notice">
          ${icon("agents")}
          <span>No MCP agents are connected. Agent presence comes from the guest runtime, which has not been provisioned for this computer.</span>
        </div>
      </div>

      <div class="side__section">
        <div class="side__head"><span class="side__title">Connection</span></div>
        <div class="kv">
          <div class="kv__row"><span class="kv__k">Transport</span><span class="kv__v">${esc(d.gateway === "not_implemented" ? "none" : d.gateway ?? "none")}</span></div>
          <div class="kv__row"><span class="kv__k">Viewers</span><span class="kv__v">${d.available ? "—" : "0"}</span></div>
          <div class="kv__row"><span class="kv__k">Session</span><span class="kv__v">${d.available ? "attached" : "detached"}</span></div>
        </div>
      </div>

      ${computer.error ? `
        <div class="side__section">
          <div class="side__head"><span class="side__title">Last error</span></div>
          <div class="notice notice--error">${icon("alert")}<span>${esc(computer.error)}</span></div>
        </div>` : ""}

      <div class="side__section" style="margin-top:auto">
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn btn--sm" data-op="stop" data-id="${esc(computer.id)}" ${status !== "running" ? "disabled" : ""}>${icon("stop")} Stop</button>
          <button class="btn btn--sm" data-op="restart" data-id="${esc(computer.id)}" ${status !== "running" ? "disabled" : ""}>${icon("restart")} Restart</button>
          <button class="btn btn--sm btn--danger" data-op="delete" data-id="${esc(computer.id)}" ${status === "running" ? "disabled" : ""}>${icon("trash")} Destroy</button>
        </div>
      </div>
    </aside>
  </div>`;
}

/* ── Agents ───────────────────────────────────────────── */

export function agentsView({ computers, agents }) {
  const running = (computers ?? []).filter(c => c.status === "running");

  return `<div class="grid-2">
    <section class="panel">
      <div class="panel__head"><span class="panel__title">MCP agents</span></div>
      <div class="panel__body">
        <div class="notice">
          ${icon("agents")}
          <span>The guest MCP runtime is not installed on any computer yet. Agents appear here only when a real guest session registers with the bus — nothing is simulated.</span>
        </div>
        <div class="notice" style="margin-top:10px">
          ${icon("info")}
          <span>To connect an agent, provision the SYNTRUM runtime inside the guest and register it with the UDS bus using a session-scoped token.</span>
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="panel__head"><span class="panel__title">Eligible hosts</span></div>
      <div class="panel__body">
        ${running.length === 0
          ? `<p class="field__hint">No running computers. Start one to host an agent session.</p>`
          : `<div class="kv">${running.map(c =>
              `<div class="kv__row">
                 <span class="kv__k mono">${esc(shortId(c.id))}</span>
                 <span class="kv__v">${c.desktopEnabled ? "desktop" : "headless"}</span>
               </div>`).join("")}</div>`}
      </div>
    </section>
  </div>`;
}

/* ── Diagnostics ──────────────────────────────────────── */

export function settingsView({ computers, workers, health, error }) {
  const w = workers ?? [];
  return `<div class="grid-2">
    <section class="panel">
      <div class="panel__head"><span class="panel__title">Control plane</span></div>
      <div class="panel__body">
        <div class="kv">
          <div class="kv__row"><span class="kv__k">Reachability</span>
            <span class="kv__v" style="color:${health === "healthy" ? "var(--ok)" : "var(--danger)"}">
              ${esc(health ?? "unknown")}</span></div>
          <div class="kv__row"><span class="kv__k">Browser session</span><span class="kv__v">authenticated</span></div>
          <div class="kv__row"><span class="kv__k">Computers</span><span class="kv__v">${(computers ?? []).length}</span></div>
          <div class="kv__row"><span class="kv__k">Workers</span><span class="kv__v">${w.length}</span></div>
        </div>
        ${error ? `<div class="notice notice--error" style="margin-top:12px">${icon("alert")}<span>${esc(error)}</span></div>` : ""}
      </div>
    </section>

    <section class="panel">
      <div class="panel__head"><span class="panel__title">Workers</span></div>
      <div class="panel__body">
        ${w.length === 0
          ? `<p class="field__hint">No worker is registered. Provisioning requires a reachable Incus worker.</p>`
          : `<div class="kv">
              ${w.map(x => `
                <div class="kv__row"><span class="kv__k">${esc(x.host)}</span><span class="kv__v">${esc(x.status)}</span></div>
                <div class="kv__row"><span class="kv__k">architecture</span><span class="kv__v">${esc(x.architecture)}</span></div>
                <div class="kv__row"><span class="kv__k">incus</span><span class="kv__v">${esc(x.incusVersion)}</span></div>`).join("")}
            </div>`}
      </div>
    </section>

    <section class="panel">
      <div class="panel__head"><span class="panel__title">Desktop gateway</span></div>
      <div class="panel__body">
        <div class="notice notice--warn">
          ${icon("alert")}
          <span>Not implemented. The workspace viewport reports the computer's real lifecycle state and refuses to connect rather than displaying a simulated desktop.</span>
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="panel__head"><span class="panel__title">Security posture</span></div>
      <div class="panel__body">
        <div class="kv">
          <div class="kv__row"><span class="kv__k">Operator token</span><span class="kv__v">server-side only</span></div>
          <div class="kv__row"><span class="kv__k">Browser cookie</span><span class="kv__v">HttpOnly · SameSite=Strict</span></div>
          <div class="kv__row"><span class="kv__k">Mutation guard</span><span class="kv__v">CSRF header + origin</span></div>
          <div class="kv__row"><span class="kv__k">Worker SSH</span><span class="kv__v">never exposed</span></div>
          <div class="kv__row"><span class="kv__k">Guest exec</span><span class="kv__v">not proxied</span></div>
        </div>
      </div>
    </section>
  </div>`;
}

/* ── shared states ────────────────────────────────────── */

export function loadingState(label = "Loading") {
  return `<div class="empty"><div class="empty__inner">
    <div style="display:flex;align-items:center;justify-content:center;gap:8px;color:var(--text-dim);font-size:12.5px">
      <span class="spinner"></span> ${esc(label)}
    </div>
  </div></div>`;
}

export function errorState(message) {
  return `<section class="panel"><div class="empty"><div class="empty__inner">
    <div class="empty__icon" style="color:var(--danger);border-color:color-mix(in srgb,var(--danger) 30%,var(--line-strong))">
      ${icon("alert")}
    </div>
    <h3 class="empty__title">Could not load</h3>
    <p class="empty__body">${esc(message)}</p>
    <div class="empty__actions">
      <button class="btn" data-action="refresh">${icon("refresh")} Retry</button>
    </div>
  </div></div></section>`;
}

function emptyState(glyph, title, body, actions = "") {
  return `<div class="empty"><div class="empty__inner">
    <div class="empty__icon">${icon(glyph)}</div>
    <h3 class="empty__title">${esc(title)}</h3>
    <p class="empty__body">${esc(body)}</p>
    <div class="empty__actions">${actions}</div>
  </div></div>`;
}

/* ── dialogs ──────────────────────────────────────────── */

export function createDialog() {
  return `<dialog class="sheet" id="create-dialog">
    <form method="dialog" id="create-form">
      <div class="sheet__head">
        <span class="sheet__title">New cloud computer</span>
        <span style="flex:1"></span>
        <button class="btn btn--ghost btn--icon" value="cancel" aria-label="Close">${icon("close")}</button>
      </div>
      <div class="sheet__body">
        <div class="field">
          <span class="field__label">Size</span>
          <div class="choice" id="size-choice">
            <button type="button" class="choice__opt" data-size="small" aria-pressed="false">
              <span class="choice__name">Small</span><span class="choice__spec">1 vCPU · 1 GiB · 5 GiB</span>
            </button>
            <button type="button" class="choice__opt" data-size="medium" aria-pressed="true">
              <span class="choice__name">Medium</span><span class="choice__spec">2 vCPU · 4 GiB · 40 GiB</span>
            </button>
          </div>
        </div>
        <div class="sheet__grid">
          <label class="field">
            <span class="field__label">vCPU</span>
            <input class="input" id="in-cpu" type="number" min="1" max="64" value="2" required />
          </label>
          <label class="field">
            <span class="field__label">Memory (MiB)</span>
            <input class="input" id="in-mem" type="number" min="512" max="262144" value="4096" required />
          </label>
          <label class="field">
            <span class="field__label">Disk (GiB)</span>
            <input class="input" id="in-disk" type="number" min="5" max="2048" value="40" required />
          </label>
          <label class="field">
            <span class="field__label">Desktop</span>
            <select class="input" id="in-desktop">
              <option value="true" selected>XFCE + noVNC</option>
              <option value="false">Headless</option>
            </select>
          </label>
        </div>
        <div class="notice">${icon("info")}<span>Provisioning runs on the configured Incus worker and can take minutes while the image and desktop packages install. The computer appears immediately with its real status.</span></div>
      </div>
      <div class="sheet__foot">
        <button class="btn" value="cancel">Cancel</button>
        <button class="btn btn--primary" id="create-submit" value="default">Create computer</button>
      </div>
    </form>
  </dialog>`;
}

export function confirmDialog() {
  return `<dialog class="sheet" id="confirm-dialog">
    <form method="dialog">
      <div class="sheet__head">
        <span class="sheet__title">Destroy computer</span>
      </div>
      <div class="sheet__body">
        <p class="field__hint">This deletes the container and its persistent workspace volume on the worker. It cannot be undone.</p>
      </div>
      <div class="sheet__foot">
        <button class="btn" value="cancel">Cancel</button>
        <button class="btn btn--danger" id="confirm-destroy" value="default">Destroy</button>
      </div>
    </form>
  </dialog>`;
}

export function gate({ loading, error }) {
  return `
    <div class="gate__brand">
      <span class="gate__mark">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="M6 17.2c1.2 1.05 2.8 1.6 4.5 1.6 2.4 0 4-1.05 4-2.6 0-1.35-.9-2.1-3.15-2.6l-1.35-.3c-1.1-.25-1.5-.6-1.5-1.2 0-.75.75-1.25 1.95-1.25 1.2 0 2.25.35 3.15 1.05l1.1-1.95C13.4 9.3 11.9 8.85 10.4 8.85c-2.3 0-3.95 1.05-3.95 2.6 0 1.35.9 2.15 3.1 2.6l1.35.3c1.1.25 1.55.6 1.55 1.2 0 .75-.75 1.25-2 1.25-1.3 0-2.4-.45-3.4-1.25z" fill="currentColor"/></svg>
      </span>
      <span class="gate__name">SYNTRUM</span>
    </div>
    <h1 class="gate__title">Connect to your runtime</h1>
    <p class="gate__sub">Enter the operator token for this SYNTRUM instance. It stays on the server; your browser receives a short-lived session.</p>
    <form class="gate__form" id="gate-form">
      <label class="field">
        <span class="field__label">Operator token</span>
        <input class="input input--mono" id="gate-token" type="password" autocomplete="current-password"
          placeholder="paste operator token" spellcheck="false" required autofocus />
      </label>
      <div class="gate__error" id="gate-error" role="alert" ${error ? "" : "hidden"}>
        ${icon("alert")}<span>${esc(error ?? "")}</span>
      </div>
      <button class="btn btn--primary" type="submit" id="gate-submit" ${loading ? "disabled" : ""}>
        ${loading ? '<span class="spinner"></span> Verifying' : "Continue"}
      </button>
    </form>
    <p class="gate__foot">The credential is held in this server's memory only.<br />It is never written to the browser or to disk.</p>`;
}
