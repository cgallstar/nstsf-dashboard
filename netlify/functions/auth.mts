import { createHmac, timingSafeEqual } from "node:crypto";

const SESSION_COOKIE = "nstsf_session";
const AUTH_SECRET = Netlify.env.get("DASHBOARD_AUTH_SECRET") || "nstsf-auth-fallback-2026";
const DEFAULT_PASSWORD = "NSTSF-Login-2026!";

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
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

function buildCookie(value, maxAge) {
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function clearCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function getUsers() {
  const raw = Netlify.env.get("DASHBOARD_USERS_JSON");
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }

  return [
    { email: "christian@nstsf.dk", name: "Christian", role: "admin", password: DEFAULT_PASSWORD },
    { email: "cgallstar@gmail.com", name: "Christian", role: "admin", password: DEFAULT_PASSWORD },
    { email: "smg@nstsf.dk", name: "SMG", role: "admin", password: DEFAULT_PASSWORD },
  ];
}

function sanitizeUser(user) {
  return { email: user.email, name: user.name || user.email, role: user.role || "user" };
}

function createSession(user) {
  const session = {
    ...sanitizeUser(user),
    exp: Date.now() + 1000 * 60 * 60 * 24 * 30,
  };
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  return `${payload}.${sign(payload)}`;
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
    return session;
  } catch {
    return null;
  }
}

export default async (request) => {
  if (request.method === "GET") {
    const session = readSession(request);
    if (!session) return json({ ok: false, error: "unauthorized" }, 401);
    return json({ ok: true, user: sanitizeUser(session) });
  }

  if (request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400);
    }

    const email = String(body?.email || "").trim().toLowerCase();
    const password = String(body?.password || "");
    const user = getUsers().find((entry) => String(entry.email || "").trim().toLowerCase() === email && String(entry.password || "") === password);

    if (!user) return json({ ok: false, error: "invalid_credentials" }, 401);

    return json(
      { ok: true, user: sanitizeUser(user) },
      200,
      { "set-cookie": buildCookie(createSession(user), 60 * 60 * 24 * 30) },
    );
  }

  if (request.method === "DELETE") {
    return json({ ok: true }, 200, { "set-cookie": clearCookie() });
  }

  return json({ ok: false, error: "method_not_allowed" }, 405);
};

export const config = {
  path: "/api/auth",
};
