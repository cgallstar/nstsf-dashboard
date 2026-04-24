import { getStore } from "@netlify/blobs";

const STORE_NAME = "nstsf-dashboard";
const STATE_KEY = "state-v1";
const FALLBACK_TOKEN = "NSTSF-2026-sync-8Qm2Lr7vK9pX";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const env = (name) => Netlify.env.get(name) || "";

function authorize(request) {
  const expected = env("DASHBOARD_TOKEN") || FALLBACK_TOKEN;

  const received = request.headers.get("x-dashboard-token") || "";
  if (received !== expected) {
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
