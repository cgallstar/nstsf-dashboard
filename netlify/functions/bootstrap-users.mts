import { getStore } from "@netlify/blobs";

const USER_STORE = "nstsf-dashboard-auth";
const USER_KEY = "users-v1";
const AUTH_SECRET = Netlify.env.get("DASHBOARD_AUTH_SECRET") || "";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

function normalizeUser(user) {
  return {
    email: String(user?.email || "").trim().toLowerCase(),
    name: String(user?.name || user?.email || "").trim(),
    role: String(user?.role || "user").trim() || "user",
    password: String(user?.password || ""),
  };
}

function parseEnvUsers() {
  const raw = Netlify.env.get("DASHBOARD_USERS_JSON");
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map(normalizeUser).filter((user) => user.email && user.password);
    }
  } catch {}

  return [];
}

function parseBody(request) {
  return request.json().catch(() => ({}));
}

export default async (request) => {
  if (request.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }

  if (!AUTH_SECRET) {
    return json({ ok: false, error: "missing_auth_secret" }, 500);
  }

  const body = await parseBody(request);
  const secret = String(body?.secret || "");
  if (secret !== AUTH_SECRET) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const users = parseEnvUsers();
  if (!users.length) {
    return json({ ok: false, error: "missing_users_env" }, 500);
  }

  const store = getStore(USER_STORE, { consistency: "strong" });
  await store.setJSON(USER_KEY, users);
  return json({
    ok: true,
    count: users.length,
    users: users.map(({ password, ...user }) => user),
  });
};

export const config = {
  path: "/api/bootstrap-users",
};
