import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
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

function primaryCustomerNumber(entry) {
  const raw = textValue(entry?.sid || entry?.nr, "").replace(/\s+/g, "");
  const match = raw.match(/^(\d+)/);
  return match ? match[1] : "";
}

function findCustomerCase(state, customerNumber = "") {
  const wanted = textValue(customerNumber, "").replace(/\D/g, "");
  return (Array.isArray(state?.sager) ? state.sager : []).find((entry) =>
    primaryCustomerNumber(entry) === wanted ||
    textValue(entry?.nr, "").replace(/\D/g, "") === wanted ||
    textValue(entry?.sid, "").replace(/\D/g, "") === wanted
  ) || null;
}

function ensureRuntimeCaseShape(entry) {
  entry.workflow = entry.workflow && typeof entry.workflow === "object" && !Array.isArray(entry.workflow) ? entry.workflow : {};
  entry.docs = entry.docs && typeof entry.docs === "object" && !Array.isArray(entry.docs) ? entry.docs : {};
  entry.docs.tilbud = Array.isArray(entry.docs.tilbud) ? entry.docs.tilbud : [];
  entry.activityLog = Array.isArray(entry.activityLog) ? entry.activityLog : [];
  return entry;
}

function pushUniqueDoc(target, doc) {
  const key = textValue(doc?.archiveKey, "") || [
    textValue(doc?.titel || doc?.title, "").toLowerCase().replace(/\s+/g, " ").trim(),
    textValue(doc?.dato || doc?.date, ""),
  ].join("|");
  if (target.some((item) => {
    const itemKey = textValue(item?.archiveKey, "") || [
      textValue(item?.titel || item?.title, "").toLowerCase().replace(/\s+/g, " ").trim(),
      textValue(item?.dato || item?.date, ""),
    ].join("|");
    return itemKey === key;
  })) return false;
  target.unshift(doc);
  return true;
}

function appendUniqueSyncLog(state, entry) {
  state.syncLog = Array.isArray(state.syncLog) ? state.syncLog : [];
  const archiveKey = textValue(entry?.archiveKey, "");
  const threadId = textValue(entry?.threadId, "");
  state.syncLog = state.syncLog.filter((item) =>
    (!archiveKey || textValue(item?.archiveKey, "") !== archiveKey) &&
    (!threadId || textValue(item?.threadId, "") !== threadId)
  );
  state.syncLog.unshift({
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    source: "state_migration",
    ...entry,
  });
  state.syncLog = state.syncLog.slice(0, 80);
}

