import { createHmac, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";

const SESSION_COOKIE = "nstsf_session";
const AUTH_SECRET = Netlify.env.get("DASHBOARD_AUTH_SECRET") || "";
const USER_STORE = "nstsf-dashboard-auth";
const USER_KEY = "users-v1";
const AUDIT_KEY = "user-audit-v1";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const idx = part.indexOf("=");
        return idx === -1 ? [part, ""] : [part.slice(0, idx), decodeURIComponent(part.slice(idx + 1))];
      }),
  );
}

function sign(value) {
  return createHmac("sha256", AUTH_SECRET).update(value).digest("base64url");
}

function sanitizeUser(user) {
  return {
    email: String(user?.email || "").trim().toLowerCase(),
    name: String(user?.name || user?.email || "").trim(),
    role: String(user?.role || "user").trim() || "user",
  };
}

function normalizeStoredUser(user) {
  return {
    ...sanitizeUser(user),
    password: String(user?.password || ""),
  };
}

function parseEnvUsers() {
  const raw = Netlify.env.get("DASHBOARD_USERS_JSON");
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length) {
      return parsed.map(normalizeStoredUser).filter((user) => user.email && user.password);
    }
  } catch {}

  return null;
}

function store() {
  return getStore(USER_STORE, { consistency: "strong" });
}

async function getUsers() {
  const saved = await store().get(USER_KEY, { type: "json" });
  if (Array.isArray(saved) && saved.length) {
    return saved.map(normalizeStoredUser).filter((user) => user.email && user.password);
  }

  const seeded = parseEnvUsers();
  if (seeded?.length) {
    await store().setJSON(USER_KEY, seeded);
    return seeded.map(normalizeStoredUser);
  }

  return [];
}

async function saveUsers(users) {
  const normalized = users.map(normalizeStoredUser).filter((user) => user.email && user.password);
  await store().setJSON(USER_KEY, normalized);
  return normalized;
}

async function appendAudit(actor, action, target, details = {}) {
  const current = await store().get(AUDIT_KEY, { type: "json" });
  const entries = Array.isArray(current) ? current : [];
  entries.unshift({
    at: new Date().toISOString(),
    actor: sanitizeUser(actor),
    action,
    target,
    details,
  });
  await store().setJSON(AUDIT_KEY, entries.slice(0, 100));
}

async function getAuditEntries() {
  const current = await store().get(AUDIT_KEY, { type: "json" });
  return Array.isArray(current) ? current : [];
}

function readSession(request) {
  const cookies = parseCookies(request.headers.get("cookie") || "");
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;

  const idx = token.lastIndexOf(".");
  if (idx === -1) return null;
  const payload = token.slice(0, idx);
  const signature = token.slice(idx + 1);
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!session.exp || session.exp < Date.now()) return null;
    return sanitizeUser(session);
  } catch {
    return null;
  }
}

function requireAdmin(request) {
  const session = readSession(request);
  if (!session) return { ok: false, response: json({ ok: false, error: "unauthorized" }, 401) };
  if (session.role !== "admin") return { ok: false, response: json({ ok: false, error: "forbidden" }, 403) };
  return { ok: true, session };
}

function safeList(users) {
  return users.map(sanitizeUser);
}

export default async (request) => {
  if (!AUTH_SECRET) {
    return json({ ok: false, error: "missing_auth_secret" }, 500);
  }

  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  if (request.method === "GET") {
    const users = await getUsers();
    return json({ ok: true, users: safeList(users), audit: await getAuditEntries() });
  }

  if (request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400);
    }

    const email = String(body?.email || "").trim().toLowerCase();
    const name = String(body?.name || "").trim();
    const password = String(body?.password || "");
    const role = String(body?.role || "user").trim() || "user";
    if (!email || !password) return json({ ok: false, error: "missing_fields" }, 400);

    const users = await getUsers();
    if (users.some((user) => user.email === email)) return json({ ok: false, error: "email_exists" }, 409);

    users.push({ email, name: name || email, password, role });
    const saved = await saveUsers(users);
    await appendAudit(auth.session, "create_user", email, { role, name: name || email });
    return json({ ok: true, users: safeList(saved), audit: await getAuditEntries() });
  }

  if (request.method === "PUT") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400);
    }

    const email = String(body?.email || "").trim().toLowerCase();
    if (!email) return json({ ok: false, error: "missing_email" }, 400);

    const users = await getUsers();
    const idx = users.findIndex((user) => user.email === email);
    if (idx === -1) return json({ ok: false, error: "not_found" }, 404);

    const existing = users[idx];
    const next = {
      ...existing,
      name: body?.name !== undefined ? String(body.name || "").trim() || email : existing.name,
      role: body?.role !== undefined ? String(body.role || "user").trim() || "user" : existing.role,
      password: body?.password ? String(body.password) : existing.password,
    };

    users[idx] = next;
    if (!users.some((user) => user.role === "admin")) return json({ ok: false, error: "admin_required" }, 400);

    const saved = await saveUsers(users);
    await appendAudit(auth.session, "update_user", email, {
      role: next.role,
      name: next.name,
      passwordChanged: Boolean(body?.password),
    });
    return json({ ok: true, users: safeList(saved), audit: await getAuditEntries() });
  }

  if (request.method === "DELETE") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400);
    }

    const email = String(body?.email || "").trim().toLowerCase();
    if (!email) return json({ ok: false, error: "missing_email" }, 400);

    const users = await getUsers();
    const next = users.filter((user) => user.email !== email);
    if (next.length === users.length) return json({ ok: false, error: "not_found" }, 404);
    if (!next.some((user) => user.role === "admin")) return json({ ok: false, error: "admin_required" }, 400);

    const saved = await saveUsers(next);
    await appendAudit(auth.session, "delete_user", email);
    return json({ ok: true, users: safeList(saved), audit: await getAuditEntries() });
  }

  return json({ ok: false, error: "method_not_allowed" }, 405);
};

export const config = {
  path: "/api/users",
};