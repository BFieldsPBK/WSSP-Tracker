/* WSSP Tracker — server.
 *
 * Serves the frontend and persists projects as JSON on disk.
 * Protocol definitions (WSSP 2018 / 2023) are read-only config.
 * Run with `npm start`; browse to http://localhost:3000.
 */
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");

const app = express();
const PORT = process.env.PORT || 3000;

/* Bump whenever the API changes shape. The frontend declares the version it
 * was built against; a mismatch shows a "restart the server" banner instead
 * of letting edits silently fail. */
const API_VERSION = 7;

const DATA_DIR = process.env.APPDATA_DIR || path.join(__dirname, "data");
const PROJECTS_FILE = path.join(DATA_DIR, "projects.json");
const FILES_DIR = path.join(DATA_DIR, "files");
const PROTOCOL_DIR = path.join(__dirname, "config", "protocols");
const MAX_UPLOAD = 25 * 1024 * 1024; // 25 MB per file, matching PBK's other tools

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: FILES_DIR,
    filename: (req, file, cb) => cb(null, "file-" + crypto.randomBytes(8).toString("hex"))
  }),
  limits: { fileSize: MAX_UPLOAD }
});

// Atomic write: temp file + rename, so a crash mid-write can't corrupt data.
function writeFileAtomic(file, data) {
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, file);
}

/* ── Protocols & reference material (read-only config) ───────── */
const protocols = {};
for (const f of fs.readdirSync(PROTOCOL_DIR).filter(f => f.endsWith(".json"))) {
  const p = JSON.parse(fs.readFileSync(path.join(PROTOCOL_DIR, f), "utf8"));
  protocols[p.id] = p;
}

/* Handbook excerpts, keyed by protocol id -> credit id -> text. */
const excerpts = {};
const HANDBOOK_DIR = path.join(__dirname, "config", "handbook");
if (fs.existsSync(HANDBOOK_DIR)) {
  for (const f of fs.readdirSync(HANDBOOK_DIR).filter(f => f.endsWith("-excerpts.json"))) {
    const protocolId = f.replace("-excerpts.json", "");
    excerpts[protocolId] = JSON.parse(fs.readFileSync(path.join(HANDBOOK_DIR, f), "utf8"));
  }
}

/* OSPI credit interpretation library. */
const interpretations = JSON.parse(
  fs.readFileSync(path.join(__dirname, "config", "interpretations.json"), "utf8"));

/* Canonical SCAP D-Form phase keys (see D_PHASES in public/js/app.js).
 * Legacy free-text values like "D4" or "d-5" normalize to these; anything
 * unrecognized is kept as entered. */
const D_PHASE_KEYS = ["pre-d3", "d3", "d4", "d5", "d7", "d9", "d11", "annual"];
function normalizeDPhase(v) {
  if (!v) return "";
  const k = String(v).toLowerCase().replace(/[^a-z0-9]/g, "");
  return D_PHASE_KEYS.find(p => p.replace(/[^a-z0-9]/g, "") === k) || v;
}

/* ── Store ───────────────────────────────────────────────────── */
let projects = [];
if (fs.existsSync(PROJECTS_FILE)) {
  projects = JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf8"));
  // One-time normalization of legacy free-text D-phase values ("D4" -> "d4").
  let migrated = false;
  for (const p of projects) {
    const norm = normalizeDPhase(p.dPhase);
    if (norm !== (p.dPhase || "")) { p.dPhase = norm; migrated = true; }
  }
  if (migrated) setImmediate(() => saveProjects());
}
function saveProjects() {
  writeFileAtomic(PROJECTS_FILE, JSON.stringify(projects, null, 2));
}

/* Guest accounts: email -> {passwordHash, salt, name, createdAt, updatedAt}.
 * Created by the account-setup invite link; a guest's project access is
 * whatever active invites exist for their email across all projects. */
const GUESTS_FILE = path.join(DATA_DIR, "guests.json");
let guests = {};
if (fs.existsSync(GUESTS_FILE)) {
  guests = JSON.parse(fs.readFileSync(GUESTS_FILE, "utf8"));
}
function saveGuests() {
  writeFileAtomic(GUESTS_FILE, JSON.stringify(guests, null, 2));
}
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