function applyManualStateCorrections(state) {
  if (!state || typeof state !== "object") return 0;
  state.syncState = state.syncState && typeof state.syncState === "object" && !Array.isArray(state.syncState) ? state.syncState : {};
  state.syncState.migrations = state.syncState.migrations && typeof state.syncState.migrations === "object" && !Array.isArray(state.syncState.migrations) ? state.syncState.migrations : {};
  const migrationKey = "2026-05-09-k1013-overslagspris-tilbygning";
  if (state.syncState.migrations[migrationKey]) return 0;

  const threadId = "19da9fde83a10cdf";
  state.sager = Array.isArray(state.sager) ? state.sager : [];
  let matched = findCustomerCase(state, "1013");
  let changed = 0;
  if (!matched) {
    matched = {
      k: 4,
      sid: "1013a",
      nr: "1013",
      kunde: "Mikkel Munkholm Jensen",
      adr: "",
      opg: "Tilbygning",
      b: "1750000",
      u: "0",
      dato: "",
      status: "Tilbud sendt",
      sort: state.sager.length,
      workflow: {},
      docs: {},
      activityLog: [],
    };
    state.sager.push(matched);
    changed += 1;
  }
  ensureRuntimeCaseShape(matched);
  const before = JSON.stringify({
    k: matched.k,
    status: matched.status,
    b: matched.b,
    workflow: matched.workflow,
    docs: matched.docs.tilbud,
  });
  matched.k = 4;
  matched.status = "Tilbud sendt";
  matched.b = "1750000";
  matched.workflow.offerDate = textValue(matched.workflow.offerDate, "2026-04-20");
  matched.workflow.latestOfferDate = "2026-05-07";
  matched.workflow.currentStage = "Tilbud sendt";
  matched.workflow.nextAction = textValue(matched.workflow.nextAction, "Afventer kundens tilbagemelding på overslagspris.");
  matched.workflow.enterpriseUpdatedAt = "2026-05-07";
  pushUniqueDoc(matched.docs.tilbud, {
    titel: "2026-05-07 - 1013 A - Revideret overslagspris på tilbygning",
    dato: "2026-05-07",
    url: "https://mail.google.com/mail/#all/19e0254a05536bf1",
    fileName: "2026-05-07 - 1013 A - Revideret overslagspris på tilbygning.md",
    mimeType: "text/markdown",
    notes: "Manuelt registreret fra Gmail-tråden Re: Overslagspris på tilbygning. Seneste overslagspris: 1.375.000 - 1.750.000 kr. inkl. moms.",
    threadId,
    archiveKey: migrationKey,
  });
  if (!matched.activityLog.some((item) => textValue(item?.archiveKey, "") === migrationKey)) {
    matched.activityLog.unshift({
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      type: "case_update",
      archiveKey: migrationKey,
      threadId,
      title: "Tilbud registreret manuelt",
      summary: "Overslagspris på tilbygning er registreret på K-1013.",
      notes: "Status sat til Tilbud sendt. Est. entreprisesum sat til 1.750.000 kr. inkl. moms fra seneste overslagspris.",
    });
  }
  state.syncState.manualReviewResolutions = state.syncState.manualReviewResolutions && typeof state.syncState.manualReviewResolutions === "object" && !Array.isArray(state.syncState.manualReviewResolutions) ? state.syncState.manualReviewResolutions : {};
  state.syncState.threadLedger = state.syncState.threadLedger && typeof state.syncState.threadLedger === "object" && !Array.isArray(state.syncState.threadLedger) ? state.syncState.threadLedger : {};
  state.syncState.processedThreadHistory = state.syncState.processedThreadHistory && typeof state.syncState.processedThreadHistory === "object" && !Array.isArray(state.syncState.processedThreadHistory) ? state.syncState.processedThreadHistory : {};
  state.syncState.gmailQueue = Array.isArray(state.syncState.gmailQueue) ? state.syncState.gmailQueue : [];
  state.syncState.manualReviewResolutions[threadId] = {
    action: "match_case",
    caseId: "1013 A",
    customerName: textValue(matched.kunde, ""),
    createdAt: new Date().toISOString(),
    reason: "Manuel korrektion: Overslagspris på tilbygning hører til K-1013.",
  };
  delete state.syncState.threadLedger[threadId];
  delete state.syncState.processedThreadHistory[threadId];
  if (!state.syncState.gmailQueue.some((item) => textValue(item?.id, "") === threadId)) {
    state.syncState.gmailQueue.unshift({
      id: threadId,
      historyId: "",
      lane: "archive",
      priority: 95,
      attempts: 0,
      discoveredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      reason: "Manuel korrektion: arkivér tilbud på K-1013.",
    });
  }
  appendUniqueSyncLog(state, {
    status: "updated",
    archiveKey: migrationKey,
    threadId,
    subject: "Overslagspris på tilbygning",
    customerName: textValue(matched.kunde, "K-1013"),
    caseId: "1013 A",
    documentType: "Tilbud",
    documentDate: "2026-05-07",
    category: "tilbud",
    fileName: "2026-05-07 - 1013 A - Revideret overslagspris på tilbygning.md",
    driveUrl: "https://mail.google.com/mail/#all/19e0254a05536bf1",
    notes: "K-1013 er manuelt opdateret til Tilbud sendt med est. entreprisesum 1.750.000 kr. inkl. moms. Gmail-tråden er køet til Drive-arkivering.",
  });
  const after = JSON.stringify({
    k: matched.k,
    status: matched.status,
    b: matched.b,
    workflow: matched.workflow,
    docs: matched.docs.tilbud,
  });
  if (after !== before) changed += 1;
  state.syncState.migrations[migrationKey] = {
    appliedAt: new Date().toISOString(),
    caseId: "1013 A",
    threadId,
  };
  return changed + 1;
}

function sanitizeDashboardState(state) {
  if (!state || typeof state !== "object") return { state, changed: 0 };
  let changed = 0;
  changed += applyManualStateCorrections(state);
  state.syncLog = Array.isArray(state.syncLog) ? state.syncLog : [];
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
