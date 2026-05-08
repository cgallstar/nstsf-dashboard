import { randomUUID } from "node:crypto";
import {
  appendActivity,
  authorizeDashboardRequest,
  json,
  loadDashboardState,
  normalizeInternalTask,
  saveDashboardState,
  textValue,
} from "./_lib/dashboard.mts";
import { archiveThreadToCase } from "./gmail-sync.mts";

function ensureSyncState(state: any) {
  state.syncState = state.syncState && typeof state.syncState === "object" && !Array.isArray(state.syncState) ? state.syncState : {};
  state.syncState.reviewQueue = Array.isArray(state.syncState.reviewQueue) ? state.syncState.reviewQueue : [];
  state.syncState.manualReviewResolutions = state.syncState.manualReviewResolutions && typeof state.syncState.manualReviewResolutions === "object" && !Array.isArray(state.syncState.manualReviewResolutions)
    ? state.syncState.manualReviewResolutions
    : {};
  state.syncState.threadLedger = state.syncState.threadLedger && typeof state.syncState.threadLedger === "object" && !Array.isArray(state.syncState.threadLedger)
    ? state.syncState.threadLedger
    : {};
  state.syncState.processedThreadHistory = state.syncState.processedThreadHistory && typeof state.syncState.processedThreadHistory === "object" && !Array.isArray(state.syncState.processedThreadHistory)
    ? state.syncState.processedThreadHistory
    : {};
  return state.syncState;
}

function reviewKey(item: any) {
  const threadId = textValue(item?.threadId, "");
  if (threadId) return `thread:${threadId}`;
  const archiveKey = textValue(item?.archiveKey, "");
  if (archiveKey) return `archive:${archiveKey}`;
  return [
    textValue(item?.subject, "").toLowerCase(),
    textValue(item?.documentType, "").toLowerCase(),
    textValue(item?.category, "").toLowerCase(),
  ].join("|");
}

function findReviewItem(syncState: any, body: any) {
  const wanted = textValue(body?.reviewKey, "");
  const threadId = textValue(body?.threadId, "");
  const archiveKey = textValue(body?.archiveKey, "");
  return syncState.reviewQueue.find((item: any) => {
    if (wanted && reviewKey(item) === wanted) return true;
    if (threadId && textValue(item?.threadId, "") === threadId) return true;
    if (archiveKey && textValue(item?.archiveKey, "") === archiveKey) return true;
    return false;
  }) || null;
}

function primaryCaseNumber(entry: any) {
  const raw = textValue(entry?.sid || entry?.nr, "").replace(/\s+/g, "");
  return raw.match(/^(\d+)/)?.[1] || "";
}

function findCaseByRef(state: any, ref = "") {
  const raw = textValue(ref, "").trim();
  const compact = raw.replace(/\s+/g, "").replace(/^[KS]-/i, "").toLowerCase();
  if (!compact) return null;
  const customer = raw.match(/^K-?(\d+)$/i)?.[1] || "";
  const sag = raw.match(/^S-?(\d+)$/i)?.[1] || "";
  const all = Array.isArray(state?.sager) ? state.sager : [];
  if (customer) return all.find((entry: any) => primaryCaseNumber(entry) === customer) || null;
  if (sag) return all.find((entry: any) => textValue(entry?.sagId, "").replace(/^S-/i, "") === sag) || null;
  return all.find((entry: any) => textValue(entry?.sid || entry?.nr, "").replace(/\s+/g, "").toLowerCase() === compact) || null;
}

function appendSyncLog(state: any, payload: any) {
  state.syncLog = Array.isArray(state.syncLog) ? state.syncLog : [];
  const threadId = textValue(payload?.threadId, "");
  const archiveKey = textValue(payload?.archiveKey, "");
  if (threadId) state.syncLog = state.syncLog.filter((entry: any) => textValue(entry?.threadId, "") !== threadId);
  if (archiveKey) state.syncLog = state.syncLog.filter((entry: any) => textValue(entry?.archiveKey, "") !== archiveKey);
  state.syncLog.unshift({
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    source: "review_action",
    ...payload,
  });
  state.syncLog = state.syncLog.slice(0, 80);
}

function closeReview(syncState: any, item: any, status: string, payload: any = {}) {
  const key = reviewKey(item);
  syncState.reviewQueue = syncState.reviewQueue.map((entry: any) => {
    if (reviewKey(entry) !== key) return entry;
    return {
      ...entry,
      ...payload,
      status,
      updatedAt: new Date().toISOString(),
      resolvedAt: status === "resolved" || status === "ignored" ? new Date().toISOString() : textValue(entry?.resolvedAt, ""),
    };
  });
}