/* ── Auth ────────────────────────────────────────────────────── *
 * Two kinds of principal:
 *  - staff: full access. Signed in via Microsoft SSO when deployed behind
 *    Azure App Service Easy Auth (same X-MS-CLIENT-PRINCIPAL headers the
 *    FOCUS Map uses), or via the staff access code elsewhere (dev/office).
 *  - guest: an external collaborator holding a per-project invite link.
 *    Guests can edit the scorecard, notes, and documents of granted
 *    projects only — no project details, exports, deletes, or other
 *    projects. Invites are created per project and individually revocable;
 *    a guest session's grants are re-checked against the invite on every
 *    request, so revoking cuts access immediately.
 * Sessions are stateless HMAC-signed cookies; the secret persists in the
 * data folder. */

const SECRET_FILE = path.join(DATA_DIR, "auth-secret");
let AUTH_SECRET;
if (fs.existsSync(SECRET_FILE)) AUTH_SECRET = fs.readFileSync(SECRET_FILE, "utf8").trim();
else { AUTH_SECRET = crypto.randomBytes(32).toString("hex"); writeFileAtomic(SECRET_FILE, AUTH_SECRET); }

const STAFF_CODE_FILE = path.join(DATA_DIR, "staff-access-code");
let STAFF_CODE = (process.env.STAFF_ACCESS_CODE || "").trim();
if (!STAFF_CODE) {
  if (fs.existsSync(STAFF_CODE_FILE)) STAFF_CODE = fs.readFileSync(STAFF_CODE_FILE, "utf8").trim();
  if (!STAFF_CODE) { STAFF_CODE = crypto.randomBytes(4).toString("hex"); writeFileAtomic(STAFF_CODE_FILE, STAFF_CODE); }
}

const IS_AZURE = !!process.env.WEBSITE_SITE_NAME;
const TRUST_EASY_AUTH = IS_AZURE || process.env.TRUST_MS_PRINCIPAL_HEADERS === "1";
const STAFF_SESSION_MS = 7 * 24 * 3600e3;
const GUEST_SESSION_MS = 30 * 24 * 3600e3;

