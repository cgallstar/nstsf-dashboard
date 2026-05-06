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

function textValue(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function isReviewIssueText(value = "") {
  return /kunne ikke matches sikkert|kræver manuel match|matcher flere mulige sager|case_not_matched|invoice_match_low_confidence|invoice_match_ambiguous/i.test(String(value || ""));
}

function stripSyncStatusPrefix(value = "") {
  return textValue(value, "").replace(/^\s*(fejl|afklaring|arkiveret|opgave|opdatering|allerede arkiveret)\s*[·:-]\s*/i, "").trim();
}

function syncLogDedupeKey(entry) {
  const threadId = textValue(entry?.threadId, "");
  if (threadId) return `thread:${threadId}`;
  const archiveKey = textValue(entry?.archiveKey, "");
  if (archiveKey) return `archive:${archiveKey}`;
  const fileName = textValue(entry?.fileName, "");
  const caseId = textValue(entry?.caseId, "");
  if (fileName && caseId) return `file:${caseId}:${fileName}`;
  return [
    textValue(entry?.subject, "").toLowerCase(),
    textValue(entry?.documentType, "").toLowerCase(),
    textValue(entry?.category, "").toLowerCase(),
  ].join("|");
}

function sanitizeDashboardState(state) {
  if (!state || typeof state !== "object" || !Array.isArray(state.syncLog)) return { state, changed: 0 };
  let changed = 0;
  const seen = new Set();
  const syncLog = [];
  for (const entry of state.syncLog) {
    if (!entry) {
      changed += 1;
      continue;
    }
    const next = { ...entry };
    const originalSubject = textValue(next.subject, "");
    next.subject = stripSyncStatusPrefix(originalSubject);
    if (next.subject !== originalSubject) changed += 1;
    const reviewText = [next.error, next.notes, next.subject, next.documentType, next.category].map((value) => textValue(value, "")).join(" ");
    if (next.status === "error" && isReviewIssueText(reviewText)) {
      next.status = "needs_review";
      changed += 1;
    }
    const key = syncLogDedupeKey(next);
    if (seen.has(key)) {
      changed += 1;
      continue;
    }
    seen.add(key);
    syncLog.push(next);
  }
  if (syncLog.length > 80) changed += syncLog.length - 80;
  return {
    state: {
      ...state,
      syncLog: syncLog.slice(0, 80),
    },
    changed,
  };
}

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
    const sanitized = sanitizeDashboardState(entry.data);
    let savedAt = entry.metadata?.savedAt || null;
    if (sanitized.changed) {
      savedAt = new Date().toISOString();
      sanitized.state.savedAt = savedAt;
      sanitized.state.schema = sanitized.state.schema || "nstsf-dashboard-state-v1";
      await store().setJSON(STATE_KEY, sanitized.state, { metadata: { savedAt } });
    }

    return json({
      ok: true,
      etag: entry.etag,
      savedAt,
      sanitizedSyncLogEntries: sanitized.changed,
      state: sanitized.state,
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
    const sanitized = sanitizeDashboardState(state);
    const payload = {
      ...sanitized.state,
      schema: state.schema || "nstsf-dashboard-state-v1",
      savedAt,
    };

    await store().setJSON(STATE_KEY, payload, { metadata: { savedAt } });
    return json({ ok: true, savedAt, sanitizedSyncLogEntries: sanitized.changed });
  }

  return json({ ok: false, error: "method_not_allowed" }, 405);
};

export const config = {
  path: "/api/state",
};
