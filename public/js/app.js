/* WSSP Tracker — frontend.
 * Hash-routed single-page app: #/ (projects), #/new, #/project/<id>.
 */
"use strict";

const API_VERSION = 6;

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

async function checkVersion() {
  try {
    const meta = await api("GET", "/api/meta");
    if (meta.apiVersion !== API_VERSION) {
      document.getElementById("version-banner").classList.remove("hidden");
    }
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
    : `${esc(ME.email || "Guest")}<span class="chip-role">Guest</span>`;
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

/* Point spec strings: "R", "1", "1-2", "R-1", "2-7", "35", "1, 2-3", "1 + 2-3".
 * required = leading R; header = null spec.
 * "+" joins additive tiers (max = sum of tier maxima); otherwise the
 * largest number present is the credit's maximum. */
function parsePoints(spec) {
  if (spec === null || spec === undefined) return { header: true, required: false, max: 0 };
  const required = /^R/i.test(spec);
  const partMax = s => Math.max(0, ...(s.match(/\d+/g) || []).map(Number));
  const max = spec.includes("+")
    ? spec.split("+").reduce((t, part) => t + partMax(part), 0)
    : partMax(spec);
  const nums = (spec.match(/\d+/g) || []).map(Number);
  const min = nums.length ? Math.min(...nums) : 0;
  return { header: false, required, max, min, label: spec };
}

const PROJECT_TYPE_NAMES = {
  new: "New School (Facility)",
  newBuilding: "New Building on Existing Facility",
  modernization: "Modernization"
};

/* SCAP D-Form phases relevant to WSSP, per the handbooks' "D-Form Process"
 * section, with the WSSP submittal due at each phase. */
const D_PHASES = [
  { value: "pre-d3", code: "Pre-D-3", label: "Pre-D-3 — Planning / Early Design",
    note: "Before the project approval application. Plan the integrated design workshop and choose the high-performance standard." },
  { value: "d3", code: "D-3", label: "D-3 — Application for Project Approval",
    note: "Indicate WSSP as the high-performance standard pursued on the D-3 (or request an exemption with a letter to OSPI)." },
  { value: "d4", code: "D-4", label: "D-4 — OSPI Project Approval Issued",
    note: "Edition lock: SCAP projects apply the WSSP version in effect at D-4 approval. A newer edition may always be used." },
  { value: "d5", code: "D-5", label: "D-5 — Application for Preliminary Funding Status",
    note: "Due with D-5: preliminary design WSSP scorecard." },
  { value: "d7", code: "D-7", label: "D-7 — Proceed with Bid Opening / Negotiate MACC",
    note: "ELCCA (Energy Conservation Report) cost indicated on the D-7 with the DES review letter. No separate WSSP submittal." },
  { value: "d9", code: "D-9", label: "D-9 — Authorization to Sign Contracts / MACC Agreement",
    note: "Due with D-9: final design-phase WSSP scorecard, Sustainable Building Strategy narrative (2–4 pages), and ELCCA executive summary if applicable." },
  { value: "d11", code: "D-11", label: "D-11 — Application to Release Retainage",
    note: "Due with/before D-11: final WSSP scorecard, Post Occupancy Evaluation Plan, and certification letter committing to 5 years of annual reporting." },
  { value: "annual", code: "Reporting", label: "Annual Reporting (5 years)",
    note: "Report energy and water use through EPA Energy Star Portfolio Manager for five consecutive years after board acceptance." }
];

/* Normalize stored/legacy values ("D4", "d-5 ", "D11") to canonical keys. */
function normalizeDPhase(v) {
  if (!v) return "";
  const k = String(v).toLowerCase().replace(/[^a-z0-9]/g, "");
  const hit = D_PHASES.find(p => p.value.replace(/[^a-z0-9]/g, "") === k || p.code.toLowerCase().replace(/[^a-z0-9]/g, "") === k);
  return hit ? hit.value : v;
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

function threshold(protocol, project) {
  const t = protocol.thresholds[project.projectType];
  return t ? t[project.districtClass] : null;
}

/* Walk every scoreable credit of a protocol. */
function eachCredit(protocol, fn) {
  for (const cat of protocol.categories)
    for (const g of cat.groups)
      for (const [id, name, spec] of g.credits) {
        const pts = parsePoints(spec);
        if (!pts.header) fn({ id, name, pts, category: cat });
      }
}

/* Points actually claimed for one credit entry. */
function entryPoints(entry, pts) {
  if (!entry || entry.status === "no") return 0;
  if (pts.max === 0) return 0;
  return entry.points !== undefined ? entry.points : pts.max === pts.min ? pts.max : 0;
}

function computeScore(protocol, project) {
  const s = {
    yes: 0, maybe: 0,
    reqTotal: 0, reqMet: 0,
    byCategory: {}
  };
  eachCredit(protocol, ({ id, pts, category }) => {
    const c = s.byCategory[category.id] || (s.byCategory[category.id] = { yes: 0, maybe: 0, reqTotal: 0, reqMet: 0 });
    const entry = project.credits[id];
    if (pts.required) {
      s.reqTotal++; c.reqTotal++;
      if (entry && entry.status === "yes") { s.reqMet++; c.reqMet++; }
    }
    const p = entryPoints(entry, pts);
    if (entry && entry.status === "yes")   { s.yes += p;   c.yes += p; }
    if (entry && entry.status === "maybe") { s.maybe += p; c.maybe += p; }
  });
  return s;
}

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

/* Credits whose document panel is open, so panels survive re-renders. */
const openDocPanels = new Set();
/* Group purposes open and categories collapsed, keyed to survive re-renders. */
const openPurposes = new Set();
const collapsedCats = new Set();
/* Sharing panel open state and the most recently created invite link per project. */
const sharingOpen = new Set();
const lastInviteLinks = {};

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
              <input id="l-name" type="text" autocomplete="name" placeholder="e.g. Ben Fields">
            </div>
            <div class="form-field">
              <label for="l-email">Email</label>
              <input id="l-email" type="email" autocomplete="email" placeholder="you@pbk.com">
            </div>
            <div class="form-field">
              <label for="l-code">Staff access code <span class="req">*</span></label>
              <input id="l-code" type="password" autocomplete="off">
              <span class="hint">Shown in the server console at startup. Microsoft SSO replaces this
              when the tool is deployed to Azure App Service.</span>
            </div>
            <button class="btn btn-primary" type="submit" style="width:100%; justify-content:center;">Sign In</button>
          </form>`}
        <div class="login-guest-note">
          Consultants and district collaborators: use the invite link from your PBK contact —
          no sign-in needed.
        </div>
      </div>
    </div>`;
  const form = document.getElementById("login-form");
  if (form) form.addEventListener("submit", async ev => {
    ev.preventDefault();
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
}

async function renderInviteRedeem(token) {
  view.innerHTML = `<div class="login-wrap"><div class="card login-card"><h1>Opening your invite…</h1></div></div>`;
  try {
    const result = await api("POST", "/api/invites/redeem", { token });
    ME = null;
    await loadMe(true);
    location.hash = `#/project/${result.projectId}`;
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

/* ── OSPI export report ──────────────────────────────────────── */
async function renderReport(id) {
  const [project, protocols] = await Promise.all([api("GET", `/api/projects/${id}`), loadProtocols()]);
  const protocol = protocols[project.protocolId];
  if (!protocol) throw new Error(`Unknown protocol: ${project.protocolId}`);

  const goal = threshold(protocol, project);
  const score = computeScore(protocol, project);
  const compliant = score.reqMet === score.reqTotal && score.yes >= goal;
  const addressLine = [project.address, project.city, project.state, project.zip].filter(Boolean).join(", ");
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  const mark = (entry, pts) => {
    if (!entry) return ["", "", ""];
    const p = entryPoints(entry, pts);
    const cell = pts.max > 0 ? (p || "✓") : "✓";
    if (entry.status === "yes") return [cell, "", ""];
    if (entry.status === "maybe") return ["", cell, ""];
    if (entry.status === "no") return ["", "", "✓"];
    return ["", "", ""];
  };

  const catTable = cat => {
    const c = score.byCategory[cat.id] || { yes: 0, maybe: 0, reqTotal: 0, reqMet: 0 };
    const rows = cat.groups.map(g =>
      `<tr class="group-row"><td colspan="6">${esc(g.name)}</td></tr>` +
      g.credits.map(([cid, cname, spec]) => {
        const pts = parsePoints(spec);
        if (pts.header) {
          return `<tr class="parent-row"><td>${esc(cid)}</td><td colspan="5">${esc(cname)}</td></tr>`;
        }
        const [y, m, n] = mark(project.credits[cid], pts);
        return `<tr>
          <td>${esc(cid)}</td>
          <td>${esc(cname)}</td>
          <td class="num">${esc(pts.label)}</td>
          <td class="num">${y}</td>
          <td class="num">${m}</td>
          <td class="num">${n}</td>
        </tr>`;
      }).join("")
    ).join("");
    return `
      <table class="report-table">
        <thead>
          <tr class="cat-row"><th colspan="2">${esc(cat.name)}</th><th class="num">Possible<br>Points</th><th class="num">Yes</th><th class="num">Maybe</th><th class="num">No</th></tr>
        </thead>
        <tbody>
          ${rows}
          <tr class="subtotal-row">
            <td colspan="2">Total possible: ${cat.total}</td>
            <td class="num"></td>
            <td class="num">${c.yes}</td>
            <td class="num">${c.maybe}</td>
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
        <button class="btn btn-primary" onclick="window.print()">Print / Save as PDF</button>
      </div>
    </div>
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
        <div class="report-verdict ${compliant ? "ok" : "pending"}">
          ${compliant ? "Meets WSSP requirements" : "In progress"}
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
        <div><span class="num-lg">${score.maybe}</span>Points potential (Maybe)</div>
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
            <td class="num">${score.maybe}</td>
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
        provided to OSPI through the SCAP D-Form process.</div>
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
}

/* ── Project page (overview + scorecard) ─────────────────────── */
async function renderProject(id) {
  const [project, protocols] = await Promise.all([api("GET", `/api/projects/${id}`), loadProtocols(), loadReference()]);
  const protocol = protocols[project.protocolId];
  if (!protocol) throw new Error(`Unknown protocol: ${project.protocolId}`);
  const staff = isStaffUser();

  const goal = threshold(protocol, project);
  const score = computeScore(protocol, project);
  const addressLine = [project.address, project.city, project.state, project.zip].filter(Boolean).join(", ");

  const catSection = cat => {
    const c = score.byCategory[cat.id] || { yes: 0, maybe: 0, reqTotal: 0, reqMet: 0 };
    const collapsed = collapsedCats.has(cat.id);
    const rows = cat.groups.map(g => {
      const gkey = `${cat.id}|${g.name}`;
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
        const chosen = entryPoints(entry, pts);
        const canPickPoints = pts.max > 0 && pts.max !== pts.min && (status === "yes" || status === "maybe");
        const pointsSel = canPickPoints ? `
          <select class="points-select" data-credit="${cid}" aria-label="Points for ${esc(cid)}">
            ${Array.from({ length: pts.max }, (_, i) => i + 1).map(n =>
              `<option value="${n}" ${n === (entry?.points ?? 0) ? "selected" : ""}>${n} pt${n > 1 ? "s" : ""}</option>`).join("")}
            ${entry?.points === undefined ? `<option value="" selected>pts?</option>` : ""}
          </select>` : "";
        const docs = (project.documents || {})[cid] || [];
        const note = (project.creditNotes || {})[cid] || "";
        const interps = interpretationsFor(project.protocolId, cid);
        const excerpt = excerptFor(project.protocolId, cid);
        const panelOpen = openDocPanels.has(cid);
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
              <input type="file" class="doc-upload" data-credit="${cid}" hidden>
            </label>
          </div>` : "";
        return `
          <div class="credit-row ${panelOpen ? "docs-open" : ""}" data-credit-row="${cid}">
            <span class="credit-id">${esc(cid)}</span>
            <span class="credit-name">${esc(cname)}${pts.required ? '<span class="credit-req">REQ</span>' : ""}${interps.length ? '<span class="cil-badge" title="OSPI interpretation available — open the credit panel">CIL</span>' : ""}</span>
            ${pointsSel}
            <button type="button" class="doc-btn ${docs.length ? "has-docs" : ""} ${panelOpen ? "open" : ""}"
              data-docs-toggle="${cid}" title="Supporting documentation">
              ${CLIP_SVG}<span>${docs.length || ""}</span>
            </button>
            <span class="credit-pts">${pts.max > 0 ? esc(pts.label) : "Req"}</span>
            <span class="status-seg" data-credit="${cid}" role="group" aria-label="Status for ${esc(cid)}">
              <button type="button" data-status="yes"   class="${status === "yes" ? "on-yes" : ""}">Yes</button>
              <button type="button" data-status="maybe" class="${status === "maybe" ? "on-maybe" : ""}">Maybe</button>
              <button type="button" data-status="no"    class="${status === "no" ? "on-no" : ""}">No</button>
            </span>
          </div>${docPanel}`;
      }).join("")}
    `;
    }).join("");
    return `
      <section class="card category cat-${cat.id}">
        <div class="category-head" data-cat-toggle="${cat.id}"
          title="Click to ${collapsed ? "expand" : "collapse"} this category">
          <h2>${esc(cat.name)}</h2>
          <span class="cat-pts">${collapsed && (c.yes || c.maybe) ? `Yes ${c.yes} · Maybe ${c.maybe} · ` : ""}${cat.total} possible pts<span class="chev">${collapsed ? "▸" : "▾"}</span></span>
        </div>
        ${collapsed ? "" : rows + `
        <div class="cat-subtotal">
          ${c.reqTotal ? `<span>Required: <b>${c.reqMet}/${c.reqTotal}</b></span>` : ""}
          <span>Yes: <b>${c.yes}</b> pts</span>
          <span>Maybe: <b>${c.maybe}</b> pts</span>
        </div>`}
      </section>`;
  };

  const goalPct = goal ? Math.min(100, (score.yes / goal) * 100) : 0;
  const maybePct = goal ? Math.min(100, ((score.yes + score.maybe) / goal) * 100) : 0;

  view.innerHTML = `
    <div class="breadcrumbs">${staff ? `<a href="#/">Projects</a> / ` : ""}${esc(project.name)}</div>
    <div class="card project-head">
      <div class="project-head-top">
        <div>
          <p class="kicker">${esc(protocol.name)} · ${esc(PROJECT_TYPE_NAMES[project.projectType])}</p>
          <h1>${esc(project.name)}</h1>
        </div>
        <div style="display:flex; gap:8px;">
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
        <div class="card stat maybe"><div class="num">${score.maybe}</div><div class="lbl">Points — Maybe</div></div>
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
          <span><span class="dot" style="background:var(--status-maybe)"></span>Maybe (potential)</span>
          <span><span class="dot" style="background:var(--pbk-red)"></span>Goal: ${goal ?? "—"} pts (${esc(PROJECT_TYPE_NAMES[project.projectType])}, Class ${esc(project.districtClass)})</span>
        </div>
      </div>
      <div class="note-box">
        All required (“REQ”) credits must be marked <b>Yes</b> and the project must reach
        <b>${goal ?? "the minimum"}</b> points to comply. ${esc(protocol.name)} grand total:
        ${protocol.grandTotal} possible points.
      </div>
    </div>

    ${staff && sharingOpen.has(id) ? (() => {
      const invites = (project.invites || []).filter(inv => !inv.revoked);
      const fresh = lastInviteLinks[id];
      const freshUrl = fresh ? `${location.origin}${location.pathname}?invite=${fresh.token}` : "";
      const mailto = fresh ? `mailto:${encodeURIComponent(fresh.email)}` +
        `?subject=${encodeURIComponent(`Invitation to collaborate: ${project.name} — WSSP Tracker`)}` +
        `&body=${encodeURIComponent(`You've been invited to collaborate on the WSSP scorecard for ${project.name}.\n\nOpen your invite link to get started — it signs you in automatically, no account needed:\n\n${freshUrl}\n\nThe link works once, on the device where you open it, so please don't forward it. You'll be able to update credit statuses, add notes, and upload supporting documentation for this project. If you need to sign in on another device, ask me to reissue your link.`)}` : "";
      return `
      <section class="card sharing-panel">
        <button type="button" class="sharing-close" id="close-sharing" title="Close sharing panel">&times;</button>
        <div class="sharing-head">
          <h2>Sharing &amp; Invitations</h2>
          <span>Invited collaborators can update this project's scorecard, notes, and documents —
          they can't edit project details, export the report, delete anything, or see other projects.
          Each link signs in <b>once</b>: a forwarded copy of a used link won't work.</span>
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
                  · ${inv.usedAt ? "link used " + new Date(inv.usedAt).toLocaleDateString() : "link not yet used"}${inv.regeneratedAt ? " · reissued " + new Date(inv.regeneratedAt).toLocaleDateString() : ""}</span>
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
      if (next === "yes" || next === "maybe") {
        // Fixed-point credits claim their value automatically; ranges start unset.
        let pts = null;
        eachCredit(protocol, c => { if (c.id === creditId) pts = c.pts; });
        if (pts && pts.max > 0 && pts.max === pts.min) body.points = pts.max;
        else if (current && current.points !== undefined) body.points = current.points;
      }
      await api("PUT", `/api/projects/${id}/credits/${creditId}`, body);
      renderProject(id);
    });
  });
  view.querySelectorAll(".points-select").forEach(sel => {
    sel.addEventListener("change", async () => {
      if (sel.value === "") return;
      const creditId = sel.dataset.credit;
      const current = project.credits[creditId] || { status: "maybe" };
      await api("PUT", `/api/projects/${id}/credits/${creditId}`,
        { status: current.status, points: Number(sel.value) });
      renderProject(id);
    });
  });
  /* credit detail panels — toggled by the paperclip button or by clicking
   * anywhere on the row that isn't a control (status, points, upload) */
  const togglePanel = cid => {
    if (openDocPanels.has(cid)) openDocPanels.delete(cid);
    else openDocPanels.add(cid);
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
      if (collapsedCats.has(catId)) collapsedCats.delete(catId);
      else collapsedCats.add(catId);
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
route();