function hmac(s) { return crypto.createHmac("sha256", AUTH_SECRET).update(s).digest("base64url"); }
function sha256(s) { return crypto.createHash("sha256").update(s).digest("hex"); }
function makeSessionValue(payload) {
  const b = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return b + "." + hmac(b);
}
function parseSessionValue(v) {
  try {
    const dot = v.lastIndexOf(".");
    if (dot < 1) return null;
    const b = v.slice(0, dot), sig = v.slice(dot + 1);
    const expect = hmac(b);
    if (sig.length !== expect.length ||
        !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    const p = JSON.parse(Buffer.from(b, "base64url").toString());
    if (!p.exp || Date.now() > p.exp) return null;
    return p;
  } catch (e) { return null; }
}
function getCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach(part => {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function setSession(res, payload) {
  const maxAge = Math.max(0, Math.floor((payload.exp - Date.now()) / 1000));
  res.setHeader("Set-Cookie",
    `wssp_session=${makeSessionValue(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
}
function clearSession(res) {
  res.setHeader("Set-Cookie", "wssp_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}

/* ── Middleware ──────────────────────────────────────────────── */
app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => {
  req.user = null;
  // Azure Easy Auth injects the signed-in Microsoft identity on every request.
  if (TRUST_EASY_AUTH && req.headers["x-ms-client-principal"]) {
    try {
      const principal = JSON.parse(Buffer.from(req.headers["x-ms-client-principal"], "base64").toString());
      const claims = {};
      for (const c of principal.claims || []) claims[c.typ] = c.val;
      const email = claims["preferred_username"] ||
        claims["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"] ||
        claims["emails"] || "";
      req.user = { kind: "staff", name: claims["name"] || email, email, via: "microsoft" };
      return next();
    } catch (e) { /* malformed header — fall through to cookie auth */ }
  }
  const c = getCookies(req).wssp_session;
  if (c) req.user = parseSessionValue(c);
  next();
});
app.use(express.static(path.join(__dirname, "public")));

function isStaff(req) { return !!req.user && req.user.kind === "staff"; }
/* A guest's access is derived from their email on every request: every
 * project holding an active (non-revoked) invite for that email. Inviting
 * an existing guest to another project grants access instantly; revoking
 * cuts it just as fast. */
function guestProjects(email) {
  if (!email) return [];
  return projects.filter(p => (p.invites || []).some(i => !i.revoked && i.email === email));
}
function validGrants(req) {
  if (!req.user || req.user.kind !== "guest") return [];
  return guestProjects(req.user.email).map(p => ({ p: p.id }));
}
function canAccess(req, projectId) {
  return isStaff(req) || validGrants(req).some(g => g.p === projectId);
}
function requireStaff(req, res) {
  if (isStaff(req)) return true;
  res.status(req.user ? 403 : 401).json({ errors: [req.user ? "Staff access required" : "Sign-in required"] });
  return false;
}
function requireAccess(req, res, projectId) {
  if (canAccess(req, projectId)) return true;
  res.status(req.user ? 403 : 401).json({ errors: [req.user ? "You don't have access to this project" : "Sign-in required"] });
  return false;
}
function publicInvite(inv) {
  const { tokenHash, ...rest } = inv;
  return rest;
}
/* What a project looks like over the API: staff see invites (sans token
 * hashes); guests don't see the invite list at all. */
function projectView(p, req) {
  const { invites, ...rest } = p;
  return isStaff(req) ? { ...rest, invites: (invites || []).map(publicInvite) } : rest;
}

/* ── API ─────────────────────────────────────────────────────── */
app.get("/api/meta", (req, res) => {
  res.json({ apiVersion: API_VERSION });
});

app.get("/api/me", (req, res) => {
  if (!req.user) return res.json({ authenticated: false, microsoftSso: TRUST_EASY_AUTH });
  const out = {
    authenticated: true,
    kind: req.user.kind,
    name: req.user.name || "",
    email: req.user.email || "",
    via: req.user.via || "code",
    microsoftSso: TRUST_EASY_AUTH
  };
  if (req.user.kind === "guest") {
    out.projects = validGrants(req)
      .map(g => { const p = projects.find(x => x.id === g.p); return p && { id: p.id, name: p.name }; })
      .filter(Boolean);
  }
  res.json(out);
});

app.post("/api/login", (req, res) => {
  const { name, email, code } = req.body || {};
  if (!code || String(code).trim() !== STAFF_CODE) {
    return res.status(401).json({ errors: ["Invalid staff access code"] });
  }
  if (!name || !String(name).trim()) return res.status(400).json({ errors: ["Your name is required"] });
  const payload = {
    kind: "staff",
    name: String(name).trim().slice(0, 80),
    email: String(email || "").trim().slice(0, 120),
    via: "code",
    exp: Date.now() + STAFF_SESSION_MS
  };
  setSession(res, payload);
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

/* ── Invites ─────────────────────────────────────────────────── */
app.post("/api/projects/:id/invites", (req, res) => {
  if (!requireStaff(req, res)) return;
  const p = findProject(req, res);
  if (!p) return;
  const email = String((req.body || {}).email || "").trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ errors: ["A valid email address is required"] });
  const token = crypto.randomBytes(24).toString("base64url");
  if (!p.invites) p.invites = [];
  const invite = {
    id: crypto.randomBytes(6).toString("hex"),
    email,
    tokenHash: sha256(token),
    createdAt: new Date().toISOString(),
    createdBy: req.user.name || req.user.email || "staff",
    revoked: false,
    lastUsedAt: null
  };
  p.invites.push(invite);
  p.updatedAt = new Date().toISOString();
  saveProjects();
  res.status(201).json({ token, invite: publicInvite(invite) });
});

/* Reissue a lost link: same invite (existing guest sessions stay valid),
 * new token — the old link stops working immediately. */
app.post("/api/projects/:id/invites/:inviteId/regenerate", (req, res) => {
  if (!requireStaff(req, res)) return;
  const p = findProject(req, res);
  if (!p) return;
  const inv = (p.invites || []).find(i => i.id === req.params.inviteId);
  if (!inv) return res.status(404).json({ errors: ["Invite not found"] });
  if (inv.revoked) return res.status(400).json({ errors: ["This invite was revoked — create a new invite instead"] });
  const token = crypto.randomBytes(24).toString("base64url");
  inv.tokenHash = sha256(token);
  inv.usedAt = null;             // a reissued link is fresh: usable once again
  inv.regeneratedAt = new Date().toISOString();
  p.updatedAt = new Date().toISOString();
  saveProjects();
  res.json({ token, invite: publicInvite(inv) });
});

app.delete("/api/projects/:id/invites/:inviteId", (req, res) => {
  if (!requireStaff(req, res)) return;
  const p = findProject(req, res);
  if (!p) return;
  const inv = (p.invites || []).find(i => i.id === req.params.inviteId);
  if (!inv) return res.status(404).json({ errors: ["Invite not found"] });
  inv.revoked = true;
  p.updatedAt = new Date().toISOString();
  saveProjects();
  res.json(projectView(p, req));
});

/* Locate a live invite by its raw token. Returns {project, invite} or a
 * response-sending falsy result. */
function findInviteByToken(res, token) {
  if (!token) { res.status(400).json({ errors: ["Missing invite token"] }); return null; }
  const h = sha256(token);
  for (const p of projects) {
    const inv = (p.invites || []).find(i => i.tokenHash === h);
    if (inv) {
      if (inv.revoked) {
        res.status(410).json({ errors: ["This invite link has been revoked. Contact your PBK project contact for a new one."] });
        return null;
      }
      return { project: p, invite: inv };
    }
  }
  res.status(404).json({ errors: ["Invite link not recognized. It may have been replaced — ask your PBK contact for a current link."] });
  return null;
}

/* Step 1 of the invite flow: tells the frontend whether this link should
 * show account setup (first visit / password reset) or a sign-in prompt. */
app.post("/api/invites/redeem", (req, res) => {
  const found = findInviteByToken(res, String((req.body || {}).token || ""));
  if (!found) return;
  const { project, invite } = found;
  // Staff previewing a link neither consumes it nor downgrades their session.
  if (isStaff(req)) return res.json({ staff: true, projectId: project.id, projectName: project.name });
  if (invite.usedAt && guests[invite.email]) {
    // Account already set up — this link is spent; sign in instead.
    return res.json({ requiresLogin: true, email: invite.email, projectName: project.name });
  }
  return res.json({ setPassword: true, email: invite.email, projectName: project.name });
});

/* Step 2 (first visit or staff-reissued reset link): set the password.
 * Consumes the link — afterwards access is by email + password sign-in. */
app.post("/api/invites/activate", (req, res) => {
  const { token, password, name } = req.body || {};
  const found = findInviteByToken(res, String(token || ""));
  if (!found) return;
  const { project, invite } = found;
  if (invite.usedAt && guests[invite.email]) {
    return res.status(410).json({ errors: ["This link was already used to set up the account. Sign in with your email and password, or ask your PBK contact to reissue the link if you need a password reset."] });
  }
  if (!password || String(password).length < 8) {
    return res.status(400).json({ errors: ["Password must be at least 8 characters"] });
  }
  const salt = crypto.randomBytes(16).toString("hex");
  guests[invite.email] = {
    passwordHash: hashPassword(String(password), salt),
    salt,
    name: String(name || "").trim().slice(0, 80) || (guests[invite.email]?.name ?? ""),
    createdAt: guests[invite.email]?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  saveGuests();
  invite.usedAt = new Date().toISOString();
  invite.lastUsedAt = invite.usedAt;
  saveProjects();
  setSession(res, {
    kind: "guest", email: invite.email, name: guests[invite.email].name || invite.email,
    exp: Date.now() + GUEST_SESSION_MS
  });
  res.json({ projectId: project.id, projectName: project.name });
});

/* Collaborator sign-in with email + password (any device, any time). */
app.post("/api/login/guest", (req, res) => {
  const email = String((req.body || {}).email || "").trim().toLowerCase();
  const password = String((req.body || {}).password || "");
  const acc = guests[email];
  if (!acc || !password) {
    return res.status(401).json({ errors: ["Invalid email or password"] });
  }
  const attempt = hashPassword(password, acc.salt);
  if (attempt.length !== acc.passwordHash.length ||
      !crypto.timingSafeEqual(Buffer.from(attempt), Buffer.from(acc.passwordHash))) {
    return res.status(401).json({ errors: ["Invalid email or password"] });
  }
  setSession(res, {
    kind: "guest", email, name: acc.name || email,
    exp: Date.now() + GUEST_SESSION_MS
  });
  const granted = guestProjects(email);
  res.json({ ok: true, projectId: granted[0]?.id || null });
});

app.get("/api/protocols", (req, res) => {
  res.json(Object.values(protocols).sort((a, b) => b.id.localeCompare(a.id)));
});

app.get("/api/reference", (req, res) => {
  res.json({ excerpts, interpretations });
});

app.get("/api/projects", (req, res) => {
  if (!req.user) return res.status(401).json({ errors: ["Sign-in required"] });
  // Guests only ever see the projects they hold live invites to.
  const visible = isStaff(req)
    ? projects
    : projects.filter(p => validGrants(req).some(g => g.p === p.id));
  // List view only needs the summary, not every credit selection.
  res.json(visible.map(p => ({
    id: p.id, name: p.name, number: p.number, district: p.district,
    districtClass: p.districtClass, projectType: p.projectType,
    protocolId: p.protocolId, dPhase: p.dPhase, contactName: p.contactName,
    city: p.city, updatedAt: p.updatedAt, createdAt: p.createdAt,
    creditCount: Object.keys(p.credits || {}).length
  })));
});

const PROJECT_FIELDS = [
  "name", "number", "projectType", "protocolId",
  "district", "districtClass", "dPhase",
  "address", "city", "state", "zip",
  "contactName", "contactPhone", "notes"
];
const PROJECT_TYPES = ["new", "newBuilding", "modernization"];

function validateProject(body, { partial } = {}) {
  const errors = [];
  const out = {};
  for (const f of PROJECT_FIELDS) {
    if (body[f] !== undefined) {
      if (typeof body[f] !== "string") { errors.push(`${f} must be a string`); continue; }
      out[f] = body[f].trim();
    }
  }
  if (out.dPhase !== undefined) out.dPhase = normalizeDPhase(out.dPhase);
  if (!partial || out.name !== undefined) {
    if (!out.name) errors.push("Project name is required");
  }
  if (!partial || out.protocolId !== undefined) {
    if (!protocols[out.protocolId]) errors.push("A valid WSSP edition is required");
  }
  if (!partial || out.projectType !== undefined) {
    if (!PROJECT_TYPES.includes(out.projectType)) errors.push("A valid project type is required");
  }
  if (!partial || out.districtClass !== undefined) {
    if (!["I", "II"].includes(out.districtClass)) errors.push("District class must be I or II");
  }
  if (!partial || out.district !== undefined) {
    if (!out.district) errors.push("School district is required");
  }
  return { errors, out };
}

app.post("/api/projects", (req, res) => {
  if (!requireStaff(req, res)) return;
  const { errors, out } = validateProject(req.body || {});
  if (errors.length) return res.status(400).json({ errors });
  const now = new Date().toISOString();
  const project = {
    id: crypto.randomBytes(6).toString("hex"),
    ...out,
    credits: {},          // creditId -> { status: "yes"|"maybe"|"no", points: n }
    createdAt: now,
    updatedAt: now
  };
  projects.push(project);
  saveProjects();
  res.status(201).json(project);
});

function findProject(req, res) {
  const p = projects.find(p => p.id === req.params.id);
  if (!p) { res.status(404).json({ errors: ["Project not found"] }); return null; }
  return p;
}

app.get("/api/projects/:id", (req, res) => {
  if (!requireAccess(req, res, req.params.id)) return;
  const p = findProject(req, res);
  if (p) res.json(projectView(p, req));
});

app.put("/api/projects/:id", (req, res) => {
  if (!requireStaff(req, res)) return;
  const p = findProject(req, res);
  if (!p) return;
  const { errors, out } = validateProject(req.body || {}, { partial: true });
  if (errors.length) return res.status(400).json({ errors });
  // The protocol edition is locked once any credit has been marked, so a
  // scorecard filled against one edition can't silently switch to another.
  if (out.protocolId && out.protocolId !== p.protocolId && Object.keys(p.credits).length) {
    return res.status(400).json({ errors: [
      "The WSSP edition can't be changed once scorecard entries exist. Clear the scorecard first."
    ]});
  }
  Object.assign(p, out);
  p.updatedAt = new Date().toISOString();
  saveProjects();
  res.json(projectView(p, req));
});

app.put("/api/projects/:id/credits/:creditId", (req, res) => {
  if (!requireAccess(req, res, req.params.id)) return;
  const p = findProject(req, res);
  if (!p) return;
  const { status, points } = req.body || {};
  if (status === null || status === "none") {
    delete p.credits[req.params.creditId];
  } else {
    if (!["yes", "maybe", "no"].includes(status)) {
      return res.status(400).json({ errors: ["status must be yes, maybe, no, or none"] });
    }
    const entry = { status };
    if (points !== undefined && points !== null) {
      const n = Number(points);
      if (!Number.isInteger(n) || n < 0 || n > 99) {
        return res.status(400).json({ errors: ["points must be a whole number"] });
      }
      entry.points = n;
    }
    p.credits[req.params.creditId] = entry;
  }
  p.updatedAt = new Date().toISOString();
  saveProjects();
  res.json(projectView(p, req));
});

/* Per-credit notes, stored apart from status entries so clearing a
 * credit's Yes/Maybe/No never discards its notes. */
app.put("/api/projects/:id/credits/:creditId/note", (req, res) => {
  if (!requireAccess(req, res, req.params.id)) return;
  const p = findProject(req, res);
  if (!p) return;
  const text = req.body && typeof req.body.text === "string" ? req.body.text.trim() : "";
  if (!p.creditNotes) p.creditNotes = {};
  if (text) p.creditNotes[req.params.creditId] = text;
  else delete p.creditNotes[req.params.creditId];
  p.updatedAt = new Date().toISOString();
  saveProjects();
  res.json(projectView(p, req));
});

/* ── Credit documentation ────────────────────────────────────── *
 * Files live in data/files under random names; the original name and
 * which credit each file supports are recorded on the project. Documents
 * are kept separate from credit status entries, so clearing a credit's
 * Yes/Maybe/No never discards its uploaded evidence. */

function allDocuments(p) {
  return Object.values(p.documents || {}).flat();
}

app.post("/api/projects/:id/credits/:creditId/files", upload.single("file"), (req, res) => {
  if (!requireAccess(req, res, req.params.id)) return;
  const p = findProject(req, res);
  if (!p) return;
  if (!req.file) return res.status(400).json({ errors: ["No file received"] });
  if (!p.documents) p.documents = {};
  const list = p.documents[req.params.creditId] || (p.documents[req.params.creditId] = []);
  list.push({
    id: crypto.randomBytes(6).toString("hex"),
    name: req.file.originalname,
    size: req.file.size,
    storedName: req.file.filename,
    uploadedAt: new Date().toISOString()
  });
  p.updatedAt = new Date().toISOString();
  saveProjects();
  res.status(201).json(projectView(p, req));
});

app.get("/api/projects/:id/files/:fileId", (req, res) => {
  if (!requireAccess(req, res, req.params.id)) return;
  const p = findProject(req, res);
  if (!p) return;
  const doc = allDocuments(p).find(d => d.id === req.params.fileId);
  if (!doc) return res.status(404).json({ errors: ["File not found"] });
  res.download(path.join(FILES_DIR, doc.storedName), doc.name);
});

app.delete("/api/projects/:id/files/:fileId", (req, res) => {
  if (!requireStaff(req, res)) return;
  const p = findProject(req, res);
  if (!p) return;
  for (const [creditId, list] of Object.entries(p.documents || {})) {
    const idx = list.findIndex(d => d.id === req.params.fileId);
    if (idx !== -1) {
      const [doc] = list.splice(idx, 1);
      if (!list.length) delete p.documents[creditId];
      try { fs.unlinkSync(path.join(FILES_DIR, doc.storedName)); } catch (e) { /* already gone */ }
      p.updatedAt = new Date().toISOString();
      saveProjects();
      return res.json(projectView(p, req));
    }
  }
  res.status(404).json({ errors: ["File not found"] });
});

app.delete("/api/projects/:id", (req, res) => {
  if (!requireStaff(req, res)) return;
  const idx = projects.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ errors: ["Project not found"] });
  const [removed] = projects.splice(idx, 1);
  for (const doc of allDocuments(removed)) {
    try { fs.unlinkSync(path.join(FILES_DIR, doc.storedName)); } catch (e) { /* already gone */ }
  }
  saveProjects();
  res.json({ ok: true });
});

/* Multer errors (e.g. oversize uploads) arrive as thrown errors. */
app.use((err, req, res, next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ errors: ["File is larger than the 25 MB limit"] });
  }
  console.error(err);
  res.status(500).json({ errors: ["Unexpected server error"] });
});

/* ── Start ───────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`WSSP Tracker running at http://localhost:${PORT}`);
  console.log(`Data folder: ${DATA_DIR}`);
  console.log(`Protocols loaded: ${Object.keys(protocols).join(", ")}`);
  if (TRUST_EASY_AUTH) {
    console.log("Staff sign-in: Microsoft SSO (Azure Easy Auth)");
  } else {
    console.log(`Staff access code: ${STAFF_CODE}`);
    console.log(`  (stored in ${STAFF_CODE_FILE}; set STAFF_ACCESS_CODE env to override)`);
  }
});
