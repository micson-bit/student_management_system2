"use strict";

// Node 22.13+ provides SQLite through node:sqlite. The database is created in
// ./data so it is kept separate from the static application files.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { DatabaseSync } = require("node:sqlite");

const scrypt = promisify(crypto.scrypt);
const root = __dirname;
const dataDirectory = path.join(root, "data");
fs.mkdirSync(dataDirectory, { recursive: true });
const db = new DatabaseSync(path.join(dataDirectory, "attendly.sqlite"));
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('student','coordinator','administrator')),
    password_hash TEXT NOT NULL,
    activated INTEGER NOT NULL DEFAULT 1 CHECK (activated IN (0,1)),
    joined_at TEXT NOT NULL DEFAULT (date('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS attendance (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'present' CHECK (status = 'present'),
    timestamp TEXT NOT NULL,
    PRIMARY KEY (user_id, day)
  );
  CREATE INDEX IF NOT EXISTS attendance_day_idx ON attendance(day);
`);
if (!db.prepare("PRAGMA table_info(users)").all().some((column) => column.name === "activated")) {
  db.exec("ALTER TABLE users ADD COLUMN activated INTEGER NOT NULL DEFAULT 1");
}
db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());

// Optional first administrator, configured through environment variables.
// Never place an initial password in source control.
if (process.env.ADMIN_EMAIL && process.env.ADMIN_NAME && process.env.ADMIN_PASSWORD) {
  const existingAdmin = db.prepare("SELECT id FROM users WHERE role='administrator' LIMIT 1").get();
  if (!existingAdmin) {
    if (process.env.ADMIN_PASSWORD.length < 12) throw new Error("ADMIN_PASSWORD must be at least 12 characters.");
    // Persist the salt with the derived key, as for regular accounts.
    const salt = crypto.randomBytes(16).toString("hex");
    const secureHash = crypto.scryptSync(process.env.ADMIN_PASSWORD, salt, 64).toString("hex");
    db.prepare("INSERT INTO users(email,name,role,password_hash) VALUES(?,?,'administrator',?)").run(process.env.ADMIN_EMAIL.toLowerCase(), process.env.ADMIN_NAME, `${salt}:${secureHash}`);
  }
}

const roles = new Set(["student", "coordinator", "administrator"]);
const permissions = {
  student: new Set(["attendance:self:read", "attendance:self:checkin"]),
  coordinator: new Set(["attendance:self:read", "attendance:self:checkin", "attendance:school:read", "roster:read", "roster:create"]),
  administrator: new Set(["attendance:self:read", "attendance:self:checkin", "attendance:school:read", "roster:read", "roster:create", "users:create", "users:assign-staff-role"])
};
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };

function send(res, status, value, extraHeaders = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders });
  res.end(JSON.stringify(value));
}
function cookieOptions(token, maxAge) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `attendly_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}
function getCookie(req, name) {
  const item = (req.headers.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return item ? item.slice(name.length + 1) : "";
}
async function body(req) {
  let input = "";
  for await (const chunk of req) {
    input += chunk;
    if (input.length > 32_768) throw Object.assign(new Error("Request body too large."), { status: 413 });
  }
  try { return input ? JSON.parse(input) : {}; }
  catch { throw Object.assign(new Error("Invalid JSON body."), { status: 400 }); }
}
function requirePermission(user, permission) {
  if (!user) throw Object.assign(new Error("Sign in to continue."), { status: 401 });
  if (!permissions[user.role]?.has(permission)) throw Object.assign(new Error("Your role cannot perform this action."), { status: 403 });
}
async function currentUser(req) {
  const token = getCookie(req, "attendly_session");
  if (!token) return null;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const row = db.prepare(`SELECT users.id, users.email, users.name, users.role FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?`).get(tokenHash, Date.now());
  return row || null;
}
async function createSession(user, res) {
  const token = crypto.randomBytes(32).toString("base64url");
  const lifetime = 7 * 24 * 60 * 60 * 1000;
  db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)").run(crypto.createHash("sha256").update(token).digest("hex"), user.id, Date.now() + lifetime);
  res.setHeader("Set-Cookie", cookieOptions(token, lifetime / 1000));
}
async function passwordHash(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = await scrypt(password, salt, 64);
  return `${salt}:${Buffer.from(derived).toString("hex")}`;
}
async function passwordMatches(password, saved) {
  const [salt, expectedHex] = saved.split(":");
  const expected = Buffer.from(expectedHex, "hex");
  const actual = Buffer.from(await scrypt(password, salt, expected.length));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function dateToday() { return new Date().toISOString().slice(0, 10); }
function csvSafe(value) { return String(value).trim(); }

async function api(req, res, url) {
  const user = await currentUser(req);
  if (req.method === "GET" && url.pathname === "/api/auth/me") return send(res, 200, { user });

  if (req.method === "POST" && url.pathname === "/api/auth/signup") {
    const input = await body(req);
    const email = csvSafe(input.email || "").toLowerCase();
    const name = csvSafe(input.name || "");
    if (input.role !== "student") return send(res, 403, { error: "Coordinator and administrator accounts must be created by an administrator." });
    if (name.length < 2 || !/^\S+@\S+\.\S+$/.test(email) || typeof input.password !== "string" || input.password.length < 8) return send(res, 400, { error: "Enter a valid name, school email, and password of at least 8 characters." });
    const hash = await passwordHash(input.password);
    const existing = db.prepare("SELECT id,role,activated FROM users WHERE email = ? COLLATE NOCASE").get(email);
    if (existing && (existing.role !== "student" || existing.activated)) return send(res, 409, { error: "An account with that email already exists. Sign in instead." });
    const result = existing
      ? db.prepare("UPDATE users SET name=?,password_hash=?,activated=1 WHERE id=?").run(name, hash, existing.id)
      : db.prepare("INSERT INTO users(email,name,role,password_hash,joined_at) VALUES(?,?,'student',?,?)").run(email, name, hash, dateToday());
    const id = existing ? existing.id : result.lastInsertRowid;
    const account = db.prepare("SELECT id,email,name,role FROM users WHERE id = ?").get(id);
    await createSession(account, res);
    return send(res, 201, { user: account });
  }
  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const input = await body(req);
    const email = csvSafe(input.email || "").toLowerCase();
    const account = db.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE AND activated=1").get(email);
    if (!account || !await passwordMatches(String(input.password || ""), account.password_hash)) return send(res, 401, { error: "Email or password is incorrect." });
    if (input.role && account.role !== input.role) return send(res, 403, { error: "Choose the role assigned to your account." });
    const publicUser = { id: account.id, email: account.email, name: account.name, role: account.role };
    await createSession(publicUser, res);
    return send(res, 200, { user: publicUser });
  }
  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    const token = getCookie(req, "attendly_session");
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(crypto.createHash("sha256").update(token).digest("hex"));
    return send(res, 200, { ok: true }, { "Set-Cookie": cookieOptions("", 0) });
  }

  if (req.method === "GET" && url.pathname === "/api/roster") {
    requirePermission(user, "roster:read");
    const rows = db.prepare(`SELECT users.id,users.email,users.name,users.joined_at AS joinedAt,
      COUNT(attendance.day) AS presentDays, MAX(attendance.day) AS lastDay,
      (SELECT timestamp FROM attendance a WHERE a.user_id=users.id ORDER BY a.day DESC LIMIT 1) AS lastTimestamp,
      (SELECT timestamp FROM attendance a WHERE a.user_id=users.id AND a.day=?) AS todayTimestamp
      FROM users LEFT JOIN attendance ON attendance.user_id=users.id
      WHERE users.role='student' GROUP BY users.id ORDER BY users.name COLLATE NOCASE`).all(dateToday());
    const today = dateToday();
    return send(res, 200, { students: rows.map((row) => ({ ...row, lastCheckIn: row.lastTimestamp, todayStatus: row.todayTimestamp ? "present" : "absent", absentDays: Math.max(0, Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${row.joinedAt}T00:00:00Z`)) / 86400000) + 1 - row.presentDays) })) });
  }
  if (req.method === "POST" && url.pathname === "/api/roster") {
    requirePermission(user, "roster:create");
    const input = await body(req);
    const name = csvSafe(input.name || "");
    const email = csvSafe(input.email || "").toLowerCase();
    if (name.length < 2 || !/^\S+@\S+\.\S+$/.test(email)) return send(res, 400, { error: "Enter a valid name and school email." });
    if (db.prepare("SELECT id FROM users WHERE email=? COLLATE NOCASE").get(email)) return send(res, 409, { error: "This student is already on the roster." });
    const password = crypto.randomBytes(24).toString("base64url");
    const result = await passwordHash(password);
    const created = db.prepare("INSERT INTO users(email,name,role,password_hash,activated,joined_at) VALUES(?,?,'student',?,0,?)").run(email, name, result, dateToday());
    return send(res, 201, { student: db.prepare("SELECT id,email,name,joined_at AS joinedAt FROM users WHERE id=?").get(created.lastInsertRowid) });
  }
  if (req.method === "POST" && url.pathname === "/api/admin/users") {
    requirePermission(user, "users:assign-staff-role");
    const input = await body(req);
    const email = csvSafe(input.email || "").toLowerCase();
    const name = csvSafe(input.name || "");
    const role = input.role;
    if (!roles.has(role) || role === "student" || name.length < 2 || !/^\S+@\S+\.\S+$/.test(email) || typeof input.password !== "string" || input.password.length < 12) return send(res, 400, { error: "Provide a valid name, email, staff role, and password of at least 12 characters." });
    if (db.prepare("SELECT id FROM users WHERE email=? COLLATE NOCASE").get(email)) return send(res, 409, { error: "An account with that email already exists." });
    const hash = await passwordHash(input.password);
    const result = db.prepare("INSERT INTO users(email,name,role,password_hash,joined_at) VALUES(?,?,?,?,?)").run(email, name, role, hash, dateToday());
    return send(res, 201, { user: db.prepare("SELECT id,email,name,role FROM users WHERE id=?").get(result.lastInsertRowid) });
  }
  if (req.method === "GET" && url.pathname === "/api/attendance") {
    requirePermission(user, "attendance:self:read");
    if (url.searchParams.get("scope") === "school") requirePermission(user, "attendance:school:read");
    const rows = url.searchParams.get("scope") === "school"
      ? db.prepare("SELECT users.email,attendance.day,attendance.status,attendance.timestamp FROM attendance JOIN users ON users.id=attendance.user_id WHERE users.role='student'").all()
      : db.prepare("SELECT day,status,timestamp FROM attendance WHERE user_id=?").all(user.id);
    return send(res, 200, { records: rows });
  }
  if (req.method === "POST" && url.pathname === "/api/attendance/checkin") {
    requirePermission(user, "attendance:self:checkin");
    const now = new Date();
    const day = dateToday();
    db.prepare("INSERT INTO attendance(user_id,day,timestamp) VALUES(?,?,?) ON CONFLICT(user_id,day) DO NOTHING").run(user.id, day, now.toISOString());
    return send(res, 200, { day, status: "present", timestamp: db.prepare("SELECT timestamp FROM attendance WHERE user_id=? AND day=?").get(user.id, day).timestamp });
  }
  return send(res, 404, { error: "API route not found." });
}

async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Method not allowed." });
    const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const target = path.resolve(root, `.${requested}`);
    if (!target.startsWith(`${root}${path.sep}`) || !fs.existsSync(target) || !fs.statSync(target).isFile()) return send(res, 404, { error: "Not found." });
    res.writeHead(200, { "Content-Type": mime[path.extname(target)] || "application/octet-stream", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin" });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(target).pipe(res);
  } catch (error) {
    if (res.headersSent) return res.destroy(error);
    send(res, error.status || 500, { error: error.status ? error.message : "The server could not complete that request." });
    if (!error.status) console.error(error);
  }
}

const port = Number(process.env.PORT || 3000);
http.createServer(handler).listen(port, () => console.log(`Attendly running at http://localhost:${port}`));
