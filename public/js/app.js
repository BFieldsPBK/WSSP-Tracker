/* WSSP Tracker — frontend.
 * Hash-routed single-page app: #/ (projects), #/new, #/project/<id>.
 */
"use strict";

const API_VERSION = 13;

/* ── API helpers ─────────────────────────────────────────────── */
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    let errors = [`Request failed (${res.status})`];
    try { errors = (await res.json()).errors || errors; } catch (e) { /* keep default */ }
    throw Object.assign(new Error(errors.join("; ")), { errors });
  }
  return res.json();
}

/* Show the "restart the server" banner when the running server's API version
 * doesn't match the one this page was built against. Checked at load, every
 * few minutes, and whenever the tab regains focus — so a page left open
 * through a `git pull` still finds out. The banner clears itself once the
 * server has been restarted onto the matching version. */
async function checkVersion() {
  try {
    const meta = await api("GET", "/api/meta");
    document.getElementById("version-banner")
      .classList.toggle("hidden", meta.apiVersion === API_VERSION);
  } catch (e) { /* server unreachable; fetches elsewhere will surface it */ }
}

/* ── Protocol helpers ────────────────────────────────────────── */
/* ── Session ─────────────────────────────────────────────────── */
let ME = null;
async function loadMe(force) {
  if (!ME || force) ME = await api("GET", "/api/me");
  updateUserChip();
  return ME;
}
function isStaffUser() { return ME && ME.authenticated && ME.kind === "staff"; }

