import { createHmac, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";

const STORE_NAME = "nstsf-dashboard";
const STATE_KEY = "state-v1";
const SESSION_COOKIE = "nstsf_session";
const AUTH_SECRET = Netlify.env.get("DASHBOARD_AUTH_SECRET") || "nstsf-auth-fallback-2026";

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

function authorize(request) {
  const cookies = parseCookies(request.headers.get("cookie") || "");
  const token = cookies[SESSION_COOKIE];
  if (!token) {
    return { ok: false, response: json({ ok: false, error: "unauthorized" }, 401) };
  }

  const idx = token.lastIndexOf(".");
  if (idx === -1) {
    return { ok: false, response: json({ ok: false, error: "unauthorized" }, 401) };
  }

  const payload = token.slice(0, idx);
  const signature = token.slice(idx + 1);
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, response: json({ ok: false, error: "unauthorized" }, 401) };
  }

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!session.exp || session.exp < Date.now()) {
      return { ok: false, response: json({ ok: false, error: "unauthorized" }, 401) };
    }
  } catch {
    return { ok: false, response: json({ ok: false, error: "unauthorized" }, 401) };
  }

  return { ok: true };
}

function store() {
  return getStore(STORE_NAME, { consistency: "strong" });
}

export default async (request) => {
  const auth = authorize(request);
  if (!auth.ok) return auth.response;

  if (request.method === "GET") {
    const entry = await store().getWithMetadata(STATE_KEY, { type: "json" });
    if (!entry) {
      return json({ ok: false, error: "no_state" }, 404);
    }

    return json({
      ok: true,
      etag: entry.etag,
      savedAt: entry.metadata?.savedAt || null,
      state: entry.data,
    });
  }

  if (request.method === "PUT") {
    let state;
    try {
      state = await request.json();
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400);
    }

    const savedAt = new Date().toISOString();
    const payload = {
      ...state,
      schema: state.schema || "nstsf-dashboard-state-v1",
      savedAt,
    };

    await store().setJSON(STATE_KEY, payload, { metadata: { savedAt } });
    return json({ ok: true, savedAt });
  }

  return json({ ok: false, error: "method_not_allowed" }, 405);
};

export const config = {
  path: "/api/state",
};