export default async (request: Request) => {
  const auth = authorizeDashboardRequest(request);
  if (!auth.ok) return auth.response;
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const action = textValue(body?.action, "");
  const state = await loadDashboardState();
  if (!state) return json({ ok: false, error: "no_state" }, 404);
  const syncState = ensureSyncState(state);
  const item = findReviewItem(syncState, body);

  const threadId = textValue(item?.threadId || body.threadId, "");
  if (!item && action !== "archive_to_case") return json({ ok: false, error: "review_item_not_found" }, 404);
  if (!threadId) return json({ ok: false, error: "thread_id_missing" }, 400);
  const subject = textValue(item?.subject || body.subject, "Mailtråd");
  const caseRef = textValue(body.caseId || body.caseRef, "");

  if (action === "ignore") {
    closeReview(syncState, item, "ignored");
    if (threadId) {
      syncState.threadLedger[threadId] = {
        ...(syncState.threadLedger[threadId] || {}),
        threadId,
        status: "ignored",
        reason: "Manuelt ignoreret fra review queue.",
        updatedAt: new Date().toISOString(),
      };
    }
    appendSyncLog(state, {
      status: "skipped",
      threadId,
      subject,
      documentType: textValue(item.documentType, ""),
      category: textValue(item.category, ""),
      notes: "Afklaringen er manuelt ignoreret.",
    });
  } else if (action === "create_task") {
    state.internalTasks = Array.isArray(state.internalTasks) ? state.internalTasks : [];
    const task = normalizeInternalTask({
      id: `review-task-${threadId || Date.now()}`,
      title: subject,
      notes: textValue(item.notes || item.error, "Kræver opfølgning."),
      source: "review_queue",
      threadId,
      bucket: "week",
      domain: "arbejde",
      owner: "Søren",
      createdAt: new Date().toISOString(),
    });
    if (!state.internalTasks.some((entry: any) => textValue(entry?.id, "") === task.id || (threadId && textValue(entry?.threadId, "") === threadId))) {
      state.internalTasks.unshift(task);
    }
    closeReview(syncState, item, "resolved", { actionTaken: "created_task" });
    appendSyncLog(state, {
      status: "task_created",
      threadId,
      subject,
      documentType: "Opgave",
      category: "sager",
      notes: "Afklaringen er oprettet som intern opgave.",
    });
  } else if (action === "match_case") {
    const matched = findCaseByRef(state, caseRef);
    if (!matched) return json({ ok: false, error: "case_not_found" }, 400);
    const displayCaseId = textValue(matched.sid || matched.nr, caseRef);
    syncState.manualReviewResolutions[threadId || reviewKey(item)] = {
      action: "match_case",
      caseId: displayCaseId,
      customerName: textValue(matched.kunde, ""),
      createdAt: new Date().toISOString(),
      actor: auth.actor,
    };
    if (threadId) {
      delete syncState.threadLedger[threadId];
      delete syncState.processedThreadHistory[threadId];
      syncState.gmailQueue = Array.isArray(syncState.gmailQueue) ? syncState.gmailQueue.filter((entry: any) => textValue(entry?.id, "") !== threadId) : [];
      syncState.gmailQueue.unshift({
        id: threadId,
        lane: "archive",
        priority: 120,
        discoveredAt: new Date().toISOString(),
        reason: "Manuelt matchet fra review queue.",
      });
    }
    closeReview(syncState, item, "resolved", {
      actionTaken: "matched_case",
      caseId: displayCaseId,
      customerName: textValue(matched.kunde, ""),
    });
    appendActivity(matched, auth.actor, {
      type: "case_update",
      summary: `Mailtråd manuelt matchet til sagen: ${subject}`,
      threadId,
    });
    appendSyncLog(state, {
      status: "updated",
      threadId,
      subject,
      customerName: textValue(matched.kunde, ""),
      caseId: displayCaseId,
      documentType: textValue(item.documentType, ""),
      category: textValue(item.category, ""),
      notes: "Afklaringen er matchet til sagen. Næste Opdatér Sager arkiverer den med dette match.",
    });
  } else if (action === "archive_to_case") {
    const matched = findCaseByRef(state, caseRef);
    if (!matched) return json({ ok: false, error: "case_not_found" }, 400);
    const result = await archiveThreadToCase(state, { threadId, caseId: caseRef }, auth.actor);
    if (!result?.ok) return json({ ok: false, error: result?.error || "archive_failed", result }, 400);
    if (item) {
      closeReview(syncState, item, "resolved", {
        actionTaken: "archived_to_case",
        caseId: textValue(result.matchedCaseId || matched.sid || matched.nr, caseRef),
        customerName: textValue(matched.kunde, ""),
        driveUrl: textValue(result.driveUrl, ""),
      });
    }
  } else if (action === "resolve") {
    closeReview(syncState, item, "resolved");
    appendSyncLog(state, {
      status: "updated",
      threadId,
      subject,
      documentType: textValue(item.documentType, ""),
      category: textValue(item.category, ""),
      notes: "Afklaringen er markeret løst.",
    });
  } else {
    return json({ ok: false, error: "unknown_action" }, 400);
  }

  const savedAt = await saveDashboardState(state);
  return json({ ok: true, savedAt, action });
};

export const config = {
  path: "/api/review-action",
  maxDuration: 10,
};