function updateUserChip() {
  const el = document.getElementById("app-user");
  if (!el) return;
  const guest = ME && ME.authenticated && ME.kind === "guest";
  // Guests get no "Projects" page — the nav link disappears for them.
  const navProjects = document.getElementById("nav-projects");
  if (navProjects) navProjects.style.display = guest ? "none" : "";
  if (!ME || !ME.authenticated) { el.innerHTML = ""; return; }
  const label = ME.kind === "staff"
    ? `${esc(ME.name || ME.email || "Staff")}<span class="chip-role">PBK Staff</span>`
    : `${esc(ME.name && ME.name !== ME.email ? ME.name : ME.email || "Guest")}<span class="chip-role">Guest</span>`;
  // A consultant invited to several projects switches between them here —
  // a dropdown of only their own invitations, never a project list page.
  const switcher = guest && (ME.projects || []).length > 1 ? `
    <select id="guest-switcher" class="chip-switcher" aria-label="Your invited projects">
      ${ME.projects.map(p => `<option value="${p.id}"
        ${location.hash === "#/project/" + p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
    </select>` : "";
  el.innerHTML = `${switcher}<span class="chip-name">${label}</span>
    <button type="button" id="sign-out" class="chip-signout">Sign out</button>`;
  const sw = document.getElementById("guest-switcher");
  if (sw) sw.addEventListener("change", () => { location.hash = "#/project/" + sw.value; });
  document.getElementById("sign-out").addEventListener("click", async () => {
    await api("POST", "/api/logout");
    ME = null;
    location.hash = "#/login";
    route();
  });
}

let PROTOCOLS = null; // id -> protocol
async function loadProtocols() {
  if (!PROTOCOLS) {
    const list = await api("GET", "/api/protocols");
    PROTOCOLS = {};
    for (const p of list) PROTOCOLS[p.id] = p;
  }
  return PROTOCOLS;
}

let REFERENCE = null; // { excerpts: {protocolId: {creditId: text}}, interpretations: [...] }
async function loadReference() {
  if (!REFERENCE) REFERENCE = await api("GET", "/api/reference");
  return REFERENCE;
}

/* Requirement excerpt for a credit, falling back to its parent credit
 * (sub-credits like E1.0.1 are documented under E1.0's section). */
function excerptFor(protocolId, creditId) {
  const ex = (REFERENCE?.excerpts || {})[protocolId] || {};
  if (ex[creditId]) return ex[creditId];
  const parent = creditId.replace(/\.\d+$/, "");
  return parent !== creditId ? ex[parent] : undefined;
}

/* OSPI interpretations attached to a credit (or its parent) for an edition. */
function interpretationsFor(protocolId, creditId) {
  const parent = creditId.replace(/\.\d+$/, "");
  return (REFERENCE?.interpretations || []).filter(i => {
    const refs = (i.creditRefs || {})[protocolId] || [];
    return refs.includes(creditId) || (parent !== creditId && refs.includes(parent));
  });
}

/* parsePoints(), threshold(), eachCredit(), entryPoints(), computeScore(),
 * and achievablePoints() are defined in /js/scoring.js (loaded before this
 * file) — pure, DOM-free scoring logic kept separate so it can be unit-tested
 * under Node. They're available here as globals. */

const PROJECT_TYPE_NAMES = {
  new: "New School (Facility)",
  newBuilding: "New Building on Existing Facility",
  modernization: "Modernization"
};

/* D_PHASES and normalizeDPhase come from /js/d-phases.js (loaded before this
 * file) — the same file server.js require()s, so the list lives in one place. */

/* WSSP 2023 handbook E1.2 (Clean Buildings Performance Standard): Adjusted
 * New Construction / Alteration EUI targets (kBtu/sf/yr) by climate zone,
 * school level (ES/MS share a column), and average weekly operating hours.
 * Source: WSSP 2023 Tables 1–4, pages 52–54. */
const EUI_TARGETS = {
  nc:  { "50": { "4C": { esms: 30.9, hs: 30.2 }, "5B": { esms: 38.3, hs: 37.5 } },
         "167": { "4C": { esms: 37.7, hs: 37.0 }, "5B": { esms: 46.8, hs: 45.8 } } },
  alt: { "50": { "4C": { esms: 37.5, hs: 36.7 }, "5B": { esms: 38.3, hs: 37.5 } },
         "167": { "4C": { esms: 45.8, hs: 44.9 }, "5B": { esms: 46.8, hs: 45.8 } } }
};
const SCHOOL_LEVEL_NAMES = { es: "Elementary", ms: "Middle School", hs: "High School", other: "Other" };
function wsspEuiTarget(project) {
  const kind = project.projectType === "modernization" ? "alt" : "nc";
  const hours = project.opHours || "50";
  const level = project.schoolLevel === "hs" ? "hs"
    : (project.schoolLevel === "es" || project.schoolLevel === "ms") ? "esms" : null;
  if (!level || !project.climateZone) return null;
  return EUI_TARGETS[kind]?.[hours]?.[project.climateZone]?.[level] ?? null;
}

function dPhaseInfo(v) {
  return D_PHASES.find(p => p.value === normalizeDPhase(v));
}
function dPhaseOptions(current) {
  const cur = normalizeDPhase(current);
  const known = D_PHASES.some(p => p.value === cur);
  return `<option value="">Not set</option>` +
    D_PHASES.map(p => `<option value="${p.value}" ${p.value === cur ? "selected" : ""}>${esc(p.label)}</option>`).join("") +
    (cur && !known ? `<option value="${esc(cur)}" selected>${esc(current)} (legacy)</option>` : "");
}

/* The four scorecard statuses, in display order. "maybeYes" and "maybeNo"
 * both mean undecided; maybeYes counts toward potential points. */
const STATUSES = ["yes", "maybeYes", "maybeNo", "no"];
const STATUS_LABELS = { yes: "Yes", maybeYes: "Maybe Yes", maybeNo: "Maybe No", no: "No" };
const STATUS_COLORS = { yes: "#31493c", maybeYes: "#748b58", maybeNo: "#d9bd5f", no: "#9aa4ad", rest: "#eef2f5" };

/* ── Rendering helpers ───────────────────────────────────────── */
const view = document.getElementById("view");
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
const CLIP_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.4 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`;

/* Per-project UI state, keyed "projectId|item" so it survives re-renders
 * without leaking between projects. Categories start collapsed. */
const openDocPanels = new Set();
const openPurposes = new Set();
const expandedCats = new Set();
const pkey = (projectId, item) => `${projectId}|${item}`;
/* Sharing panel open state and the most recently created invite link per project. */
const sharingOpen = new Set();
const lastInviteLinks = {};

/* Unactivated setup links expire 14 days after issue (see INVITE_LINK_TTL_MS
 * in server.js) — tell staff whether a pending link is still live. */
const INVITE_LINK_TTL_MS = 14 * 24 * 3600e3;
function inviteLinkStatus(inv) {
  const expires = Date.parse(inv.regeneratedAt || inv.createdAt || 0) + INVITE_LINK_TTL_MS;
  return Date.now() > expires
    ? `<b>link expired</b> — click the name to reissue`
    : `awaiting account setup · link valid through ${new Date(expires).toLocaleDateString()}`;
}

/* ── Routes ──────────────────────────────────────────────────── */
async function route() {
  const hash = location.hash || "#/";
  try {
    // Invite links work with no prior session — the link is the credential.
    // Tokens travel in the query string (?invite=...) because URL fragments
    // are dropped by redirect flows (port-forwarding interstitials, email
    // link scanners); the legacy #/invite/ form still works.
    const qtoken = new URLSearchParams(location.search).get("invite");
    if (qtoken) {
      history.replaceState(null, "", location.pathname);
      return renderInviteRedeem(qtoken);
    }
    let m = hash.match(/^#\/invite\/([A-Za-z0-9_-]+)$/);
    if (m) return renderInviteRedeem(m[1]);
    await loadMe();
    if (!ME.authenticated) return renderLogin();
    if (hash === "#/login") { location.hash = "#/"; return; }
    if (hash === "#/" || hash === "#") {
      // Guests never see a project list — they land on their project.
      if (!isStaffUser()) {
        const granted = ME.projects || [];
        if (granted.length) { location.hash = `#/project/${granted[0].id}`; return; }
        view.innerHTML = `
          <div class="empty-state card">
            <h2>No active invitations</h2>
            <p>Your invite may have been revoked or replaced — contact your PBK project contact.</p>
          </div>`;
        return;
      }
      return renderProjectList();
    }
    if (hash === "#/new") return renderProjectForm();
    if (hash === "#/reference") return renderReference();
    m = hash.match(/^#\/project\/([a-z0-9]+)\/dashboard$/);
    if (m) return renderDashboard(m[1]);
    m = hash.match(/^#\/project\/([a-z0-9]+)\/report$/);
    if (m) return isStaffUser() ? renderReport(m[1]) : renderProject(m[1]);
    m = hash.match(/^#\/project\/([a-z0-9]+)\/edit$/);
    if (m) return isStaffUser() ? renderProjectForm(m[1]) : renderProject(m[1]);
    m = hash.match(/^#\/project\/([a-z0-9]+)$/);
    if (m) return renderProject(m[1]);
    view.innerHTML = `<div class="empty-state card"><h2>Page not found</h2><p><a href="#/">Back to projects</a></p></div>`;
  } catch (e) {
    view.innerHTML = `<div class="empty-state card"><h2>Something went wrong</h2><p>${esc(e.message)}</p><p><a href="#/">Back to projects</a></p></div>`;
  }
}

/* ── Login & invite redemption ───────────────────────────────── */
let loginPrefill = { name: "", email: "", guestEmail: "" }; // survive error re-renders
function renderLogin(errorMsg) {
  view.innerHTML = `
    <div class="login-wrap">
      <div class="card login-card">
        <img src="/assets/logo.png" alt="PBK" class="login-logo">
        <h1>WSSP Tracker</h1>
        <p class="lede">Washington Sustainable Schools Protocol compliance tracking.</p>
        ${errorMsg ? `<div class="form-errors">${esc(errorMsg)}</div>` : ""}
        ${ME && ME.microsoftSso ? `
          <a class="btn btn-primary login-ms" href="/.auth/login/aad?post_login_redirect_uri=/">
            Sign in with Microsoft
          </a>
          <div class="login-divider">PBK staff only</div>` : `
          <form id="login-form">
            <div class="form-field">
              <label for="l-name">Your name <span class="req">*</span></label>
              <input id="l-name" type="text" autocomplete="name" placeholder="e.g. Ben Fields" value="${esc(loginPrefill.name)}">
            </div>
            <div class="form-field">
              <label for="l-email">Email</label>
              <input id="l-email" type="email" autocomplete="email" placeholder="you@pbk.com" value="${esc(loginPrefill.email)}">
            </div>
            <div class="form-field">
              <label for="l-code">Staff access code <span class="req">*</span></label>
              <input id="l-code" type="password" autocomplete="off">
              <span class="hint">Shown in the server console at startup. Microsoft SSO replaces this
              when the tool is deployed to Azure App Service.</span>
            </div>
            <button class="btn btn-primary" type="submit" style="width:100%; justify-content:center;">Sign In</button>
          </form>`}
        <div class="login-divider" style="margin:20px 0 14px;">Consultants · Clients · Contractors</div>
        <form id="guest-login">
          <div class="form-field">
            <label for="g-email">Email</label>
            <input id="g-email" type="email" autocomplete="email" placeholder="you@yourfirm.com" value="${esc(loginPrefill.guestEmail)}">
          </div>
          <div class="form-field">
            <label for="g-pass">Password</label>
            <input id="g-pass" type="password" autocomplete="current-password">
            <span class="hint">First time? Use the invite link from your PBK contact to create your
            password. Forgot it? Ask them to reissue your link.</span>
          </div>
          <button class="btn btn-secondary" type="submit" style="width:100%; justify-content:center;">Collaborator Sign In</button>
        </form>
      </div>
    </div>`;
  const form = document.getElementById("login-form");
  if (form) form.addEventListener("submit", async ev => {
    ev.preventDefault();
    loginPrefill.name = document.getElementById("l-name").value;
    loginPrefill.email = document.getElementById("l-email").value;
    try {
      await api("POST", "/api/login", {
        name: document.getElementById("l-name").value,
        email: document.getElementById("l-email").value,
        code: document.getElementById("l-code").value
      });
      ME = null;
      location.hash = "#/";
      route();
    } catch (e) {
      renderLogin(e.message);
    }
  });
  const guestForm = document.getElementById("guest-login");
  if (guestForm) guestForm.addEventListener("submit", async ev => {
    ev.preventDefault();
    loginPrefill.guestEmail = document.getElementById("g-email").value;
    try {
      const result = await api("POST", "/api/login/guest", {
        email: document.getElementById("g-email").value,
        password: document.getElementById("g-pass").value
      });
      ME = null;
      await loadMe(true);
      location.hash = result.projectId ? `#/project/${result.projectId}` : "#/";
      route();
    } catch (e) {
      renderLogin(e.message);
    }
  });
}

async function renderInviteRedeem(token) {
  view.innerHTML = `<div class="login-wrap"><div class="card login-card"><h1>Opening your invite…</h1></div></div>`;
  try {
    const result = await api("POST", "/api/invites/redeem", { token });
    if (result.staff) { location.hash = `#/project/${result.projectId}`; return; }
    if (result.requiresLogin) {
      // Account already exists — the link is spent; sign in normally.
      renderGuestLoginPrompt(result.email, result.projectName);
      return;
    }
    renderActivateForm(token, result.email, result.projectName);
  } catch (e) {
    view.innerHTML = `
      <div class="login-wrap">
        <div class="card login-card">
          <img src="/assets/logo.png" alt="PBK" class="login-logo">
          <h1>Invite Problem</h1>
          <div class="form-errors">${esc(e.message)}</div>
          <p class="lede">If you believe this link should work, contact your PBK project contact.</p>
        </div>
      </div>`;
  }
}

function renderActivateForm(token, email, projectName, errorMsg) {
  view.innerHTML = `
    <div class="login-wrap">
      <div class="card login-card">
        <img src="/assets/logo.png" alt="PBK" class="login-logo">
        <h1>Welcome</h1>
        <p class="lede">You've been invited to collaborate on<br><b>${esc(projectName)}</b>.<br>
        Create a password to finish setting up your access as <b>${esc(email)}</b>.</p>
        ${errorMsg ? `<div class="form-errors">${esc(errorMsg)}</div>` : ""}
        <form id="activate-form">
          <div class="form-field">
            <label for="a-name">Your name</label>
            <input id="a-name" type="text" autocomplete="name" placeholder="e.g. Jordan Rivera">
          </div>
          <div class="form-field">
            <label for="a-pass">Password <span class="req">*</span></label>
            <input id="a-pass" type="password" autocomplete="new-password" minlength="8">
            <span class="hint">At least 8 characters.</span>
          </div>
          <div class="form-field">
            <label for="a-pass2">Confirm password <span class="req">*</span></label>
            <input id="a-pass2" type="password" autocomplete="new-password">
          </div>
          <button class="btn btn-primary" type="submit" style="width:100%; justify-content:center;">Create Account &amp; Open Project</button>
        </form>
        <div class="login-guest-note">Afterwards, sign in any time — on any device — with your email and password.</div>
      </div>
    </div>`;
  document.getElementById("activate-form").addEventListener("submit", async ev => {
    ev.preventDefault();
    const pass = document.getElementById("a-pass").value;
    if (pass !== document.getElementById("a-pass2").value) {
      return renderActivateForm(token, email, projectName, "Passwords don't match");
    }
    try {
      const result = await api("POST", "/api/invites/activate", {
        token, password: pass, name: document.getElementById("a-name").value
      });
      ME = null;
      await loadMe(true);
      location.hash = `#/project/${result.projectId}`;
    } catch (e) {
      renderActivateForm(token, email, projectName, e.message);
    }
  });
}

function renderGuestLoginPrompt(email, projectName, errorMsg) {
  view.innerHTML = `
    <div class="login-wrap">
      <div class="card login-card">
        <img src="/assets/logo.png" alt="PBK" class="login-logo">
        <h1>Welcome Back</h1>
        <p class="lede">Your account for <b>${esc(email)}</b> is already set up.<br>Sign in to open <b>${esc(projectName)}</b>.</p>
        ${errorMsg ? `<div class="form-errors">${esc(errorMsg)}</div>` : ""}
        <form id="guest-login-form">
          <div class="form-field">
            <label for="gl-pass">Password</label>
            <input id="gl-pass" type="password" autocomplete="current-password">
            <span class="hint">Forgot it? Ask your PBK project contact to reissue your invite link — opening the new link lets you set a new password.</span>
          </div>
          <button class="btn btn-primary" type="submit" style="width:100%; justify-content:center;">Sign In</button>
        </form>
      </div>
    </div>`;
  document.getElementById("guest-login-form").addEventListener("submit", async ev => {
    ev.preventDefault();
    try {
      const result = await api("POST", "/api/login/guest", {
        email, password: document.getElementById("gl-pass").value
      });
      ME = null;
      await loadMe(true);
      location.hash = result.projectId ? `#/project/${result.projectId}` : "#/";
      route();
    } catch (e) {
      renderGuestLoginPrompt(email, projectName, e.message);
    }
  });
}

/* ── Project list ────────────────────────────────────────────── */
/* List controls survive re-renders within a session. */
let listSort = "number";
let listQuery = "";

const LIST_SORTS = {
  number: {
    label: "Project number",
    fn: (a, b) => {
      if (!a.number && !b.number) return a.name.localeCompare(b.name);
      if (!a.number) return 1;              // projects without a number sort last
      if (!b.number) return -1;
      return a.number.localeCompare(b.number, undefined, { numeric: true });
    }
  },
  name: { label: "Project name", fn: (a, b) => a.name.localeCompare(b.name) },
  recent: { label: "Recently updated", fn: (a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "") }
};

async function renderProjectList() {
  const [projects, protocols] = await Promise.all([api("GET", "/api/projects"), loadProtocols()]);
  const staff = isStaffUser();

  const card = p => `
      <a class="card project-card" href="#/project/${p.id}">
        <h3>${esc(p.name)}</h3>
        <div class="meta">${p.number ? "#" + esc(p.number) + " · " : ""}${esc(p.district || "—")}${p.city ? " · " + esc(p.city) : ""}</div>
        ${p.contactName ? `<div class="meta card-contact">Contact: ${esc(p.contactName)}</div>` : ""}
        <div class="badges">
          <span class="badge edition">${esc(protocols[p.protocolId]?.name || p.protocolId)}</span>
          <span class="badge">${esc(PROJECT_TYPE_NAMES[p.projectType] || p.projectType)}</span>
          <span class="badge">Class ${esc(p.districtClass)}</span>
          ${p.dPhase ? `<span class="badge">${esc(dPhaseInfo(p.dPhase)?.code || p.dPhase)}</span>` : ""}
        </div>
      </a>`;

  const visible = () => {
    const q = listQuery.trim().toLowerCase();
    const filtered = !q ? projects.slice() : projects.filter(p =>
      [p.name, p.number, p.district, p.city, p.contactName]
        .some(v => v && String(v).toLowerCase().includes(q)));
    return filtered.sort(LIST_SORTS[listSort].fn);
  };

  const paint = () => {
    const wrap = document.getElementById("project-grid-wrap");
    if (!wrap) return;
    const list = visible();
    wrap.innerHTML = list.length
      ? `<div class="project-grid">${list.map(card).join("")}</div>`
      : `<div class="empty-state card">
           <h2>${listQuery ? "No matches" : staff ? "No projects yet" : "No active invitations"}</h2>
           ${listQuery ? `<p>No projects match “${esc(listQuery)}”.</p>`
             : staff ? `<p>Create your first project to start tracking WSSP credits.</p>
                        <p><a class="btn btn-primary" href="#/new">+ New Project</a></p>`
                     : `<p>Your invite may have been revoked or replaced — contact your PBK project contact.</p>`}
         </div>`;
  };
  view.innerHTML = `
    <div class="page-head">
      <div>
        <p class="kicker">Projects</p>
        <h1>${staff ? "WSSP Projects" : "Your Projects"}</h1>
        <p class="lede">${staff
          ? "Track Washington Sustainable Schools Protocol compliance across PBK projects."
          : "Projects you've been invited to collaborate on."}</p>
      </div>
      ${staff ? `<a class="btn btn-primary" href="#/new">+ New Project</a>` : ""}
    </div>
    <div class="list-controls">
      <input type="search" id="list-search" placeholder="Search by name, number, district, or contact…"
        value="${esc(listQuery)}" aria-label="Search projects">
      <label class="list-sort">Sort by
        <select id="list-sort" aria-label="Sort projects">
          ${Object.entries(LIST_SORTS).map(([k, s]) =>
            `<option value="${k}" ${k === listSort ? "selected" : ""}>${s.label}</option>`).join("")}
        </select>
      </label>
    </div>
    <div id="project-grid-wrap"></div>
  `;
  paint();
  document.getElementById("list-search").addEventListener("input", ev => {
    listQuery = ev.target.value;
    paint();
  });
  document.getElementById("list-sort").addEventListener("change", ev => {
    listSort = ev.target.value;
    paint();
  });
}

/* ── Project form (create & edit) ────────────────────────────── */
async function renderProjectForm(id) {
  const protocols = await loadProtocols();
  const editing = !!id;
  const project = editing ? await api("GET", `/api/projects/${id}`) : {
    protocolId: "wssp-2023", projectType: "new", districtClass: "I", state: "WA"
  };
  const editionLocked = editing && Object.keys(project.credits || {}).length > 0;

  const protoOptions = Object.values(protocols)
    .sort((a, b) => b.id.localeCompare(a.id))
    .map(p => `<option value="${p.id}" ${p.id === project.protocolId ? "selected" : ""}>${esc(p.name)} — published ${esc(p.published)}</option>`)
    .join("");

  const field = (name, label, opts = {}) => `
    <div class="form-field">
      <label for="f-${name}">${label}${opts.required ? ' <span class="req">*</span>' : ""}</label>
      <input id="f-${name}" name="${name}" type="text" value="${esc(project[name] || "")}"
        ${opts.placeholder ? `placeholder="${esc(opts.placeholder)}"` : ""}>
      ${opts.hint ? `<span class="hint">${opts.hint}</span>` : ""}
    </div>`;

  view.innerHTML = `
    <div class="breadcrumbs"><a href="#/">Projects</a> / ${editing ? esc(project.name) : "New project"}</div>
    <div class="page-head">
      <div>
        <p class="kicker">${editing ? "Edit project" : "New project"}</p>
        <h1>${editing ? esc(project.name) : "Create a Project"}</h1>
      </div>
    </div>
    <form class="card form-card" id="project-form">
      <div class="form-errors hidden" id="form-errors"></div>

      <fieldset>
        <legend>General Information</legend>
        <div class="form-row">
          ${field("name", "Project name", { required: true, placeholder: "e.g. Evergreen Middle School Replacement" })}
          ${field("number", "Project number", { placeholder: "e.g. 24-1234-00" })}
        </div>
        <div class="form-row">
          ${field("district", "School district", { required: true, placeholder: "e.g. Spokane Public Schools" })}
          <div class="form-field">
            <label for="f-districtClass">District class <span class="req">*</span></label>
            <select id="f-districtClass" name="districtClass">
              <option value="I" ${project.districtClass === "I" ? "selected" : ""}>Class I — 2,000+ FTE students</option>
              <option value="II" ${project.districtClass === "II" ? "selected" : ""}>Class II — fewer than 2,000 FTE</option>
            </select>
            <span class="hint">Sets the minimum points required for WSSP compliance.</span>
          </div>
        </div>
        <div class="form-row">
          ${field("address", "Street address", { placeholder: "e.g. 1234 School Ave" })}
          ${field("city", "City", { placeholder: "e.g. Spokane" })}
        </div>
        <div class="form-row">
          ${field("state", "State")}
          ${field("zip", "ZIP", { placeholder: "e.g. 99201" })}
        </div>
        <div class="form-row">
          ${field("contactName", "Contact name", { placeholder: "District or PBK contact" })}
          ${field("contactPhone", "Contact phone")}
        </div>
      </fieldset>

      <fieldset>
        <legend>WSSP Compliance Basis</legend>
        <div class="form-row">
          <div class="form-field">
            <label for="f-projectType">Project type <span class="req">*</span></label>
            <select id="f-projectType" name="projectType">
              ${Object.entries(PROJECT_TYPE_NAMES).map(([v, n]) =>
                `<option value="${v}" ${project.projectType === v ? "selected" : ""}>${n}</option>`).join("")}
            </select>
            <span class="hint">Additions count as modernizations for minimum-point purposes.</span>
          </div>
          <div class="form-field">
            <label for="f-protocolId">WSSP edition <span class="req">*</span></label>
            <select id="f-protocolId" name="protocolId" ${editionLocked ? "disabled" : ""}>
              ${protoOptions}
            </select>
            <span class="hint">${editionLocked
              ? "Locked — this project already has scorecard entries."
              : "SCAP projects apply the edition in effect at D4 approval. A newer edition than required may always be used — never an older one."}</span>
          </div>
        </div>
        <div class="form-row">
          <div class="form-field">
            <label for="f-dPhase">D phase</label>
            <select id="f-dPhase" name="dPhase">${dPhaseOptions(project.dPhase)}</select>
            <span class="hint">Current SCAP D-Form phase. Also changeable directly on the project page as the project progresses.</span>
          </div>
          <div class="form-field">
            <label for="f-notes">Notes</label>
            <input id="f-notes" name="notes" type="text" value="${esc(project.notes || "")}" placeholder="Optional">
          </div>
        </div>
      </fieldset>

      <fieldset>
        <legend>School &amp; Energy (Dashboard)</legend>
        <div class="form-row">
          <div class="form-field">
            <label for="f-schoolLevel">School level</label>
            <select id="f-schoolLevel" name="schoolLevel">
              <option value="">Not set</option>
              ${Object.entries(SCHOOL_LEVEL_NAMES).map(([v, n]) =>
                `<option value="${v}" ${project.schoolLevel === v ? "selected" : ""}>${n}</option>`).join("")}
            </select>
            <span class="hint">Sets the WSSP EUI target (ES/MS share one target; HS has its own).</span>
          </div>
          <div class="form-field">
            <label for="f-climateZone">Climate zone</label>
            <select id="f-climateZone" name="climateZone">
              <option value="">Not set</option>
              <option value="4C" ${project.climateZone === "4C" ? "selected" : ""}>4C — Western Washington</option>
              <option value="5B" ${project.climateZone === "5B" ? "selected" : ""}>5B — Eastern Washington</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-field">
            <label for="f-opHours">Average weekly operating hours</label>
            <select id="f-opHours" name="opHours">
              <option value="50" ${(project.opHours || "50") === "50" ? "selected" : ""}>50 hours or less</option>
              <option value="167" ${project.opHours === "167" ? "selected" : ""}>51 to 167 hours</option>
            </select>
            <span class="hint">Per the CBPS tables in WSSP 2023 credit E1.2.</span>
          </div>
          ${field("aiaReductionPct", "AIA 2030 target (% reduction)", { placeholder: "80",
            hint: "Percent reduction from baseline EUI for the dashboard's AIA 2030 marker — editable as the 2030 Challenge targets change. Defaults to 80." })}
        </div>
        <div class="form-row">
          ${field("zeroToolBaseline", "Zero Tool Baseline (kBtu/sf/yr)", { placeholder: "e.g. 46",
            hint: "From Architecture 2030's Zero Tool — the baseline the AIA 2030 target reduces from." })}
          ${field("cbpsBaseline", "CBPS Baseline (kBtu/sf/yr)", { placeholder: "e.g. 49",
            hint: "Washington Clean Buildings Performance Standard EUI target (EUIt) for this building." })}
        </div>
        <div class="form-row">
          ${field("projectedEUI", "Projected EUI (kBtu/sf/yr)", { placeholder: "e.g. 30", hint: "Predicted EUI of the proposed design (pEUI)." })}
          <div class="form-field"></div>
        </div>
      </fieldset>

      <div class="form-actions">
        <a class="btn btn-secondary" href="${editing ? "#/project/" + id : "#/"}">Cancel</a>
        <button class="btn btn-primary" type="submit">${editing ? "Save Changes" : "Create Project"}</button>
      </div>
    </form>
  `;

  document.getElementById("project-form").addEventListener("submit", async ev => {
    ev.preventDefault();
    const body = {};
    for (const el of ev.target.querySelectorAll("input[name], select[name]")) {
      if (!el.disabled) body[el.name] = el.value;
    }
    const errBox = document.getElementById("form-errors");
    try {
      const saved = editing
        ? await api("PUT", `/api/projects/${id}`, body)
        : await api("POST", "/api/projects", body);
      location.hash = `#/project/${saved.id}`;
    } catch (e) {
      errBox.classList.remove("hidden");
      errBox.innerHTML = `<ul>${(e.errors || [e.message]).map(x => `<li>${esc(x)}</li>`).join("")}</ul>`;
      errBox.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });
}

/* ── OSPI interpretation library page ────────────────────────── */
function interpCard(i, protocols) {
  const refs = Object.entries(i.creditRefs || {})
    .map(([pid, ids]) => `${protocols[pid]?.name || pid}: ${ids.join(", ")}`).join(" · ");
  return `
    <details class="card interp-card">
      <summary>
        <span class="interp-subject">${esc(i.subject)}</span>
        <span class="interp-meta">${esc(i.issuedUnder)} · ${new Date(i.date + "T12:00:00").toLocaleDateString()}${refs ? " · " + esc(refs) : ""}</span>
      </summary>
      <div class="interp-body">
        <p><b>Background.</b> ${esc(i.background)}</p>
        <p><b>Request.</b> ${esc(i.request)}</p>
        <p><b>Interpretation.</b> ${esc(i.interpretation)}</p>
      </div>
    </details>`;
}

async function renderReference() {
  const [protocols, ref] = await Promise.all([loadProtocols(), loadReference()]);
  const general = ref.interpretations.filter(i => i.general);
  const specific = ref.interpretations.filter(i => !i.general);
  view.innerHTML = `
    <div class="page-head">
      <div>
        <p class="kicker">Reference</p>
        <h1>OSPI Credit Interpretation Library</h1>
        <p class="lede">Official OSPI rulings on WSSP credits. Credit-specific interpretations also appear
        inline on each project's scorecard.</p>
      </div>
    </div>
    <h2 class="section-title">Program-Level Interpretations</h2>
    ${general.map(i => interpCard(i, protocols)).join("")}
    <h2 class="section-title">Credit-Specific Interpretations</h2>
    ${specific.map(i => interpCard(i, protocols)).join("")}
  `;
}

/* ── Project dashboard (gauges) ──────────────────────────────── */
/* Gauge geometry: 270° arc opening at the bottom, from 135° to 405°. */
const GAUGE_START = 135, GAUGE_SWEEP = 270;
function polar(cx, cy, r, deg) {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}
function arcPath(cx, cy, r, a0, a1) {
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
/* A segmented gauge: segments = [{value, color, label?}], domain = total.
 * Draws a full track, then each nonzero segment with a 2° gap, with the
 * segment's value labeled just outside its midpoint. */
function gaugeSvg({ size = 190, stroke = 26, domain, segments, centerTop, centerBottom, marker }) {
  const cx = size / 2, cy = size / 2, r = (size - stroke) / 2 - 14;
  // Clamp the domain to at least 1 so a category whose achievable total is 0
  // (only required, zero-point credits) never divides by zero -> NaN coords.
  const dom = domain > 0 ? domain : 1;
  const toAngle = v => GAUGE_START + GAUGE_SWEEP * Math.max(0, Math.min(1, v / dom));
  let acc = 0;
  const parts = [`<path d="${arcPath(cx, cy, r, GAUGE_START, GAUGE_START + GAUGE_SWEEP)}"
    stroke="${STATUS_COLORS.rest}" stroke-width="${stroke}" fill="none" stroke-linecap="round"/>`];
  const labels = [];
  for (const seg of segments) {
    if (!seg.value || seg.value <= 0) { continue; }
    const a0 = toAngle(acc), a1 = toAngle(acc + seg.value);
    const gap = Math.min(1, (a1 - a0) / 4);
    parts.push(`<path d="${arcPath(cx, cy, r, a0 + gap, Math.max(a0 + gap + .5, a1 - gap))}"
      stroke="${seg.color}" stroke-width="${stroke}" fill="none"/>`);
    const [lx, ly] = polar(cx, cy, r + stroke / 2 + 9, (a0 + a1) / 2);
    labels.push(`<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" class="g-seglabel"
      text-anchor="middle" dominant-baseline="middle">${seg.value}</text>`);
    acc += seg.value;
  }
  let markerSvg = "";
  if (marker && marker.value > 0 && marker.value <= domain) {
    const a = toAngle(marker.value);
    const [mx0, my0] = polar(cx, cy, r - stroke / 2 - 3, a);
    const [mx1, my1] = polar(cx, cy, r + stroke / 2 + 3, a);
    const [tx, ty] = polar(cx, cy, r + stroke / 2 + 14, a);
    markerSvg = `<line x1="${mx0.toFixed(1)}" y1="${my0.toFixed(1)}" x2="${mx1.toFixed(1)}" y2="${my1.toFixed(1)}"
        stroke="#b8241f" stroke-width="2.5" stroke-dasharray="4 3"/>
      <text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" class="g-marklabel" text-anchor="middle"
        dominant-baseline="middle">${esc(marker.label)}</text>`;
  }
  return `<svg viewBox="-14 -10 ${size + 28} ${size + 20}" class="gauge" role="img">
    ${parts.join("")}${labels.join("")}${markerSvg}
    <text x="${cx}" y="${cy - 4}" class="g-center" text-anchor="middle">${esc(centerTop)}</text>
    <text x="${cx}" y="${cy + 16}" class="g-center-sub" text-anchor="middle">${esc(centerBottom)}</text>
  </svg>`;
}
/* EUI gauge: values run baseline (left) down to 0 (right) with reference
 * ticks; the needle marks the projected EUI. */
function euiGaugeSvg({ size = 190, stroke = 20, maxVal, baseline, projected, ticks }) {
  const cx = size / 2, cy = size / 2, r = (size - stroke) / 2 - 16;
  const toAngle = v => GAUGE_START + GAUGE_SWEEP * Math.max(0, Math.min(1, (maxVal - v) / maxVal));
  const parts = [`<path d="${arcPath(cx, cy, r, GAUGE_START, GAUGE_START + GAUGE_SWEEP)}"
    stroke="${STATUS_COLORS.rest}" stroke-width="${stroke}" fill="none" stroke-linecap="round"/>`];
  // green "meets WSSP target" zone from the WSSP tick down to zero
  const wssp = ticks.find(t => t.key === "wssp");
  if (wssp) {
    parts.push(`<path d="${arcPath(cx, cy, r, toAngle(wssp.value), GAUGE_START + GAUGE_SWEEP)}"
      stroke="#c9d8c4" stroke-width="${stroke}" fill="none"/>`);
  }
  const tickSvg = ticks.map(t => {
    const a = toAngle(t.value);
    const [x0, y0] = polar(cx, cy, r - stroke / 2 - 3, a);
    const [x1, y1] = polar(cx, cy, r + stroke / 2 + 3, a);
    const [tx, ty] = polar(cx, cy, r + stroke / 2 + 15, a);
    return `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}"
        stroke="#54606b" stroke-width="2"/>
      <text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" class="g-marklabel" text-anchor="middle"
        dominant-baseline="middle">${esc(t.label)}</text>`;
  }).join("");
  let needle = "";
  if (projected != null) {
    const a = toAngle(projected);
    const [nx, ny] = polar(cx, cy, r + stroke / 2, a);
    const [bx0, by0] = polar(cx, cy, 12, a - 90);
    const [bx1, by1] = polar(cx, cy, 12, a + 90);
    needle = `<polygon points="${nx.toFixed(1)},${ny.toFixed(1)} ${bx0.toFixed(1)},${by0.toFixed(1)} ${bx1.toFixed(1)},${by1.toFixed(1)}"
      fill="#263a46"/><circle cx="${cx}" cy="${cy}" r="7" fill="#263a46"/>`;
  }
  return `<svg viewBox="-34 -12 ${size + 68} ${size + 24}" class="gauge" role="img">
    ${parts.join("")}${tickSvg}${needle}
    <text x="${cx}" y="${cy + 34}" class="g-center" text-anchor="middle">${projected ?? "—"}</text>
    <text x="${cx}" y="${cy + 52}" class="g-center-sub" text-anchor="middle">${projected != null ? "projected EUI" : "awaiting pEUI"}</text>
  </svg>`;
}

async function renderDashboard(id) {
  const [project, protocols] = await Promise.all([api("GET", `/api/projects/${id}`), loadProtocols()]);
  const protocol = protocols[project.protocolId];
  if (!protocol) throw new Error(`Unknown protocol: ${project.protocolId}`);
  const staff = isStaffUser();
  const goal = threshold(protocol, project);
  const score = computeScore(protocol, project);
  const achievable = achievablePoints(protocol, project);
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  const catCard = cat => {
    const c = score.byCategory[cat.id] || {};
    const ach = achievable.byCategory[cat.id];
    const segs = [
      { value: c.yes || 0, color: STATUS_COLORS.yes },
      { value: c.maybeYes || 0, color: STATUS_COLORS.maybeYes },
      { value: c.maybeNoMax || 0, color: STATUS_COLORS.maybeNo },
      { value: c.noMax || 0, color: STATUS_COLORS.no }
    ];
    return `
      <div class="card dash-cat">
        ${gaugeSvg({ size: 180, stroke: 22, domain: ach, segments: segs,
          centerTop: String(c.yes || 0), centerBottom: "Yes pts" })}
        <div class="dash-cat-name">${esc(cat.name)}</div>
        <div class="dash-cat-sub">${ach} points possible${ach !== cat.total ? ` <span title="Alternate pathways count once and handbook combination limits apply — the OSPI scorecard column sums to ${cat.total}.">*</span>` : ""}</div>
      </div>`;
  };

  const zeroTool = Number(project.zeroToolBaseline) || null;
  const cbps = Number(project.cbpsBaseline) || null;
  const projected = Number(project.projectedEUI) || null;
  const wsspTarget = wsspEuiTarget(project);
  const baseline = Math.max(zeroTool || 0, cbps || 0) || null;   // gauge anchor
  // The gauge renders as soon as a baseline sets the targets; the needle
  // joins later, once the team has a predicted EUI.
  const euiReady = !!baseline;
  const aiaPct = project.aiaReductionPct !== "" && project.aiaReductionPct != null
    ? Number(project.aiaReductionPct) : 80;
  const aiaTarget = zeroTool ? +(zeroTool * (1 - aiaPct / 100)).toFixed(1) : null;
  const euiTicks = [];
  if (zeroTool) euiTicks.push({ key: "zt", value: zeroTool, label: `Zero Tool ${zeroTool}` });
  if (cbps && cbps !== zeroTool) euiTicks.push({ key: "cbps", value: cbps, label: `CBPS ${cbps}` });
  if (wsspTarget) euiTicks.push({ key: "wssp", value: wsspTarget, label: `WSSP ${wsspTarget}` });
  if (aiaTarget != null) euiTicks.push({ key: "aia", value: aiaTarget, label: `AIA ${aiaTarget}` });
  euiTicks.push({ key: "nz", value: 0, label: "Net Zero" });

  view.innerHTML = `
    <div class="no-print" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; gap:10px; flex-wrap:wrap;">
      <div class="breadcrumbs" style="margin:0;">${staff ? `<a href="#/">Projects</a> / ` : ""}<a href="#/project/${id}">${esc(project.name)}</a> / Dashboard</div>
      <div style="display:flex; gap:10px;">
        <a class="btn btn-secondary" href="#/project/${id}">Back to Scorecard</a>
        <button class="btn btn-primary" onclick="window.print()">Print / Save as PDF</button>
      </div>
    </div>

    <div class="dash card">
      <header class="dash-head">
        <div>
          <h1>${esc(project.name)}</h1>
          <div class="dash-sub">WSSP Design Dashboard · ${esc(protocol.name)} · ${esc(PROJECT_TYPE_NAMES[project.projectType])}${project.schoolLevel && SCHOOL_LEVEL_NAMES[project.schoolLevel] ? " · " + SCHOOL_LEVEL_NAMES[project.schoolLevel] : ""} · ${today}</div>
        </div>
        <img src="/assets/logo.png" alt="PBK" class="report-logo">
      </header>

      <div class="dash-section-title">Overall Scores</div>
      <div class="dash-overall">
        <div class="dash-gauge-block">
          ${gaugeSvg({ size: 230, stroke: 30, domain: achievable.total,
            segments: [
              { value: score.yes, color: STATUS_COLORS.yes },
              { value: score.maybeYes, color: STATUS_COLORS.maybeYes }
            ],
            centerTop: String(score.yes), centerBottom: "Total points (Yes)",
            marker: goal ? { value: goal, label: `Min ${goal}` } : null })}
          <div class="dash-gauge-caption">
            <b>Total Points</b> — Yes ${score.yes} · with Maybe Yes ${score.yes + score.maybeYes}
            · minimum required ${goal ?? "—"} · ${achievable.total} achievable${achievable.total !== protocol.grandTotal ? ` (scorecard sums to ${protocol.grandTotal})` : ""}
          </div>
        </div>
        <div class="dash-gauge-block">
          ${euiReady
            ? euiGaugeSvg({ maxVal: Math.max(baseline, wsspTarget || 0) * 1.05, baseline, projected, ticks: euiTicks })
            : `<div class="dash-eui-empty">EUI gauge needs a <b>Zero Tool Baseline</b> (or CBPS Baseline) to place the targets${staff ? " — add it under Edit Details" : ""}. The needle appears once a Projected EUI is entered.</div>`}
          <div class="dash-gauge-caption">
            <b>EUI</b> (kBtu/sf/yr)${zeroTool ? ` — Zero Tool baseline ${zeroTool}` : ""}${cbps ? ` · CBPS baseline ${cbps}` : ""}${projected ? ` · projected ${projected}` : ""}${wsspTarget ? ` · WSSP target ${wsspTarget}` : ""}${aiaTarget != null ? ` · AIA 2030 target ${aiaTarget}` : ""}
            ${wsspTarget ? `<span class="dash-note">WSSP target: CBPS adjusted NC/alteration EUIt for ${esc(project.climateZone)} ${esc(SCHOOL_LEVEL_NAMES[project.schoolLevel] || "")} (WSSP 2023, E1.2).${aiaTarget != null ? ` AIA 2030 target = ${aiaPct}% reduction from the Zero Tool baseline (percentage editable in project details).` : ""}</span>`
              : `<span class="dash-note">Set school level and climate zone in project details to place the WSSP target marker.${aiaTarget != null ? ` AIA 2030 target = ${aiaPct}% reduction from the Zero Tool baseline.` : ""}</span>`}
          </div>
        </div>
      </div>

      <div class="dash-section-title">Points per Category</div>
      <div class="dash-legend">
        ${STATUSES.map(st => `<span><span class="dot" style="background:${STATUS_COLORS[st]}"></span>${STATUS_LABELS[st]}</span>`).join("")}
        <span><span class="dot" style="background:${STATUS_COLORS.rest}; border:1px solid #d6dadc;"></span>Unmarked</span>
        <span class="dash-note">Yes / Maybe Yes segments show claimed points; Maybe No / No show those credits' possible points.</span>
      </div>
      <div class="dash-grid">
        ${protocol.categories.map(catCard).join("")}
      </div>
      <div class="report-footer">Generated by the PBK WSSP Tracker · ${today} · Required credits met: ${score.reqMet}/${score.reqTotal}</div>
    </div>
  `;
}

/* ── OSPI export report ──────────────────────────────────────── */
async function renderReport(id) {
  const [project, protocols] = await Promise.all([api("GET", `/api/projects/${id}`), loadProtocols()]);
  const protocol = protocols[project.protocolId];
  if (!protocol) throw new Error(`Unknown protocol: ${project.protocolId}`);

  const goal = threshold(protocol, project);
  const score = computeScore(protocol, project);
  // Guard against a missing threshold: `score.yes >= null` coerces to `>= 0`
  // (always true), which would wrongly label a project compliant with zero
  // required points. Require an explicit numeric goal.
  const compliant = goal != null && score.reqMet === score.reqTotal && score.yes >= goal;
  const addressLine = [project.address, project.city, project.state, project.zip].filter(Boolean).join(", ");
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  /* OSPI final submittals accept only Yes or No — collect unresolved Maybes,
   * required credits marked No without an exemption, and unmarked credits. */
  const maybes = [], reqNoList = [], unmarked = [], pointsMissing = [];
  eachCredit(protocol, ({ id: cid, pts }) => {
    if ((project.notApplicable || {})[cid]) return;
    const e = project.credits[cid];
    if (!e) { unmarked.push(cid); return; }
    if (e.status === "maybeYes" || e.status === "maybeNo") maybes.push(cid);
    if (pts.required && e.status === "no" && !(project.exemptions || {})[cid]) reqNoList.push(cid);
    // Variable-range credit (e.g. "2-7") claimed Yes/Maybe Yes but with no
    // point value chosen counts as 0 points while the scorecard shows "✓" —
    // the scorecard reads complete yet silently under-counts. R-n credits are
    // excluded (their Yes means "requirement met"; extra points are opt-in).
    if ((e.status === "yes" || e.status === "maybeYes") &&
        !pts.required && pts.allowed.length > 1 && e.points === undefined) {
      pointsMissing.push(cid);
    }
  });
  const isDraft = maybes.length > 0;
  const isBlocked = reqNoList.length > 0;

  const mark = (entry, pts) => {
    if (!entry) return ["", "", "", ""];
    const p = entryPoints(entry, pts);
    const cell = pts.max > 0 ? (p || "✓") : "✓";
    if (entry.status === "yes") return [cell, "", "", ""];
    if (entry.status === "maybeYes") return ["", cell, "", ""];
    if (entry.status === "maybeNo") return ["", "", "✓", ""];
    if (entry.status === "no") return ["", "", "", "✓"];
    return ["", "", "", ""];
  };

  const catTable = cat => {
    const c = score.byCategory[cat.id] || { yes: 0, maybeYes: 0, reqTotal: 0, reqMet: 0 };
    const rows = cat.groups.map(g =>
      `<tr class="group-row"><td colspan="7">${esc(g.name)}</td></tr>` +
      g.credits.map(([cid, cname, spec]) => {
        const pts = parsePoints(spec);
        if (pts.header) {
          return `<tr class="parent-row"><td>${esc(cid)}</td><td colspan="6">${esc(cname)}</td></tr>`;
        }
        if ((project.notApplicable || {})[cid]) {
          return `<tr class="na-row">
            <td>${esc(cid)}</td><td>${esc(cname)}</td>
            <td class="num">N/A</td><td class="num"></td><td class="num"></td><td class="num"></td><td class="num"></td>
          </tr>`;
        }
        const exCode = (project.exemptions || {})[cid] || "";
        const [y, my, mn, n] = mark(project.credits[cid], pts);
        return `<tr>
          <td>${esc(cid)}</td>
          <td>${esc(cname)}</td>
          <td class="num">${esc(pts.label)}</td>
          <td class="num">${exCode ? esc(exCode) : y}</td>
          <td class="num">${my}</td>
          <td class="num">${mn}</td>
          <td class="num">${exCode ? "" : n}</td>
        </tr>`;
      }).join("")
    ).join("");
    return `
      <table class="report-table">
        <thead>
          <tr class="cat-row"><th colspan="2">${esc(cat.name)}</th><th class="num">Possible<br>Points</th><th class="num">Yes</th><th class="num">Maybe<br>Yes</th><th class="num">Maybe<br>No</th><th class="num">No</th></tr>
        </thead>
        <tbody>
          ${rows}
          <tr class="subtotal-row">
            <td colspan="2">Total possible: ${cat.total}</td>
            <td class="num"></td>
            <td class="num">${c.yes}</td>
            <td class="num">${c.maybeYes}</td>
            <td class="num"></td>
            <td class="num"></td>
          </tr>
        </tbody>
      </table>`;
  };

  const docRows = [];
  for (const [cid, list] of Object.entries(project.documents || {})) {
    for (const d of list) docRows.push({ cid, ...d });
  }
  docRows.sort((a, b) => a.cid.localeCompare(b.cid, undefined, { numeric: true }));
  const noteRows = Object.entries(project.creditNotes || {})
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));

  const thNew = protocol.thresholds.new, thMod = protocol.thresholds.modernization;
  const isNewType = project.projectType !== "modernization";
  const goalCell = (v, on) => `<td class="num ${on ? "goal-on" : ""}">${v}</td>`;

  view.innerHTML = `
    <div class="no-print" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:18px;">
      <div class="breadcrumbs" style="margin:0;"><a href="#/">Projects</a> / <a href="#/project/${id}">${esc(project.name)}</a> / Export</div>
      <div style="display:flex; gap:10px;">
        <a class="btn btn-secondary" href="#/project/${id}">Back to Scorecard</a>
        <button class="btn btn-primary" id="print-report">Print / Save as PDF</button>
      </div>
    </div>
    ${isDraft ? `
    <div class="no-print maybe-warning">
      <div>
        <b>${maybes.length} credit${maybes.length > 1 ? "s are" : " is"} still marked Maybe.</b>
        The final OSPI submittal accepts only <b>Yes</b> or <b>No</b> — resolve these before submitting:
        <span class="maybe-list">${maybes.map(esc).join(", ")}</span>
      </div>
      <a class="btn btn-secondary" href="#/project/${id}">Resolve on Scorecard</a>
    </div>` : ""}
    ${isBlocked ? `
    <div class="no-print maybe-warning blocked-warning">
      <div>
        <b>Required credit${reqNoList.length > 1 ? "s" : ""} marked No:</b>
        <span class="maybe-list">${reqNoList.map(esc).join(", ")}</span> —
        the project cannot comply as marked. Change to Yes, or record an OSPI exemption (E/V/EX)
        in the credit's panel on the scorecard.
      </div>
      <a class="btn btn-secondary" href="#/project/${id}">Open Scorecard</a>
    </div>` : ""}
    ${unmarked.length ? `
    <div class="no-print note-box" style="margin:0 0 14px; display:flex; justify-content:space-between; align-items:center; gap:14px; flex-wrap:wrap;">
      <span><b>${unmarked.length} credit${unmarked.length > 1 ? "s are" : " is"} unmarked.</b>
      The final scorecard should answer every credit — unpursued credits are a No.</span>
      <button class="btn btn-secondary" id="fill-unmarked-no">Mark All Unmarked as No</button>
    </div>` : ""}
    ${pointsMissing.length ? `
    <div class="no-print maybe-warning">
      <div>
        <b>${pointsMissing.length} range credit${pointsMissing.length > 1 ? "s are" : " is"} marked Yes without a point value.</b>
        These show a ✓ but score <b>0 points</b> — choose how many points each claims on the scorecard so the total isn't under-counted:
        <span class="maybe-list">${pointsMissing.map(esc).join(", ")}</span>
      </div>
      <a class="btn btn-secondary" href="#/project/${id}">Set Points</a>
    </div>` : ""}
    <div class="no-print note-box" style="margin:0 0 18px;">
      Use your browser's print dialog to save as PDF. Enable <b>"Background graphics"</b> so shading prints.
    </div>

    <div class="report card">
      <header class="report-head">
        <img src="/assets/logo.png" alt="PBK" class="report-logo">
        <div>
          <div class="report-title">${esc(protocol.name)} Scorecard</div>
          <div class="report-sub">Washington Sustainable Schools Protocol · Prepared ${today}</div>
        </div>
        <div class="report-verdict ${isDraft || isBlocked ? "draft" : compliant ? "ok" : "pending"}">
          ${isDraft ? `DRAFT — ${maybes.length} Maybe${maybes.length > 1 ? "s" : ""} to resolve`
            : isBlocked ? `Cannot comply — required credit${reqNoList.length > 1 ? "s" : ""} marked No`
            : compliant ? "Meets WSSP requirements" : "In progress"}
        </div>
      </header>

      <div class="report-fields">
        <div><b>District</b>${esc(project.district || "—")}</div>
        <div><b>Contact Name &amp; Phone</b>${esc([project.contactName, project.contactPhone].filter(Boolean).join(" · ") || "—")}</div>
        <div><b>Project Name and Type</b>${esc(project.name)} — ${esc(PROJECT_TYPE_NAMES[project.projectType])}</div>
        <div><b>D Phase</b>${esc(dPhaseInfo(project.dPhase)?.label || project.dPhase || "—")}</div>
        <div><b>Project Number</b>${esc(project.number || "—")}</div>
        <div><b>Address</b>${esc(addressLine || "—")}</div>
      </div>

      <div class="report-summary">
        <div><span class="num-lg">${score.yes}</span>Points earned (Yes)</div>
        <div><span class="num-lg">${score.maybeYes}</span>Points potential (Maybe Yes)</div>
        <div><span class="num-lg">${goal ?? "—"}</span>Minimum required</div>
        <div><span class="num-lg">${score.reqMet}/${score.reqTotal}</span>Required credits met</div>
      </div>

      ${protocol.categories.map(catTable).join("")}

      <table class="report-table">
        <tbody>
          <tr class="subtotal-row grand">
            <td colspan="2">GRAND TOTAL — Possible points: ${protocol.grandTotal} (most points possible, not a total of all points listed)</td>
            <td class="num"></td>
            <td class="num">${score.yes}</td>
            <td class="num">${score.maybeYes}</td>
            <td class="num"></td>
            <td class="num"></td>
          </tr>
        </tbody>
      </table>

      <div class="report-mins">
        <div class="report-mins-title">Minimum required for Washington Sustainable School — two-tier system</div>
        <table class="report-table mins">
          <tr><td></td><td class="num">Class I</td><td class="num">Class II</td></tr>
          <tr><td>New Facility and New Building on Existing Facility</td>
            ${goalCell(thNew.I, isNewType && project.districtClass === "I")}
            ${goalCell(thNew.II, isNewType && project.districtClass === "II")}</tr>
          <tr><td>Modernization</td>
            ${goalCell(thMod.I, !isNewType && project.districtClass === "I")}
            ${goalCell(thMod.II, !isNewType && project.districtClass === "II")}</tr>
        </table>
        <div class="report-note">Shaded cell is this project's applicable minimum. WSSP is a self-certified,
        CHPS-designed protocol: projects pass based on meeting the required prerequisite credits and the
        minimum point level. Compliance documentation is maintained with district project records and
        provided to OSPI through the SCAP D-Form process.${Object.keys(project.exemptions || {}).length
          ? " E / V / EX in the Yes column denote an OSPI-granted exemption, variance, or exception — the required credit is deemed compliant."
          : ""}${Object.keys(project.notApplicable || {}).length
          ? " N/A rows are outside this project's scope per the handbook's Table 1."
          : ""}</div>
      </div>

      <h2 class="report-section">Supporting Documentation Index</h2>
      ${docRows.length ? `
        <table class="report-table docs">
          <thead><tr><th>Credit</th><th>Document</th><th>Uploaded</th><th class="num">Size</th></tr></thead>
          <tbody>${docRows.map(d => `
            <tr><td>${esc(d.cid)}</td><td>${esc(d.name)}</td>
            <td>${new Date(d.uploadedAt).toLocaleDateString()}</td><td class="num">${formatBytes(d.size)}</td></tr>`).join("")}
          </tbody>
        </table>` : `<div class="report-note">No documents uploaded yet.</div>`}

      ${noteRows.length ? `
        <h2 class="report-section">Credit Notes</h2>
        <table class="report-table docs">
          <thead><tr><th>Credit</th><th>Note</th></tr></thead>
          <tbody>${noteRows.map(([cid, t]) => `<tr><td>${esc(cid)}</td><td>${esc(t)}</td></tr>`).join("")}</tbody>
        </table>` : ""}

      <div class="report-footer">Generated by the PBK WSSP Tracker · ${today} · ${esc(protocol.name)}, published ${esc(protocol.published)}</div>
    </div>
  `;
  const fillBtn = document.getElementById("fill-unmarked-no");
  if (fillBtn) fillBtn.addEventListener("click", async () => {
    if (!confirm(`Mark all ${unmarked.length} unmarked credits as No? This records an explicit No on every credit that has no status.`)) return;
    const result = await api("POST", `/api/projects/${id}/credits/fill-unmarked-no`);
    renderReport(id);
  });
  document.getElementById("print-report").addEventListener("click", () => {
    if (isDraft && !confirm(
      `${maybes.length} credit${maybes.length > 1 ? "s are" : " is"} still marked Maybe (${maybes.slice(0, 8).join(", ")}${maybes.length > 8 ? "…" : ""}).\n\n` +
      `The final OSPI submittal accepts only Yes or No, and this report will print stamped DRAFT.\n\nPrint a draft anyway?`)) return;
    window.print();
  });
}

/* ── Project page (overview + scorecard) ─────────────────────── */
async function renderProject(id) {
  // loadReference() is awaited for its side effect: it populates the module
  // REFERENCE cache that excerptFor()/interpretationsFor() read below. Its
  // return value is intentionally not destructured (hence three promises, two
  // bindings).
  const [project, protocols] = await Promise.all([api("GET", `/api/projects/${id}`), loadProtocols(), loadReference()]);
  const protocol = protocols[project.protocolId];
  if (!protocol) throw new Error(`Unknown protocol: ${project.protocolId}`);
  const staff = isStaffUser();

  const exclusiveMap = {}, conflictMap = {}, creditNames = {};
  for (const cat of protocol.categories)
    for (const g of cat.groups)
      for (const [ccid, ccname] of g.credits) creditNames[ccid] = ccname;
  for (const set of protocol.exclusiveSets || [])
    for (const c of set) exclusiveMap[c] = set;
  for (const [a, list] of protocol.conflictSets || [])
    for (const b of list) {
      (conflictMap[a] || (conflictMap[a] = [])).push(b);
      (conflictMap[b] || (conflictMap[b] = [])).push(a);
    }

  const goal = threshold(protocol, project);
  const score = computeScore(protocol, project);
  const achievable = achievablePoints(protocol, project);
  const addressLine = [project.address, project.city, project.state, project.zip].filter(Boolean).join(", ");

  const catSection = cat => {
    const c = score.byCategory[cat.id] || { yes: 0, maybe: 0, reqTotal: 0, reqMet: 0 };
    const collapsed = !expandedCats.has(pkey(id, cat.id));
    const rows = cat.groups.map(g => {
      const gkey = pkey(id, `${cat.id}|${g.name}`);
      const purposeOpen = openPurposes.has(gkey);
      return `
      <div class="group-name ${g.purpose ? "has-purpose" : ""}" ${g.purpose ? `data-purpose-toggle="${esc(gkey)}"` : ""}
        ${g.purpose ? `title="Click to ${purposeOpen ? "hide" : "show"} this section's purpose"` : ""}>
        ${esc(g.name)}${g.purpose ? `<span class="purpose-chev">${purposeOpen ? "▾" : "▸"} purpose</span>` : ""}
      </div>
      ${g.purpose && purposeOpen ? `<div class="group-purpose"><b>Purpose.</b> ${esc(g.purpose)}</div>` : ""}
      ${g.credits.map(([cid, cname, spec]) => {
        const pts = parsePoints(spec);
        if (pts.header) {
          return `<div class="credit-header-row"><span class="credit-id">${esc(cid)}</span><span class="credit-name">${esc(cname)}</span></div>`;
        }
        const entry = project.credits[cid];
        const status = entry ? entry.status : "none";
        const na = !!(project.notApplicable || {})[cid];
        const exemption = (project.exemptions || {})[cid] || "";
        // exclusive alternate pathways: gray out unselected alternates
        let altSelected = null, altConflict = false;
        const exSet = exclusiveMap[cid];
        if (exSet) {
          const others = exSet.filter(o => o !== cid && ["yes", "maybeYes"].includes(project.credits[o]?.status));
          if (others.length) {
            altSelected = others[0];
            altConflict = ["yes", "maybeYes"].includes(status);
          }
        }
        // handbook combination bans (e.g. E3.1.x with E1.3 Zero Net Energy):
        // same graying treatment, different wording
        let banSelected = null, banConflict = false;
        if (!altSelected && conflictMap[cid]) {
          const others = conflictMap[cid].filter(o => ["yes", "maybeYes"].includes(project.credits[o]?.status));
          if (others.length) {
            banSelected = others[0];
            banConflict = ["yes", "maybeYes"].includes(status);
          }
        }
        const altDisabled = (altSelected && !altConflict) || (banSelected && !banConflict);
        const pointOptions = (pts.required ? [0] : []).concat(pts.allowed);
        const canPickPoints = pointOptions.length > 1 && (status === "yes" || status === "maybeYes") && !na;
        const pointLabel = n => pts.required
          ? (n === 0 ? "Req only" : `+${n} pt${n > 1 ? "s" : ""}`)
          : `${n} pt${n > 1 ? "s" : ""}`;
        const selectedPts = entry?.points ?? (pts.required ? 0 : undefined);
        const pointsSel = canPickPoints ? `
          <select class="points-select" data-credit="${cid}" aria-label="Points for ${esc(cid)}">
            ${pointOptions.map(n =>
              `<option value="${n}" ${n === selectedPts ? "selected" : ""}>${pointLabel(n)}</option>`).join("")}
            ${selectedPts === undefined ? `<option value="" selected>pts?</option>` : ""}
          </select>` : "";
        const docs = (project.documents || {})[cid] || [];
        const note = (project.creditNotes || {})[cid] || "";
        const interps = interpretationsFor(project.protocolId, cid);
        const excerpt = excerptFor(project.protocolId, cid);
        const panelOpen = openDocPanels.has(pkey(id, cid));
        const docPanel = panelOpen ? `
          <div class="doc-panel" data-doc-panel="${cid}">
            ${excerpt ? `
              <details class="excerpt-box">
                <summary>Requirement — ${esc(protocol.name)} handbook excerpt</summary>
                <div class="excerpt-text">${esc(excerpt).replace(/\n\n/g, "<br><br>")}</div>
                <div class="doc-meta">Auto-extracted for reference — always confirm against the official OSPI handbook.</div>
              </details>` : ""}
            ${interps.map(i => `
              <details class="interp-inline">
                <summary>OSPI interpretation: ${esc(i.subject)} <span class="doc-meta">(${esc(i.issuedUnder)}, ${new Date(i.date + "T12:00:00").toLocaleDateString()})</span></summary>
                <div class="interp-body">
                  <p><b>Background.</b> ${esc(i.background)}</p>
                  <p><b>Request.</b> ${esc(i.request)}</p>
                  <p><b>Interpretation.</b> ${esc(i.interpretation)}</p>
                </div>
              </details>`).join("")}
            ${staff && pts.required ? `
            <div class="flag-controls">
              <label>OSPI exemption
                <select class="flag-exemption" data-credit="${cid}">
                  ${["", "E", "V", "EX"].map(v => `<option value="${v}" ${exemption === v ? "selected" : ""}>${
                    v === "" ? "None" : v === "E" ? "E — Exempt by Law" : v === "V" ? "V — Variance" : "EX — Exception (Not Practicable)"
                  }</option>`).join("")}
                </select>
              </label>
              ${project.projectType !== "new" ? `
              <label class="flag-na">
                <input type="checkbox" class="flag-notapplicable" data-credit="${cid}" ${na ? "checked" : ""}>
                Not applicable to this project's scope (Table 1)
              </label>` : ""}
              <span class="doc-meta">An exemption deems this required credit compliant (per the handbook, note E/V/EX on the scorecard with OSPI's determination letter attached). N/A removes it from the required count for reduced-scope projects.</span>
            </div>` : ""}
            <div class="note-field">
              <label for="note-${cid}">Project notes for ${esc(cid)}</label>
              <textarea id="note-${cid}" class="credit-note" data-credit="${cid}"
                placeholder="Approach, responsible party, open questions…">${esc(note)}</textarea>
              <span class="doc-meta note-status" data-note-status="${cid}"></span>
            </div>
            ${docs.length ? docs.map(d => `
              <div class="doc-item">
                <a href="/api/projects/${project.id}/files/${d.id}" download>${esc(d.name)}</a>
                <span class="doc-meta">${formatBytes(d.size)} · ${new Date(d.uploadedAt).toLocaleDateString()}</span>
                ${staff ? `<button type="button" class="doc-remove" data-file="${d.id}" title="Remove file">&times;</button>` : ""}
              </div>`).join("")
            : `<div class="doc-empty">No supporting documentation yet.</div>`}
            <label class="upload-label">
              + Upload document <span class="doc-meta">(max 25 MB)</span>
              <input type="file" class="doc-upload" data-credit="${cid}" hidden
                accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.txt,.rtf,.png,.jpg,.jpeg,.gif,.webp,.heic,.tif,.tiff,.zip,.dwg,.dxf,.msg,.eml">
            </label>
          </div>` : "";
        const reqNo = pts.required && status === "no" && !exemption && !na;
        const flag = status === "maybeYes"
          ? `<span class="maybe-flag" style="color:#e0af00" title="Maybe Yes">⚑</span>`
          : status === "maybeNo"
            ? `<span class="maybe-flag" style="color:#e07000" title="Maybe No">⚑</span>` : "";
        const noteLine = altConflict
          ? `<div class="credit-note-line conflict">Conflicts with ${esc(altSelected)} — these are alternate pathways; clear one.</div>`
          : banConflict
            ? `<div class="credit-note-line conflict">Per the handbook, these points may not be combined with ${esc(banSelected)} (${esc(creditNames[banSelected] || "")}) — clear one.</div>`
            : altDisabled
              ? (altSelected
                ? `<div class="credit-note-line">Alternate pathway — you've selected ${esc(altSelected)} (${esc(creditNames[altSelected] || "")}).</div>`
                : `<div class="credit-note-line">May not be combined with ${esc(banSelected)} (${esc(creditNames[banSelected] || "")}) per the handbook.</div>`)
              : reqNo
                ? `<div class="credit-note-line conflict">Required credit marked No — the project cannot comply unless an OSPI exemption is recorded${staff ? " (open this credit's panel)" : ""}.</div>`
                : "";
        return `
          <div class="credit-row ${panelOpen ? "docs-open" : ""} ${altDisabled ? "credit-alt" : ""} ${na ? "credit-na" : ""}" data-credit-row="${cid}">
            <span class="credit-id">${flag}${esc(cid)}</span>
            <span class="credit-name">${esc(cname)}${pts.required ? '<span class="credit-req">REQ</span>' : ""}${exemption ? `<span class="ex-badge" title="OSPI exemption recorded — deemed compliant">${esc(exemption)}</span>` : ""}${na ? '<span class="na-badge" title="Not applicable to this project scope (Table 1)">N/A</span>' : ""}${interps.length ? '<span class="cil-badge" title="OSPI interpretation available — open the credit panel">CIL</span>' : ""}${noteLine}</span>
            ${na ? "" : pointsSel}
            <button type="button" class="doc-btn ${docs.length ? "has-docs" : ""} ${panelOpen ? "open" : ""}"
              data-docs-toggle="${cid}" title="Supporting documentation">
              ${CLIP_SVG}<span>${docs.length || ""}</span>
            </button>
            <span class="credit-pts">${pts.max > 0 ? esc(pts.label) : "Req"}</span>
            ${na ? `<span class="status-seg-na">N/A</span>` : `
            <span class="status-seg" data-credit="${cid}" role="group" aria-label="Status for ${esc(cid)}">
              ${STATUSES.map(st => `<button type="button" data-status="${st}" ${altDisabled ? "disabled" : ""}
                class="${status === st ? "on-" + st : ""}">${STATUS_LABELS[st]}</button>`).join("")}
            </span>`}
          </div>${docPanel}`;
      }).join("")}
    `;
    }).join("");
    return `
      <section class="card category cat-${cat.id}">
        <div class="category-head" data-cat-toggle="${cat.id}"
          title="Click to ${collapsed ? "expand" : "collapse"} this category">
          <h2>${esc(cat.name)}</h2>
          <span class="cat-pts-wrap">
            <span class="cat-pts" ${achievable.byCategory[cat.id] !== cat.total ? `title="Best achievable combination for this project — alternate pathways count once and handbook combination limits apply. The OSPI scorecard column sums to ${cat.total}."` : ""}>${achievable.byCategory[cat.id]} possible pts<span class="chev">${collapsed ? "▸" : "▾"}</span></span>
            <span class="cat-counts">${c.nYes} Yes · ${c.nMaybeYes} Maybe Yes · ${c.nMaybeNo} Maybe No · ${c.nNo} No${c.nNA ? ` · ${c.nNA} N/A` : ""}</span>
          </span>
        </div>
        ${collapsed ? "" : rows + `
        <div class="cat-subtotal">
          ${c.reqTotal ? `<span>Required: <b>${c.reqMet}/${c.reqTotal}</b></span>` : ""}
          <span>Yes: <b>${c.yes}</b> pts</span>
          <span>Maybe Yes: <b>${c.maybeYes}</b> pts</span>
        </div>`}
      </section>`;
  };

  const goalPct = goal ? Math.min(100, (score.yes / goal) * 100) : 0;
  const maybePct = goal ? Math.min(100, ((score.yes + score.maybeYes) / goal) * 100) : 0;

  view.innerHTML = `
    <div class="breadcrumbs">${staff ? `<a href="#/">Projects</a> / ` : ""}${esc(project.name)}</div>
    <div class="card project-head">
      <div class="project-head-top">
        <div>
          <p class="kicker">${esc(protocol.name)} · ${esc(PROJECT_TYPE_NAMES[project.projectType])}</p>
          <h1>${esc(project.name)}</h1>
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <a class="btn btn-secondary" href="#/project/${id}/dashboard">Dashboard</a>
          ${staff ? `
          <a class="btn btn-primary" href="#/project/${id}/report">Export Report</a>
          <button class="btn btn-secondary" id="share-project">${sharingOpen.has(id) ? "Close Sharing" : "Share"}</button>
          <a class="btn btn-secondary" href="#/project/${id}/edit">Edit Details</a>
          <button class="btn btn-quiet" id="delete-project" title="Delete project">Delete</button>` : ""}
        </div>
      </div>
      <div class="project-facts">
        <div class="fact"><b>District</b><span>${esc(project.district || "—")}</span></div>
        <div class="fact"><b>District class</b><span>Class ${esc(project.districtClass)}</span></div>
        <div class="fact"><b>Project number</b><span>${esc(project.number || "—")}</span></div>
        <div class="fact fact-dphase"><b>D phase</b>
          ${staff
            ? `<select id="dphase-select" aria-label="D phase">${dPhaseOptions(project.dPhase)}</select>`
            : `<span>${esc(dPhaseInfo(project.dPhase)?.label || project.dPhase || "—")}</span>`}
          ${dPhaseInfo(project.dPhase) ? `<span class="fact-hint">${esc(dPhaseInfo(project.dPhase).note)}</span>` : ""}
        </div>
        <div class="fact"><b>Address</b><span>${esc(addressLine || "—")}</span></div>
        <div class="fact"><b>Contact</b><span>${esc([project.contactName, project.contactPhone].filter(Boolean).join(" · ") || "—")}</span></div>
      </div>
      ${project.notes ? `<div class="note-box">${esc(project.notes)}</div>` : ""}

      <div class="score-summary">
        <div class="card stat target"><div class="num">${goal ?? "—"}</div><div class="lbl">Points required</div></div>
        <div class="card stat yes"><div class="num">${score.yes}</div><div class="lbl">Points — Yes</div></div>
        <div class="card stat maybe"><div class="num">${score.maybeYes}</div><div class="lbl">Points — Maybe Yes</div></div>
        <div class="card stat req"><div class="num">${score.reqMet}/${score.reqTotal}</div><div class="lbl">Required credits met</div></div>
      </div>
      <div class="progress-wrap">
        <div class="progress-track">
          <div class="progress-maybe" style="width:${maybePct}%"></div>
          <div class="progress-yes" style="width:${goalPct}%"></div>
          ${goal ? `<div class="progress-goal" style="left: calc(100% - 3px)"></div>` : ""}
        </div>
        <div class="progress-legend">
          <span><span class="dot" style="background:var(--status-yes)"></span>Yes points</span>
          <span><span class="dot" style="background:var(--status-maybe)"></span>Maybe Yes (potential)</span>
          <span><span class="dot" style="background:var(--pbk-red)"></span>Goal: ${goal ?? "—"} pts (${esc(PROJECT_TYPE_NAMES[project.projectType])}, Class ${esc(project.districtClass)})</span>
        </div>
      </div>
      <div class="note-box">
        All required (“REQ”) credits must be marked <b>Yes</b> and the project must reach
        <b>${goal ?? "the minimum"}</b> points to comply. Achievable maximum for this project:
        <b>${achievable.total}</b> points${achievable.total !== protocol.grandTotal
          ? ` (the scorecard's summed total is ${protocol.grandTotal} — alternate energy pathways
             count once, and the handbook bars combining E3.1.x with E1.3 Zero Net Energy)` : ""}.
      </div>
    </div>

    ${staff && sharingOpen.has(id) ? (() => {
      const invites = (project.invites || []).filter(inv => !inv.revoked);
      const fresh = lastInviteLinks[id];
      const freshUrl = fresh ? `${location.origin}${location.pathname}?invite=${fresh.token}` : "";
      const mailto = fresh ? `mailto:${encodeURIComponent(fresh.email)}` +
        `?subject=${encodeURIComponent(`Invitation to collaborate: ${project.name} — WSSP Tracker`)}` +
        `&body=${encodeURIComponent(`You've been invited to collaborate on the WSSP scorecard for ${project.name}.\n\nOpen your invite link to set up your access — you'll create a password on your first visit:\n\n${freshUrl}\n\nAfter that, sign in any time at ${location.origin}${location.pathname} with your email address and password, from any device. You'll be able to update credit statuses, add notes, and upload supporting documentation for this project.\n\nIf you forget your password, let me know and I'll send you a fresh setup link.`)}` : "";
      return `
      <section class="card sharing-panel">
        <button type="button" class="sharing-close" id="close-sharing" title="Close sharing panel">&times;</button>
        <div class="sharing-head">
          <h2>Sharing &amp; Invitations</h2>
          <span>Invited collaborators can update this project's scorecard, notes, and documents —
          they can't edit project details, export the report, delete anything, or see other projects.
          The invite link is for <b>account setup</b>: the collaborator creates a password on first
          visit, then signs in with their email from any device. Click a name to reissue a link
          (which also serves as a password reset).</span>
        </div>
        ${fresh ? `
          <div class="invite-fresh">
            <button type="button" class="sharing-close fresh-close" id="dismiss-fresh" title="Dismiss link">&times;</button>
            <b>Invite link for ${esc(fresh.email)}</b> — send it now; for security it isn't shown again after you leave this page.
            <div class="invite-link-row">
              <input type="text" readonly id="fresh-link" value="${esc(freshUrl)}">
              <button type="button" class="btn btn-secondary" id="copy-invite">Copy</button>
              <a class="btn btn-secondary" href="${mailto}">Open Email Draft</a>
            </div>
          </div>` : ""}
        <form id="invite-form" class="invite-form">
          <input type="email" id="invite-email" placeholder="consultant@example.com" required>
          <button class="btn btn-primary" type="submit">Create Invite Link</button>
        </form>
        ${invites.length ? `
          <div class="invite-list">
            ${invites.map(inv => `
              <div class="invite-row">
                <button type="button" class="invite-email invite-regen" data-invite="${inv.id}" data-email="${esc(inv.email)}"
                  title="Click to issue a replacement link for ${esc(inv.email)}">${esc(inv.email)}</button>
                <span class="doc-meta">Invited ${new Date(inv.createdAt).toLocaleDateString()} by ${esc(inv.createdBy || "")}
                  · ${inv.usedAt ? "account active since " + new Date(inv.usedAt).toLocaleDateString() : inviteLinkStatus(inv)}${inv.regeneratedAt ? " · link reissued " + new Date(inv.regeneratedAt).toLocaleDateString() : ""}</span>
                <button type="button" class="btn btn-quiet invite-revoke" data-invite="${inv.id}">Revoke</button>
              </div>`).join("")}
          </div>
          <div class="doc-meta" style="margin-top:8px;">Click a name to issue a replacement link (if someone loses theirs) — the old link stops working.</div>`
        : `<div class="doc-empty">No active invitations.</div>`}
      </section>`;
    })() : ""}

    ${protocol.categories.map(catSection).join("")}
  `;

  /* status + points interactions */
  view.querySelectorAll(".status-seg").forEach(seg => {
    seg.addEventListener("click", async ev => {
      const btn = ev.target.closest("button[data-status]");
      if (!btn) return;
      const creditId = seg.dataset.credit;
      const current = project.credits[creditId];
      const next = current && current.status === btn.dataset.status ? "none" : btn.dataset.status;
      const body = { status: next };
      if (next === "yes" || next === "maybeYes") {
        // Fixed-point credits claim their value automatically; ranges start
        // unset; R-n credits start at "Req only" (0 extra points).
        let pts = null;
        eachCredit(protocol, c => { if (c.id === creditId) pts = c.pts; });
        if (current && current.points !== undefined) body.points = current.points;
        else if (pts && !pts.required && pts.allowed.length === 1) body.points = pts.allowed[0];
      }
      await api("PUT", `/api/projects/${id}/credits/${creditId}`, body);
      renderProject(id);
    });
  });
  view.querySelectorAll(".points-select").forEach(sel => {
    sel.addEventListener("change", async () => {
      if (sel.value === "") return;
      const creditId = sel.dataset.credit;
      const current = project.credits[creditId] || { status: "maybeYes" };
      await api("PUT", `/api/projects/${id}/credits/${creditId}`,
        { status: current.status, points: Number(sel.value) });
      renderProject(id);
    });
  });
  /* credit detail panels — toggled by the paperclip button or by clicking
   * anywhere on the row that isn't a control (status, points, upload) */
  const togglePanel = cid => {
    const k = pkey(id, cid);
    if (openDocPanels.has(k)) openDocPanels.delete(k);
    else openDocPanels.add(k);
    renderProject(id);
  };
  view.querySelectorAll("[data-docs-toggle]").forEach(btn => {
    btn.addEventListener("click", () => togglePanel(btn.dataset.docsToggle));
  });
  view.querySelectorAll(".credit-row").forEach(row => {
    row.addEventListener("click", ev => {
      if (ev.target.closest("button, select, a, input, label")) return;
      togglePanel(row.dataset.creditRow);
    });
  });
  /* category roll-up and group purpose dropdowns */
  view.querySelectorAll("[data-cat-toggle]").forEach(head => {
    head.addEventListener("click", () => {
      const catId = head.dataset.catToggle;
      const k = pkey(id, catId);
      if (expandedCats.has(k)) expandedCats.delete(k);
      else expandedCats.add(k);
      renderProject(id);
    });
  });
  view.querySelectorAll("[data-purpose-toggle]").forEach(el => {
    el.addEventListener("click", () => {
      const key = el.dataset.purposeToggle;
      if (openPurposes.has(key)) openPurposes.delete(key);
      else openPurposes.add(key);
      renderProject(id);
    });
  });
  view.querySelectorAll(".doc-upload").forEach(input => {
    input.addEventListener("change", async () => {
      if (!input.files.length) return;
      const fd = new FormData();
      fd.append("file", input.files[0]);
      const res = await fetch(`/api/projects/${id}/credits/${input.dataset.credit}/files`, {
        method: "POST", body: fd
      });
      if (!res.ok) {
        let msg = `Upload failed (${res.status})`;
        try { msg = (await res.json()).errors.join("; "); } catch (e) { /* keep default */ }
        alert(msg);
      }
      renderProject(id);
    });
  });
  const dphaseSel = document.getElementById("dphase-select");
  if (dphaseSel) dphaseSel.addEventListener("change", async ev => {
    await api("PUT", `/api/projects/${id}`, { dPhase: ev.target.value });
    renderProject(id);
  });
  /* sharing panel (staff only) */
  const shareBtn = document.getElementById("share-project");
  if (shareBtn) shareBtn.addEventListener("click", () => {
    if (sharingOpen.has(id)) sharingOpen.delete(id);
    else sharingOpen.add(id);
    renderProject(id);
  });
  const closeSharing = document.getElementById("close-sharing");
  if (closeSharing) closeSharing.addEventListener("click", () => {
    sharingOpen.delete(id);
    renderProject(id);
  });
  const dismissFresh = document.getElementById("dismiss-fresh");
  if (dismissFresh) dismissFresh.addEventListener("click", () => {
    delete lastInviteLinks[id];
    renderProject(id);
  });
  const inviteForm = document.getElementById("invite-form");
  if (inviteForm) inviteForm.addEventListener("submit", async ev => {
    ev.preventDefault();
    const email = document.getElementById("invite-email").value;
    try {
      const result = await api("POST", `/api/projects/${id}/invites`, { email });
      lastInviteLinks[id] = { token: result.token, email: result.invite.email };
      renderProject(id);
    } catch (e) { alert(e.message); }
  });
  const copyBtn = document.getElementById("copy-invite");
  if (copyBtn) copyBtn.addEventListener("click", async () => {
    const input = document.getElementById("fresh-link");
    try { await navigator.clipboard.writeText(input.value); }
    catch (e) { input.select(); document.execCommand("copy"); }
    copyBtn.textContent = "Copied!";
    setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
  });
  view.querySelectorAll(".invite-regen").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm(`Issue a replacement link for ${btn.dataset.email}? Their old link will stop working (their current session stays signed in).`)) return;
      try {
        const result = await api("POST", `/api/projects/${id}/invites/${btn.dataset.invite}/regenerate`);
        lastInviteLinks[id] = { token: result.token, email: result.invite.email };
        renderProject(id);
      } catch (e) { alert(e.message); }
    });
  });
  view.querySelectorAll(".invite-revoke").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Revoke this invite? The collaborator will immediately lose access to this project.")) return;
      await api("DELETE", `/api/projects/${id}/invites/${btn.dataset.invite}`);
      renderProject(id);
    });
  });
  view.querySelectorAll(".flag-exemption").forEach(sel => {
    sel.addEventListener("change", async () => {
      try {
        await api("PUT", `/api/projects/${id}/credits/${sel.dataset.credit}/flags`, { exemption: sel.value });
        renderProject(id);
      } catch (e) { alert(e.message); }
    });
  });
  view.querySelectorAll(".flag-notapplicable").forEach(cb => {
    cb.addEventListener("change", async () => {
      if (cb.checked && !confirm("Mark this required credit Not Applicable? Its status will be cleared and it will be excluded from the required-credit count.")) {
        cb.checked = false; return;
      }
      try {
        await api("PUT", `/api/projects/${id}/credits/${cb.dataset.credit}/flags`, { notApplicable: cb.checked });
        renderProject(id);
      } catch (e) { alert(e.message); renderProject(id); }
    });
  });
  view.querySelectorAll(".credit-note").forEach(ta => {
    ta.addEventListener("blur", async () => {
      const cid = ta.dataset.credit;
      const prev = (project.creditNotes || {})[cid] || "";
      if (ta.value.trim() === prev) return;
      const statusEl = view.querySelector(`[data-note-status="${cid}"]`);
      const saved = await api("PUT", `/api/projects/${id}/credits/${cid}/note`, { text: ta.value });
      project.creditNotes = saved.creditNotes || {};
      if (statusEl) statusEl.textContent = "Saved";
    });
  });
  view.querySelectorAll(".doc-remove").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Remove this file?")) return;
      await api("DELETE", `/api/projects/${id}/files/${btn.dataset.file}`);
      renderProject(id);
    });
  });
  const deleteBtn = document.getElementById("delete-project");
  if (deleteBtn) deleteBtn.addEventListener("click", async () => {
    if (!confirm(`Delete "${project.name}" and its scorecard? This cannot be undone.`)) return;
    await api("DELETE", `/api/projects/${id}`);
    location.hash = "#/";
  });
}

/* ── Boot ────────────────────────────────────────────────────── */
window.addEventListener("hashchange", route);
checkVersion();
setInterval(checkVersion, 5 * 60 * 1000);
window.addEventListener("focus", checkVersion);
route();
