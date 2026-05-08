import { randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";

import {
  appendActivity,
  authorizeDashboardRequest,
  ensureCaseShape,
  json,
  loadDashboardState,
  normalizeInternalTask,
  pushDocs,
  saveDashboardState,
  textValue,
} from "./_lib/dashboard.mts";
import {
  ensureCaseDriveFolders,
  findDriveFileByName,
  getGmailAttachment,
  getGmailThread,
  gmailMessageSummary,
  googleIntegrationStatus,
  listRecentGmailThreads,
  uploadDriveFile,
} from "./_lib/google.mts";
import {
  buildArchiveKeyFromParts,
  sourceSignatureFromParts,
} from "./_lib/sync-core.mts";

const GMAIL_SYNC_BUILD_VERSION = "2026-05-07-pipeline-v5-legacy-removed";
const RESOLVER_VERSION = "2026-05-07-resolver-v3";
const PIPELINE_VERSION = "2026-05-07-pipeline-v2";
const INTERNAL_PATTERNS = [/@nstsf\.dk/i, /gemini-notes@google\.com/i];
const MAILBOX_OWNER = "christian@nstsf.dk";
const NSTSF_QUERY = `(from:${MAILBOX_OWNER} OR from:smg@nstsf.dk OR from:nstsf.dk OR to:${MAILBOX_OWNER} OR cc:${MAILBOX_OWNER})`;
const EXCLUDED_MAIL_QUERY = "-from:cgallstar@gmail.com -from:christian@scventures.vc -to:christian@scventures.vc -cc:christian@scventures.vc -werkhaus";
const OWNER_QUERY = `${NSTSF_QUERY} ${EXCLUDED_MAIL_QUERY}`;
const SYNC_QUERY = `newer_than:30d -in:spam -in:trash ${OWNER_QUERY}`;
const INTERNAL_ACTION_INBOX_QUERY = `newer_than:30d -in:spam -in:trash ${OWNER_QUERY} (from:smg@nstsf.dk OR from:nstsf.dk OR from:${MAILBOX_OWNER})`;
const ARCHIVE_QUERIES = [
  `newer_than:90d -in:spam -in:trash ${OWNER_QUERY} ("Faktura" OR "faktura")`,
  `newer_than:45d -in:spam -in:trash ${OWNER_QUERY} ("Byggemødereferat" OR "Byggemodereferat" OR "byggemøde" OR "byggemode")`,
  `newer_than:90d -in:spam -in:trash ${OWNER_QUERY} ("Udbedring af mangler" OR "afslutningsmøde" OR "afslutningsmode")`,
  `newer_than:45d -in:spam -in:trash ${OWNER_QUERY} ("Tilbud vedr" OR "tilbud" OR "overslagspris")`,
];
const DANISH_MONTHS: Record<string, string> = {
  januar: "01",
  februar: "02",
  marts: "03",
  april: "04",
  maj: "05",
  juni: "06",
  juli: "07",
  august: "08",
  september: "09",
  oktober: "10",
  november: "11",
  december: "12",
};
function appendSyncLog(state: any, payload: Record<string, unknown>) {
  state.syncLog = Array.isArray(state?.syncLog) ? state.syncLog : [];
  const cleanSubject = stripSyncStatusPrefix(textValue(payload.subject, ""));
  const rawStatus = textValue(payload.status, "");
  const reviewText = [
    payload.error,
    payload.notes,
    cleanSubject,
    payload.documentType,
    payload.category,
  ].map((value) => textValue(value, "")).join(" ");
  const status = rawStatus === "error" && isReviewIssueText(reviewText)
    ? "needs_review"
    : rawStatus;
  const archiveKey = textValue(payload.archiveKey, "");
  const threadId = textValue(payload.threadId, "");
  const fileName = textValue(payload.fileName, "");
  const caseId = textValue(payload.caseId, "");
  const subject = cleanSubject;
  if (archiveKey) {
    state.syncLog = state.syncLog.filter((entry: any) =>
      textValue(entry?.archiveKey, "") !== archiveKey &&
      (!threadId || textValue(entry?.threadId, "") !== threadId)
    );
  } else if (threadId) {
    state.syncLog = state.syncLog.filter((entry: any) => textValue(entry?.threadId, "") !== threadId);
  } else if (fileName && caseId) {
    state.syncLog = state.syncLog.filter((entry: any) => {
      return !(textValue(entry?.fileName, "") === fileName && textValue(entry?.caseId, "") === caseId);
    });
  } else if (subject) {
    state.syncLog = state.syncLog.filter((entry: any) => {
      return textValue(entry?.subject, "") !== subject;
    });
  }
  state.syncLog.unshift({
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    source: "gmail_sync",
    ...payload,
    subject: cleanSubject,
    status,
  });
  state.syncLog = state.syncLog.slice(0, 80);
}

function isReviewIssueText(value = "") {
  return /kunne ikke matches sikkert|kræver manuel match|matcher flere mulige sager|case_not_matched|invoice_match_low_confidence|invoice_match_ambiguous/i.test(String(value || ""));
}

function stripSyncStatusPrefix(value = "") {
  return textValue(value, "").replace(/^\s*(fejl|afklaring|arkiveret|opgave|opdatering|allerede arkiveret)\s*[·:-]\s*/i, "").trim();
}

function syncLogDedupeKey(entry: any) {
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

function normalizeExistingSyncLog(state: any) {
  if (!Array.isArray(state?.syncLog)) return 0;
  let changed = 0;
  const seen = new Set<string>();
  const normalized: any[] = [];
  for (const entry of state.syncLog) {
    if (!entry) {
      changed += 1;
      continue;
    }
    entry.subject = stripSyncStatusPrefix(entry.subject);
    const reviewText = [entry.error, entry.notes, entry.subject, entry.documentType, entry.category].map((value) => textValue(value, "")).join(" ");
    if (entry.status === "error" && isReviewIssueText(reviewText)) {
      entry.status = "needs_review";
      changed += 1;
    }
    const key = syncLogDedupeKey(entry);
    if (seen.has(key)) {
      changed += 1;
      continue;
    }
    seen.add(key);
    normalized.push(entry);
  }
  state.syncLog = normalized.slice(0, 80);
  return changed;
}

function syncLogDiagnostics(state: any) {
  const entries = Array.isArray(state?.syncLog) ? state.syncLog : [];
  return entries.reduce((acc: any, entry: any) => {
    const status = textValue(entry?.status, "unknown") || "unknown";
    acc.total += 1;
    acc.byStatus[status] = Number(acc.byStatus[status] || 0) + 1;
    if (status === "error") {
      const subject = textValue(entry?.subject, "");
      acc.errors.push({
        subject,
        error: textValue(entry?.error || entry?.notes, ""),
        documentType: textValue(entry?.documentType, ""),
        category: textValue(entry?.category, ""),
      });
    }
    return acc;
  }, { total: 0, byStatus: {}, errors: [] });
}

function dedupeThreads(threads: any[]) {
  const seen = new Set<string>();
  const result: any[] = [];
  for (const thread of threads) {
    const id = textValue(thread?.id, "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(thread);
  }
  return result;
}

function ensureGmailSyncState(state: any) {
  state.syncState = state.syncState && typeof state.syncState === "object" && !Array.isArray(state.syncState) ? state.syncState : {};
  state.syncState.gmailQueue = Array.isArray(state.syncState.gmailQueue) ? state.syncState.gmailQueue : [];
  state.syncState.threadLedger = state.syncState.threadLedger && typeof state.syncState.threadLedger === "object" && !Array.isArray(state.syncState.threadLedger)
    ? state.syncState.threadLedger
    : {};
  state.syncState.processedThreadHistory = state.syncState.processedThreadHistory && typeof state.syncState.processedThreadHistory === "object" && !Array.isArray(state.syncState.processedThreadHistory)
    ? state.syncState.processedThreadHistory
    : {};
  state.syncState.archiveManifest = state.syncState.archiveManifest && typeof state.syncState.archiveManifest === "object" && !Array.isArray(state.syncState.archiveManifest)
    ? state.syncState.archiveManifest
    : {};
  state.syncState.migrations = state.syncState.migrations && typeof state.syncState.migrations === "object" && !Array.isArray(state.syncState.migrations)
    ? state.syncState.migrations
    : {};
  state.syncState.ingestion = state.syncState.ingestion && typeof state.syncState.ingestion === "object" && !Array.isArray(state.syncState.ingestion)
    ? state.syncState.ingestion
    : {};
  state.syncState.classification = state.syncState.classification && typeof state.syncState.classification === "object" && !Array.isArray(state.syncState.classification)
    ? state.syncState.classification
    : {};
  state.syncState.resolution = state.syncState.resolution && typeof state.syncState.resolution === "object" && !Array.isArray(state.syncState.resolution)
    ? state.syncState.resolution
    : {};
  state.syncState.projectionLog = state.syncState.projectionLog && typeof state.syncState.projectionLog === "object" && !Array.isArray(state.syncState.projectionLog)
    ? state.syncState.projectionLog
    : {};
  state.syncState.reviewQueue = Array.isArray(state.syncState.reviewQueue) ? state.syncState.reviewQueue : [];
  state.syncState.manualReviewResolutions = state.syncState.manualReviewResolutions && typeof state.syncState.manualReviewResolutions === "object" && !Array.isArray(state.syncState.manualReviewResolutions)
    ? state.syncState.manualReviewResolutions
    : {};
  state.syncState.syncRuns = state.syncState.syncRuns && typeof state.syncState.syncRuns === "object" && !Array.isArray(state.syncState.syncRuns)
    ? state.syncState.syncRuns
    : {};
  state.syncState.records = state.syncState.records && typeof state.syncState.records === "object" && !Array.isArray(state.syncState.records)
    ? state.syncState.records
    : {};
  return state.syncState;
}

function sourceSignatureFromThread(thread: any, fallback = "") {
  const summaries = Array.isArray(thread?.messages) ? thread.messages.map(gmailMessageSummary) : [];
  const messageIds = summaries.map((message) => textValue(message?.id, "")).filter(Boolean);
  const attachmentNames = summaries
    .flatMap((message) => Array.isArray(message?.attachments) ? message.attachments : [])
    .map((attachment: any) => textValue(attachment?.filename, ""))
    .filter(Boolean);
  const source = [...messageIds, ...attachmentNames, fallback].join("|");
  return stableThreeDigitHash(source || textValue(thread?.id, ""));
}

function buildArchiveKey(thread: any, signal: any, documentDate: string, displayCaseId: string, fallback = "") {
  const summaries = Array.isArray(thread?.messages) ? thread.messages.map(gmailMessageSummary) : [];
  return buildArchiveKeyFromParts({
    threadId: textValue(thread?.id, ""),
    messageIds: summaries.map((message) => textValue(message?.id, "")).filter(Boolean),
    attachmentNames: summaries
      .flatMap((message) => Array.isArray(message?.attachments) ? message.attachments : [])
      .map((attachment: any) => textValue(attachment?.filename, ""))
      .filter(Boolean),
    category: textValue(signal?.category, ""),
    documentType: textValue(signal?.documentType, ""),
    documentDate,
    displayCaseId,
    fallback,
  });
}

function archiveManifestEntry(state: any, archiveKey = "") {
  if (!archiveKey) return null;
  const syncState = ensureGmailSyncState(state);
  return syncState.archiveManifest?.[archiveKey] || null;
}

function registerArchiveManifest(state: any, archiveKey: string, payload: Record<string, unknown>) {
  if (!archiveKey) return null;
  const syncState = ensureGmailSyncState(state);
  const previous = syncState.archiveManifest[archiveKey] || {};
  const next = {
    ...previous,
    archiveKey,
    updatedAt: new Date().toISOString(),
    ...payload,
  };
  syncState.archiveManifest[archiveKey] = next;
  const entries = Object.entries(syncState.archiveManifest);
  if (entries.length > 2000) {
    syncState.archiveManifest = Object.fromEntries(entries.slice(-2000));
  }
  return next;
}

function trimObjectMap(map: Record<string, any>, max = 1500) {
  const entries = Object.entries(map || {});
  if (entries.length <= max) return map;
  return Object.fromEntries(entries.slice(-max));
}

function compactThreadRecord(thread: any) {
  const summaries = Array.isArray(thread?.messages) ? thread.messages.map(gmailMessageSummary) : [];
  const latest = latestThreadSummary(thread);
  const attachmentNames = summaries
    .flatMap((message) => Array.isArray(message?.attachments) ? message.attachments : [])
    .map((attachment: any) => textValue(attachment?.filename, ""))
    .filter(Boolean);
  const text = fullThreadText(thread);
  return {
    threadId: textValue(thread?.id, ""),
    historyId: textValue(thread?.historyId, ""),
    latestMessageId: textValue(latest?.id, ""),
    latestMessageAt: textValue(latest?.isoDate, ""),
    subject: textValue(latest?.subject, ""),
    from: textValue(latest?.from, ""),
    messageCount: summaries.length,
    attachmentNames,
    bodyHash: sourceSignatureFromParts(textValue(thread?.id, ""), summaries.map((message) => textValue(message?.id, "")).filter(Boolean), attachmentNames, text),
    ingestedAt: new Date().toISOString(),
    pipelineVersion: PIPELINE_VERSION,
  };
}

function recordIngestion(state: any, thread: any) {
  const syncState = ensureGmailSyncState(state);
  const record = compactThreadRecord(thread);
  if (!record.threadId) return null;
  syncState.ingestion[record.threadId] = {
    ...(syncState.ingestion[record.threadId] || {}),
    ...record,
  };
  syncState.ingestion = trimObjectMap(syncState.ingestion);
  return syncState.ingestion[record.threadId];
}

function recordClassification(state: any, thread: any, item: any, intent: any) {
  const syncState = ensureGmailSyncState(state);
  const threadId = textValue(thread?.id || item?.threadId || item?.id, "");
  if (!threadId) return null;
  const latest = latestThreadSummary(thread);
  const archiveSignal = intent?.archiveSignal || inferArchiveSignal(item?.subject || latest?.subject, fullThreadText(thread) || item?.body, latest?.from || item?.from);
  const record = {
    threadId,
    subject: textValue(item?.subject || latest?.subject, ""),
    intent: textValue(intent?.intent, "unknown"),
    lane: textValue(intent?.lane, ""),
    reason: textValue(intent?.reason, ""),
    archiveSignal: archiveSignal ? {
      category: textValue(archiveSignal.category, ""),
      documentType: textValue(archiveSignal.documentType, ""),
      sourceType: textValue(archiveSignal.sourceType, ""),
      fileLabel: textValue(archiveSignal.fileLabel, ""),
      invoiceNumber: textValue(archiveSignal.invoiceNumber, ""),
    } : null,
    classifiedAt: new Date().toISOString(),
    pipelineVersion: PIPELINE_VERSION,
  };
  syncState.classification[threadId] = record;
  syncState.classification = trimObjectMap(syncState.classification);
  return record;
}

function recordResolution(state: any, threadId = "", payload: Record<string, unknown>) {
  if (!threadId) return null;
  const syncState = ensureGmailSyncState(state);
  const record = {
    ...(syncState.resolution[threadId] || {}),
    threadId,
    resolvedAt: new Date().toISOString(),
    resolverVersion: RESOLVER_VERSION,
    ...payload,
  };
  syncState.resolution[threadId] = record;
  syncState.resolution = trimObjectMap(syncState.resolution);
  return record;
}

function reviewQueueKey(payload: any) {
  const threadId = textValue(payload?.threadId, "");
  if (threadId) return `thread:${threadId}`;
  const archiveKey = textValue(payload?.archiveKey, "");
  if (archiveKey) return `archive:${archiveKey}`;
  return [
    textValue(payload?.subject, "").toLowerCase(),
    textValue(payload?.documentType, "").toLowerCase(),
    textValue(payload?.category, "").toLowerCase(),
  ].join("|");
}

function upsertReviewQueueItem(state: any, payload: Record<string, unknown>) {
  const syncState = ensureGmailSyncState(state);
  const key = reviewQueueKey(payload);
  if (!key) return null;
  const existingIndex = syncState.reviewQueue.findIndex((item: any) => reviewQueueKey(item) === key);
  const previous = existingIndex >= 0 ? syncState.reviewQueue[existingIndex] : {};
  const next = {
    ...previous,
    id: textValue(previous?.id, `review-${stableThreeDigitHash(key)}`),
    status: textValue(payload.status, textValue(previous?.status, "open")),
    createdAt: textValue(previous?.createdAt, new Date().toISOString()),
    updatedAt: new Date().toISOString(),
    pipelineVersion: PIPELINE_VERSION,
    ...payload,
  };
  if (existingIndex >= 0) syncState.reviewQueue.splice(existingIndex, 1);
  syncState.reviewQueue.unshift(next);
  syncState.reviewQueue = syncState.reviewQueue.slice(0, 200);
  return next;
}

function recordProjection(state: any, archiveKey: string, payload: Record<string, unknown>) {
  if (!archiveKey) return null;
  const syncState = ensureGmailSyncState(state);
  const record = {
    ...(syncState.projectionLog[archiveKey] || {}),
    archiveKey,
    projectedAt: new Date().toISOString(),
    pipelineVersion: PIPELINE_VERSION,
    ...payload,
  };
  syncState.projectionLog[archiveKey] = record;
  syncState.projectionLog = trimObjectMap(syncState.projectionLog);
  return record;
}

function closeReviewQueueItem(state: any, threadId = "", archiveKey = "") {
  const syncState = ensureGmailSyncState(state);
  syncState.reviewQueue = syncState.reviewQueue.map((item: any) => {
    const sameThread = threadId && textValue(item?.threadId, "") === threadId;
    const sameArchive = archiveKey && textValue(item?.archiveKey, "") === archiveKey;
    if (!sameThread && !sameArchive) return item;
    return {
      ...item,
      status: "resolved",
      resolvedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pipelineVersion: PIPELINE_VERSION,
    };
  });
}

function manualReviewResolutionForThread(state: any, threadId = "") {
  if (!threadId) return null;
  const syncState = ensureGmailSyncState(state);
  return syncState.manualReviewResolutions?.[threadId] || null;
}

function findCaseByDisplayRef(state: any, ref = "") {
  const raw = textValue(ref, "").trim();
  if (!raw) return null;
  const compact = normalizeCaseKey(raw.replace(/^[KS]-/i, ""));
  const wantedCustomer = raw.match(/^K-?(\d+)$/i)?.[1] || "";
  const wantedSag = raw.match(/^S-?(\d+)$/i)?.[1] || "";
  const sager = Array.isArray(state?.sager) ? state.sager : [];
  if (wantedCustomer) return findCaseByCustomerNumber(state, wantedCustomer);
  if (wantedSag) {
    return sager.find((entry: any) => normalizeCaseKey(textValue(entry?.sagId, "").replace(/^S-/i, "")) === wantedSag) || null;
  }
  return sager.find((entry: any) => normalizeCaseKey(entry?.sid || entry?.nr) === compact) || null;
}

function pipelineSnapshot(state: any) {
  const syncState = ensureGmailSyncState(state);
  const reviewItems = Array.isArray(syncState.reviewQueue) ? syncState.reviewQueue : [];
  return {
    pipelineVersion: PIPELINE_VERSION,
    resolverVersion: RESOLVER_VERSION,
    ingestedThreads: Object.keys(syncState.ingestion || {}).length,
    classifiedThreads: Object.keys(syncState.classification || {}).length,
    resolvedThreads: Object.keys(syncState.resolution || {}).length,
    projectedDocuments: Object.keys(syncState.projectionLog || {}).length,
    openReviewItems: reviewItems.filter((item: any) => textValue(item?.status, "open") === "open").length,
  };
}

function startSyncRun(state: any, trigger = "manual") {
  const syncState = ensureGmailSyncState(state);
  const runId = `sync-${new Date().toISOString()}-${randomUUID().slice(0, 8)}`;
  syncState.currentRunId = runId;
  syncState.syncRuns[runId] = {
    id: runId,
    trigger,
    status: "running",
    startedAt: new Date().toISOString(),
    gmailSyncBuild: GMAIL_SYNC_BUILD_VERSION,
    pipelineVersion: PIPELINE_VERSION,
    resolverVersion: RESOLVER_VERSION,
  };
  syncState.syncRuns = trimObjectMap(syncState.syncRuns, 250);
  return runId;
}

function finishSyncRun(state: any, runId = "", payload: Record<string, unknown> = {}) {
  if (!runId) return null;
  const syncState = ensureGmailSyncState(state);
  syncState.syncRuns[runId] = {
    ...(syncState.syncRuns[runId] || { id: runId }),
    ...payload,
    finishedAt: new Date().toISOString(),
  };
  return syncState.syncRuns[runId];
}

function refreshNormalizedSyncRecords(state: any) {
  const syncState = ensureGmailSyncState(state);
  syncState.records = {
    mailThreads: syncState.ingestion || {},
    classifications: syncState.classification || {},
    resolutions: syncState.resolution || {},
    documents: syncState.projectionLog || {},
    reviewItems: Object.fromEntries((Array.isArray(syncState.reviewQueue) ? syncState.reviewQueue : []).map((item: any) => [reviewQueueKey(item), item])),
    syncRuns: syncState.syncRuns || {},
  };
  return syncState.records;
}

function isFinalLedgerStatus(status = "") {
  return ["processed", "task_created", "archived", "updated", "needs_manual_match", "ignored", "failed_final"].includes(textValue(status, ""));
}

function ledgerEntryForThread(state: any, threadId = "") {
  const syncState = ensureGmailSyncState(state);
  return threadId ? syncState.threadLedger?.[threadId] || null : null;
}

function shouldSkipThreadByLedger(state: any, threadId = "", historyId = "") {
  if (!threadId || !historyId) return false;
  const entry = ledgerEntryForThread(state, threadId);
  if (entry && textValue(entry.status, "") === "needs_manual_match" && textValue(entry.resolverVersion, "") !== RESOLVER_VERSION) {
    return false;
  }
  return Boolean(entry && textValue(entry.historyId, "") === historyId && isFinalLedgerStatus(entry.status));
}

function updateThreadLedger(state: any, thread: any, payload: Record<string, unknown>) {
  const syncState = ensureGmailSyncState(state);
  const threadId = textValue(thread?.id || payload.threadId, "");
  if (!threadId) return null;
  const previous = syncState.threadLedger[threadId] || {};
  const latest = latestThreadSummary(thread);
  const next = {
    ...previous,
    threadId,
    historyId: textValue(thread?.historyId || payload.historyId, previous.historyId || ""),
    subject: textValue(payload.subject || latest?.subject || previous.subject, ""),
    latestMessageId: textValue(payload.latestMessageId || latest?.id || previous.latestMessageId || ""),
    latestMessageAt: textValue(payload.latestMessageAt || latest?.isoDate || previous.latestMessageAt, ""),
    lastSeenAt: new Date().toISOString(),
    resolverVersion: textValue(payload.resolverVersion, RESOLVER_VERSION),
    ...payload,
  };
  syncState.threadLedger[threadId] = next;
  const entries = Object.entries(syncState.threadLedger);
  if (entries.length > 1200) {
    syncState.threadLedger = Object.fromEntries(entries.slice(-1200));
  }
  return next;
}

function queueDiscoveredThreads(state: any, groups: Array<{ lane: string; priority: number; threads: any[] }>) {
  const syncState = ensureGmailSyncState(state);
  const now = new Date().toISOString();
  const byId = new Map(syncState.gmailQueue.map((item: any) => [textValue(item?.id, ""), item]).filter(([id]: any) => id));
  for (const group of groups) {
    for (const thread of group.threads || []) {
      const id = textValue(thread?.id, "");
      if (!id) continue;
      const historyId = textValue(thread?.historyId, "");
      if (shouldSkipThreadByLedger(state, id, historyId)) continue;
      if (!["dke_questions", "internal_inbox"].includes(group.lane) && historyId && textValue(syncState.processedThreadHistory?.[id], "") === historyId) continue;
      const existing: any = byId.get(id);
      if (existing) {
        const previousPriority = Number(existing.priority || 0);
        existing.historyId = historyId || existing.historyId || "";
        existing.priority = Math.max(previousPriority, group.priority);
        existing.lane = previousPriority >= group.priority ? existing.lane : group.lane;
        existing.discoveredAt = existing.discoveredAt || now;
        existing.updatedAt = now;
      } else {
        byId.set(id, {
          id,
          historyId,
          lane: group.lane,
          priority: group.priority,
          attempts: 0,
          discoveredAt: now,
          updatedAt: now,
        });
      }
    }
  }
  syncState.gmailQueue = [...byId.values()]
    .sort((a: any, b: any) => Number(b.priority || 0) - Number(a.priority || 0) || String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .slice(0, 200);
  return syncState.gmailQueue;
}

function selectQueuedThreads(state: any, max = 14) {
  const syncState = ensureGmailSyncState(state);
  const eligible = syncState.gmailQueue
    .filter((item: any) => {
      const id = textValue(item?.id, "");
      const historyId = textValue(item?.historyId, "");
      if (shouldSkipThreadByLedger(state, id, historyId)) return false;
      return id && (["dke_questions", "internal_inbox"].includes(textValue(item?.lane, "")) || !historyId || textValue(syncState.processedThreadHistory?.[id], "") !== historyId);
    })
    .sort((a: any, b: any) =>
      Number(b.priority || 0) - Number(a.priority || 0) ||
      Number(a.attempts || 0) - Number(b.attempts || 0) ||
      String(a.discoveredAt || "").localeCompare(String(b.discoveredAt || ""))
    );
  const selected: any[] = [];
  const seen = new Set<string>();
  const takeLane = (lane: string, count: number) => {
    for (const item of eligible) {
      if (selected.length >= max || count <= 0) break;
      const id = textValue(item?.id, "");
      if (!id || seen.has(id) || textValue(item?.lane, "") !== lane) continue;
      selected.push(item);
      seen.add(id);
      count -= 1;
    }
  };

  takeLane("internal_inbox", 4);
  takeLane("dke_questions", 2);
  for (const item of eligible) {
    if (selected.length >= max) break;
    const id = textValue(item?.id, "");
    if (!id || seen.has(id)) continue;
    selected.push(item);
    seen.add(id);
  }
  return selected;
}

function markQueuedThreadAttempt(state: any, id = "") {
  if (!id) return;
  const syncState = ensureGmailSyncState(state);
  const item = syncState.gmailQueue.find((entry: any) => textValue(entry?.id, "") === id);
  if (item) {
    item.attempts = Number(item.attempts || 0) + 1;
    item.updatedAt = new Date().toISOString();
  }
}

function markQueuedThreadProcessed(state: any, thread: any) {
  const id = textValue(thread?.id, "");
  if (!id) return;
  const syncState = ensureGmailSyncState(state);
  const historyId = textValue(thread?.historyId, "");
  if (historyId) syncState.processedThreadHistory[id] = historyId;
  syncState.gmailQueue = syncState.gmailQueue.filter((entry: any) => textValue(entry?.id, "") !== id);
  const historyEntries = Object.entries(syncState.processedThreadHistory);
  if (historyEntries.length > 1000) {
    syncState.processedThreadHistory = Object.fromEntries(historyEntries.slice(-1000));
  }
}

function formatSyncError(error: unknown) {
  const message = typeof error === "string"
    ? textValue(error, "archive_failed")
    : textValue((error as Error)?.message, "archive_failed");
  if (message === "case_not_matched") return "Mailen kunne ikke matches sikkert til en eksisterende sag.";
  if (message === "invoice_match_low_confidence") return "Fakturaen kunne ikke matches sikkert ud fra mailtekst, filnavn, adresse, S-/K-reference eller kendt fakturanummer.";
  if (message === "invoice_match_ambiguous") return "Fakturaen matcher flere mulige sager og kræver manuel afklaring.";
  if (message.startsWith("google_token_error:")) return "Google OAuth-token kunne ikke fornyes.";
  if (message.startsWith("google_fetch_timeout:")) return "Google API svarede for langsomt. Sync blev stoppet for at undgå Netlify-timeout.";
  const googleHit = message.match(/^google_api_error:([^:]+):(\d+):(.*)$/);
  if (googleHit) {
    const operation = googleHit[1];
    const status = googleHit[2];
    if (status === "401") return `Google afviste ${operation}. OAuth-sessionen er ugyldig eller udløbet.`;
    if (status === "403") return `Google afviste ${operation}. Manglende adgang, scope eller filrettighed.`;
    if (status === "429") return `Google rate limit på ${operation}. Prøv igen senere.`;
    return `Google API-fejl i ${operation}: HTTP ${status}.`;
  }
  if (message === "google_not_configured") return "Google integration er ikke konfigureret.";
  if (message === "drive_root_missing") return "Drive-roden mangler for den matchede sag.";
  if (message.startsWith("drive_folder_missing:")) return "Den forventede undermappe findes ikke i Drive-strukturen.";
  if (message === "drive_document_content_missing") return "Der manglede filindhold til Drive-upload.";
  if (message === "archive_failed") return "Arkiveringen fejlede.";
  return message;
}

function isInternalSender(value = "") {
  return INTERNAL_PATTERNS.some((pattern) => pattern.test(String(value).toLowerCase()));
}

function isSmgSender(value = "") {
  return /smg@nstsf\.dk/i.test(String(value || ""));
}

function parseMessageDate(summary: any) {
  const internalDate = Number(summary?.internalDate || 0);
  if (internalDate) return new Date(internalDate).toISOString();
  const dateHeader = textValue(summary?.dateHeader, "");
  const parsed = new Date(dateHeader);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function scoreCaseFromText(entry: any, haystack: string) {
  const lower = String(haystack || "").toLowerCase();
  const compact = plainCompactText(haystack);
  let score = 0;
  const reasons: string[] = [];
  const kunde = String(entry?.kunde || "").toLowerCase();
  const adr = String(entry?.adr || "").toLowerCase();
  const nr = String(entry?.nr || "").toLowerCase();
  const sid = String(entry?.sid || "").toLowerCase();
  const opg = String(entry?.opg || "").toLowerCase();
  const compactKunde = plainCompactText(kunde);
  const compactAdr = plainCompactText(adr);
  const compactNr = plainCompactText(nr);
  const compactSid = plainCompactText(sid);
  const compactOpg = plainCompactText(opg);
  if (kunde && lower.includes(kunde)) {
    score += 3;
    reasons.push("kunde");
  }
  if (adr && lower.includes(adr)) {
    score += 5;
    reasons.push("adresse");
  }
  if (nr && lower.includes(nr)) {
    score += 2;
    reasons.push("sagsnr");
  }
  if (sid && lower.includes(sid)) {
    score += 4;
    reasons.push("sagsID");
  }
  if (opg && opg.length > 12 && lower.includes(opg)) {
    score += 1;
    reasons.push("opgave");
  }
  if (compactKunde && compact.includes(compactKunde)) {
    score += 3;
    reasons.push("kunde");
  }
  if (compactAdr && compact.includes(compactAdr)) {
    score += 10;
    reasons.push("adresse");
  }
  if (compactAdr) {
    const sourceAddress = normalizeAddressAlias(haystack);
    const entryAddress = normalizeAddressAlias(adr);
    if (entryAddress && sourceAddress.includes(entryAddress)) {
      score += 10;
      reasons.push("adresse");
    }
  }
  if (compactNr && compact.includes(compactNr)) {
    score += 4;
    reasons.push("sagsnr");
  }
  if (compactSid && compact.includes(compactSid)) {
    score += 6;
    reasons.push("sagsID");
  }
  if (compactOpg && compactOpg.length > 12 && compact.includes(compactOpg)) {
    score += 2;
    reasons.push("opgave");
  }
  return { score, reasons: [...new Set(reasons)] };
}

function matchCaseFromText(sager: any[], haystack: string) {
  let best: any = null;
  let bestScore = 0;
  let bestReasons: string[] = [];
  let secondScore = 0;
  for (const entry of sager) {
    const { score, reasons } = scoreCaseFromText(entry, haystack);
    if (score > bestScore) {
      secondScore = bestScore;
      best = entry;
      bestScore = score;
      bestReasons = reasons;
    } else if (score > secondScore) {
      secondScore = score;
    }
  }
  const hasStrongReason = bestReasons.includes("adresse") || bestReasons.includes("sagsID");
  const ambiguous = secondScore >= bestScore - 2;
  if (!best || bestScore < 8 || !hasStrongReason || ambiguous) return null;
  return best;
}

function matchCaseWithConfidence(sager: any[], haystack: string) {
  const ranked = (Array.isArray(sager) ? sager : [])
    .map((entry: any) => ({ entry, ...scoreCaseFromText(entry, haystack) }))
    .filter((result: any) => result.score > 0)
    .sort((a: any, b: any) => b.score - a.score);
  const best = ranked[0];
  if (!best) return { entry: null, score: 0, reasons: [], confident: false };
  const second = ranked[1];
  const hasStrongReason = best.reasons.includes("adresse") || best.reasons.includes("sagsID");
  const ambiguous = Boolean(second && second.score >= best.score - 2);
  return {
    entry: best.entry,
    score: best.score,
    reasons: best.reasons,
    confident: Boolean(best.score >= 8 && hasStrongReason && !ambiguous),
  };
}

function normalizeCaseKey(value: unknown) {
  return String(value || "").replace(/\s+/g, "").trim().toLowerCase();
}

function stableThreeDigitHash(value = "") {
  let hash = 0;
  for (const char of String(value || "")) hash = ((hash * 31) + char.charCodeAt(0)) % 900;
  return String(100 + hash).padStart(3, "0").slice(-3);
}

function primaryCaseNumberFromValue(value: unknown) {
  const compact = textValue(value, "").replace(/\s+/g, "").trim();
  const match = compact.match(/^(\d+)/);
  return match ? match[1] : "";
}

function primaryCaseNumber(entry: any) {
  return primaryCaseNumberFromValue(entry?.sid) || primaryCaseNumberFromValue(entry?.nr);
}

function nextCustomerNumber(sager: any[]) {
  const used = (Array.isArray(sager) ? sager : [])
    .map((entry: any) => Number(primaryCaseNumber(entry)))
    .filter((value: number) => Number.isFinite(value) && value >= 1000);
  const max = used.length ? Math.max(...used) : 1000;
  return String(max + 1);
}

function formatCaseIdForDisplay(entry: any) {
  const raw = textValue(entry?.sid || entry?.nr, "").trim();
  const compact = raw.replace(/\s+/g, "");
  const full = compact.match(/^(\d+)([a-z]+)$/i);
  if (full) return `${full[1]} ${full[2].toUpperCase()}`;
  const primary = primaryCaseNumber(entry);
  return primary || raw.toUpperCase();
}

function plainCompactText(value = "") {
  return String(value || "")
    .replace(/\bN\s*\.?\s*V\s*\.?\s*Gadesvej/gi, "NV Gadesvej")
    .replace(/\bN\s*\.?\s*W\s*\.?\s*Gadesvej/gi, "NV Gadesvej")
    .replace(/\bNW[\s_.-]*Gadesvej/gi, "NV Gadesvej")
    .replace(/\bN\s*V\s*Gadesvej/gi, "NV Gadesvej")
    .replace(/\blejlighed\b/gi, "lej")
    .replace(/\blejl?\./gi, "lej")
    .replace(/[æÆ]/g, "ae")
    .replace(/[øØ]/g, "o")
    .replace(/[åÅ]/g, "a")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase();
}

function meaningfulTokens(value = "") {
  const stop = new Set(["aps", "as", "dke", "charlotte", "kunde", "faktura", "vedrorende", "vedr"]);
  return plainCompactText(value).split(/\s+/).filter((token) => token.length >= 3 && !stop.has(token));
}

function normalizeAddressAlias(value = "") {
  return plainCompactText(value)
    .replace(/\balle\b/g, "alle")
    .replace(/\ballé\b/g, "alle")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeAddressForLooseMatch(value = "") {
  return normalizeAddressAlias(value)
    .replace(/\b(st|tv|th|mf|sal|kl|kld|lej|lejl|lejlighed)\b/g, "")
    .replace(/\s+/g, "");
}

function decodePdfString(value = "") {
  return value
    .replace(/\\([nrtbf()\\])/g, (_match, char) => {
      if (char === "n") return "\n";
      if (char === "r") return "\r";
      if (char === "t") return "\t";
      if (char === "b") return "\b";
      if (char === "f") return "\f";
      return char;
    })
    .replace(/\\([0-7]{1,3})/g, (_match, octal) => String.fromCharCode(parseInt(octal, 8)));
}

function extractPdfLiteralText(source = "") {
  const values: string[] = [];
  const literalPattern = /\((?:\\.|[^\\)]){2,}\)/g;
  let match: RegExpExecArray | null;
  while ((match = literalPattern.exec(source))) {
    const raw = match[0].slice(1, -1);
    const decoded = decodePdfString(raw).trim();
    if (decoded && /[A-Za-zÆØÅæøå0-9]/.test(decoded)) values.push(decoded);
  }
  return values.join("\n");
}

function extractPdfText(buffer: Buffer) {
  const chunks: string[] = [extractPdfLiteralText(buffer.toString("latin1"))];
  const raw = buffer.toString("latin1");
  const streamPattern = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match: RegExpExecArray | null;
  while ((match = streamPattern.exec(raw))) {
    try {
      const start = Buffer.byteLength(raw.slice(0, match.index + match[0].indexOf(match[1])), "latin1");
      const length = Buffer.byteLength(match[1], "latin1");
      const inflated = inflateSync(buffer.subarray(start, start + length));
      chunks.push(extractPdfLiteralText(inflated.toString("latin1")));
    } catch {
      // Best-effort PDF extraction. If a stream is not deflated text, ignore it.
    }
  }
  return chunks.filter(Boolean).join("\n");
}

function labelInvoiceDocs(matched: any, invoiceNumber: string, date: string) {
  matched.docs = matched.docs && typeof matched.docs === "object" ? matched.docs : {};
  matched.docs.betaling = Array.isArray(matched.docs.betaling) ? matched.docs.betaling : [];
  const expectedTitle = `Faktura ${invoiceNumber}`;
  let changed = false;
  for (const doc of matched.docs.betaling) {
    const title = textValue(doc?.titel || doc?.title, "");
    const notes = textValue(doc?.notes, "");
    const hasInvoice = new RegExp(`\\b${invoiceNumber}\\b`).test(`${title} ${notes}`);
    const isGenericInvoice = /^faktura$/i.test(title.trim()) || /^unavngiven faktura$/i.test(title.trim()) || (title.toLowerCase().includes("faktura") && !/\d{3,}/.test(title));
    if (!hasInvoice && !isGenericInvoice) continue;
    doc.titel = expectedTitle;
    doc.title = expectedTitle;
    if (!textValue(doc?.dato, "")) doc.dato = date;
    changed = true;
  }
  return changed;
}

function applyInvoiceToCase(matched: any, invoiceNumber: string, invoiceDate = "", amount = 0, dueDate = "") {
  ensureCaseShape(matched);
  const currentInvoice = textValue(matched.fak || matched.workflow?.invoiceNumber, "");
  const alreadyPaidSameInvoice = currentInvoice === invoiceNumber &&
    (textValue(matched.status, "").toLowerCase().includes("betalt") || textValue(matched.workflow?.invoicePaidDate, ""));
  const before = JSON.stringify({
    fak: matched.fak,
    status: matched.status,
    workflow: matched.workflow,
    dato: matched.dato,
    u: matched.u,
    docs: matched.docs?.betaling,
  });
  matched.fak = invoiceNumber;
  matched.status = alreadyPaidSameInvoice ? "Faktura betalt" : "Faktura sendt";
  matched.workflow = matched.workflow && typeof matched.workflow === "object" ? matched.workflow : {};
  matched.workflow.invoiceNumber = invoiceNumber;
  matched.workflow.invoiceSentDate = invoiceDate || matched.workflow.invoiceSentDate || new Date().toISOString().slice(0, 10);
  matched.workflow.invoiceDueDate = dueDate || matched.workflow.invoiceDueDate || "";
  if (matched.workflow.invoiceDueDate) matched.dato = matched.workflow.invoiceDueDate;
  else if (!textValue(matched.dato, "")) matched.dato = matched.workflow.invoiceSentDate;
  if (amount && !alreadyPaidSameInvoice) matched.u = formatAmount(amount);
  const docsChanged = labelInvoiceDocs(matched, invoiceNumber, matched.workflow.invoiceSentDate);
  const after = JSON.stringify({
    fak: matched.fak,
    status: matched.status,
    workflow: matched.workflow,
    dato: matched.dato,
    u: matched.u,
    docs: matched.docs?.betaling,
  });
  return docsChanged || after !== before;
}

function findCaseByCustomerNumber(state: any, customerNumber = "", matcher: ((entry: any) => boolean) | null = null) {
  const wanted = normalizeCaseKey(customerNumber);
  const normalizedDigits = textValue(customerNumber, "").replace(/\D/g, "");
  if (!wanted && !normalizedDigits) return null;
  const matches = (Array.isArray(state?.sager) ? state.sager : []).filter((entry: any) => {
    if (wanted && primaryCaseNumber(entry) === wanted) return true;
    if (!normalizedDigits) return false;
    return textValue(entry?.nr, "").replace(/\D/g, "") === normalizedDigits ||
      textValue(entry?.sid, "").replace(/\D/g, "") === normalizedDigits;
  });
  if (matcher) return matches.find(matcher) || null;
  return matches[0] || null;
}

function invoicePaidConfirmed(text = "") {
  const compact = plainCompactText(text);
  if (!compact) return false;
  if (/\b(ikke|ej)\s+betalt\b/.test(compact)) return false;
  return /\b(er|blevet|nu)\s+betalt\b/.test(compact) ||
    /\bbetalt\b/.test(compact) && /\b(tak|kvittering|overfort|overfoert|har)\b/.test(compact);
}

function ensurePaymentRowPaid(state: any, matched: any, invoiceNumber: string, date = "", amount = 0) {
  state.betalinger = Array.isArray(state?.betalinger) ? state.betalinger : [];
  const caseNumber = primaryCaseNumber(matched);
  const existing = state.betalinger.find((entry: any) => {
    const sameInvoice = invoiceNumber && textValue(entry?.fak, "") === invoiceNumber;
    const sameCase = caseNumber && primaryCaseNumberFromValue(entry?.nr) === caseNumber;
    return sameInvoice && sameCase;
  });
  const payload = {
    nr: caseNumber,
    kunde: textValue(matched?.kunde, ""),
    milepael: textValue(matched?.adr || matched?.opg, "Faktura betalt"),
    dato: date || new Date().toISOString().slice(0, 10),
    beloeb: amount ? formatAmount(amount) : textValue(existing?.beloeb || matched?.u, "0"),
    fak: invoiceNumber,
    status: "betalt",
  };
  if (existing) {
    const before = JSON.stringify(existing);
    Object.assign(existing, payload);
    return JSON.stringify(existing) !== before;
  }
  state.betalinger.unshift(payload);
  return true;
}

function applyInvoicePaidToCase(state: any, matched: any, invoiceNumber: string, date = "", amount = 0, reason = "Gmail-sync") {
  ensureCaseShape(matched);
  const before = JSON.stringify({
    fak: matched.fak,
    status: matched.status,
    workflow: matched.workflow,
    dato: matched.dato,
    u: matched.u,
    betalinger: state.betalinger,
  });
  if (invoiceNumber) matched.fak = invoiceNumber;
  matched.status = "Faktura betalt";
  matched.workflow = matched.workflow && typeof matched.workflow === "object" ? matched.workflow : {};
  matched.workflow.invoiceNumber = invoiceNumber || matched.workflow.invoiceNumber;
  matched.workflow.invoicePaidDate = date || new Date().toISOString().slice(0, 10);
  if (amount) matched.workflow.invoicePaidAmount = formatAmount(amount);
  matched.u = "0";
  const paymentChanged = ensurePaymentRowPaid(state, matched, invoiceNumber, matched.workflow.invoicePaidDate, amount);
  const after = JSON.stringify({
    fak: matched.fak,
    status: matched.status,
    workflow: matched.workflow,
    dato: matched.dato,
    u: matched.u,
    betalinger: state.betalinger,
  });
  const changed = paymentChanged || after !== before;
  if (changed) {
    appendActivity(matched, { name: "Gmail-sync", email: MAILBOX_OWNER }, {
      type: "payment_paid",
      title: `Faktura ${invoiceNumber} betalt`,
      summary: `Kunden har bekræftet betaling af faktura ${invoiceNumber}${amount ? ` (${formatAmount(amount)} kr. inkl. moms)` : ""}. Registreret via ${reason}.`,
    });
  }
  return changed;
}

function invoiceNumbersForCase(entry: any) {
  const directValues = [
    entry?.fak,
    entry?.workflow?.invoiceNumber,
  ].map((value) => textValue(value, "")).filter((value) => /^\d{3,}$/.test(value.trim()));
  const documentValues = [
    ...(Array.isArray(entry?.docs?.betaling) ? entry.docs.betaling.flatMap((doc: any) => [doc?.titel, doc?.title, doc?.notes]) : []),
    ...(Array.isArray(entry?.docs?.mails) ? entry.docs.mails.flatMap((doc: any) => [doc?.titel, doc?.title, doc?.notes]) : []),
  ];
  const documentInvoices = documentValues
    .map((value) => textValue(value, ""))
    .flatMap((value) => [...value.matchAll(/\bfaktura\s*(?:nr\.?|nummer)?\s*[:#-]?\s*(\d{3,})\b/gi)].map((match) => match[1]))
    .filter(Boolean);
  return [...new Set([...directValues, ...documentInvoices])];
}

function scoreInvoiceCase(entry: any, invoiceText: string, invoiceNumber = "") {
  const source = plainCompactText(invoiceText);
  if (!source) return { score: 0, reasons: [] as string[] };
  const reasons: string[] = [];
  let score = 0;
  const existingInvoices = invoiceNumbersForCase(entry);
  const address = plainCompactText(entry?.adr || "");
  const customer = plainCompactText(entry?.kunde || "");
  const task = plainCompactText(entry?.opg || "");
  const sid = normalizeCaseKey(entry?.sid || "");
  const nr = normalizeCaseKey(entry?.nr || "");
  const primary = primaryCaseNumber(entry);
  const customerTokens = meaningfulTokens(entry?.kunde || "");
  if (invoiceNumber && existingInvoices.includes(invoiceNumber)) {
    score += 20;
    reasons.push("eksisterende fakturanr.");
  }
  if (address && address.length >= 6 && source.includes(address)) {
    score += 10;
    reasons.push("adresse");
  }
  if (address && normalizeAddressAlias(invoiceText).includes(normalizeAddressAlias(entry?.adr || ""))) {
    score += 10;
    reasons.push("adresse");
  }
  const looseInvoiceAddress = normalizeAddressForLooseMatch(invoiceText);
  const looseEntryAddress = normalizeAddressForLooseMatch(entry?.adr || "");
  if (looseEntryAddress && looseEntryAddress.length >= 8 && looseInvoiceAddress.includes(looseEntryAddress)) {
    score += 10;
    reasons.push("adresse");
  }
  if (sid && sid.length >= 4 && normalizeCaseKey(invoiceText).includes(sid)) {
    score += 8;
    reasons.push("sagsID");
  }
  if (nr && nr.length >= 4 && normalizeCaseKey(invoiceText).includes(nr)) {
    score += 5;
    reasons.push("sagsnr");
  }
  if (primary && primary.length >= 4 && normalizeCaseKey(invoiceText).includes(primary)) {
    score += 3;
    reasons.push("kundenr");
  }
  if (customer && customer.length >= 5 && source.includes(customer)) {
    score += 4;
    reasons.push("kunde");
  }
  if (customerTokens.length >= 2 && customerTokens.every((token) => source.includes(token))) {
    score += 9;
    reasons.push("kunde");
  }
  if (task && task.length >= 10 && source.includes(task)) {
    score += 2;
    reasons.push("opgave");
  }
  return { score, reasons };
}

function matchInvoiceToCase(state: any, invoiceText: string, invoiceNumber = "") {
  const entries = Array.isArray(state?.sager) ? state.sager : [];
  const ranked = entries
    .map((entry: any) => ({ entry, ...scoreInvoiceCase(entry, invoiceText, invoiceNumber) }))
    .filter((result: any) => result.score > 0)
    .sort((a: any, b: any) => b.score - a.score);
  const best = ranked[0];
  const second = ranked[1];
  if (!best) return { matched: null, score: 0, reasons: [], ambiguous: false };
  const ambiguous = Boolean(second && second.score >= best.score - 2);
  const hasStrongReason = best.reasons.includes("eksisterende fakturanr.") || best.reasons.includes("adresse") || best.reasons.includes("sagsID") || best.reasons.includes("kunde");
  if (best.score < 8 || !hasStrongReason || ambiguous) {
    return { matched: null, score: best.score, reasons: best.reasons, ambiguous };
  }
  return { matched: best.entry, score: best.score, reasons: best.reasons, ambiguous: false };
}

async function extractInvoiceAttachmentText(summaries: any[]) {
  const parts: string[] = [];
  for (const message of summaries) {
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    for (const attachment of attachments) {
      const filename = textValue(attachment?.filename, "");
      const attachmentId = textValue(attachment?.attachmentId, "");
      const mimeType = textValue(attachment?.mimeType, "");
      if (!attachmentId || !/faktura|invoice/i.test(filename)) continue;
      parts.push(filename);
      if (!/pdf/i.test(mimeType) && !/\.pdf$/i.test(filename)) continue;
      try {
        const buffer = await getGmailAttachment(message.id, attachmentId);
        const text = extractPdfText(buffer);
        if (text) parts.push(text);
      } catch {
        // Filename is still useful for matching even when PDF text extraction fails.
      }
    }
  }
  return parts.join("\n\n");
}

async function registerInvoicesFromThreads(state: any, threads: any[]) {
  let changed = 0;
  const changedCases: any[] = [];
  for (const thread of threads) {
    const summaries = Array.isArray(thread?.messages) ? thread.messages.map(gmailMessageSummary) : [];
    const attachmentText = await extractInvoiceAttachmentText(summaries);
    const threadText = summaries
      .map((message) => [
        message.subject,
        message.from,
        message.snippet,
        message.body,
        ...(Array.isArray(message.attachments) ? message.attachments.map((attachment: any) => attachment?.filename) : []),
      ].filter(Boolean).join("\n"))
      .join("\n\n") + (attachmentText ? `\n\n${attachmentText}` : "");
    const invoiceMatch = threadText.match(/\bfaktura\s*(?:nr\.?|nummer)?\s*[:#-]?\s*(\d{3,})\b/i);
    if (!invoiceMatch) continue;
    const match = matchInvoiceToCase(state, threadText, invoiceMatch[1]);
    if (!match.matched) {
        appendSyncLog(state, {
          status: "needs_review",
          threadId: textValue(thread?.id, ""),
          subject: summaries[0]?.subject || `Faktura ${invoiceMatch[1]}`,
        customerName: "",
        caseId: "",
        documentType: "Faktura",
        category: "betaling",
        error: match.ambiguous ? "invoice_match_ambiguous" : "invoice_match_low_confidence",
        notes: `Faktura ${invoiceMatch[1]} kræver manuel match. Den blev ikke arkiveret, fordi mailtekst/filnavn ikke matcher en sag sikkert. Bedste score: ${match.score || 0}${match.reasons?.length ? ` (${match.reasons.join(", ")})` : ""}.`,
      });
      continue;
    }
    const matched = match.matched;
    const date = extractDocumentDate(summaries[0]?.subject || "", threadText, summaries[0]?.date);
    const dueDate = extractInvoiceDueDate(threadText);
    const amount = extractInvoiceAmount(threadText);
    const didApply = applyInvoiceToCase(matched, invoiceMatch[1], date, amount, dueDate);
    const didCreateReplyTask = ensureCustomerReplyTasksFromInvoiceThread(matched, threadText, invoiceMatch[1]);
    const paidConfirmed = invoicePaidConfirmed(threadText);
    const didMarkPaid = paidConfirmed
      ? applyInvoicePaidToCase(state, matched, invoiceMatch[1], date, amount, "betalingsbekræftelse i mail")
      : false;
    if (didApply) {
      appendActivity(matched, { name: "Gmail-sync", email: MAILBOX_OWNER }, {
        type: "invoice_update",
        title: `Faktura ${invoiceMatch[1]} registreret`,
        summary: `Faktura ${invoiceMatch[1]} er registreret på sagen via Gmail-sync (${match.reasons.join(", ")}).`,
      });
    }
    if (didCreateReplyTask) {
      appendActivity(matched, { name: "Gmail-sync", email: MAILBOX_OWNER }, {
        type: "task_created",
        title: "Kundesvar på faktura kræver handling",
        summary: `Kunden har svaret i fakturatråden for faktura ${invoiceMatch[1]}. Der er oprettet en opgave på sagen.`,
      });
      appendSyncLog(state, {
        status: "task_created",
        threadId: textValue(thread?.id, ""),
        subject: `Kundesvar på faktura ${invoiceMatch[1]}`,
        customerName: textValue(matched?.kunde, ""),
        caseId: formatCaseIdForDisplay(matched),
        documentType: "Opgave",
        category: "sager",
        notes: "Kunden beder om udbedring af sidste detaljer, billeder efter udførelse eller anden dokumentation.",
      });
    }
    if (didApply || didMarkPaid || didCreateReplyTask) {
      changed += 1;
      if (didApply || didMarkPaid) {
        changedCases.push({
          threadId: textValue(thread?.id, ""),
          caseId: formatCaseIdForDisplay(matched),
          customerName: textValue(matched?.kunde, ""),
          invoiceNumber: invoiceMatch[1],
          amount,
          paid: paidConfirmed,
        });
      }
    }
  }
  return { changed, changedCases };
}

async function ensureDriveFoldersForLinkedCases(state: any) {
  const ensured: any[] = [];
  const entries = Array.isArray(state?.sager) ? state.sager : [];
  const ensureOne = async (entry: any) => {
    ensureCaseShape(entry);
    await ensureCaseDriveFolders(entry, formatCaseIdForDisplay(entry), textValue(entry?.kunde, ""));
    const caseId = formatCaseIdForDisplay(entry);
    const customerName = textValue(entry?.kunde, "");
    appendSyncLog(state, {
      status: "skipped",
      subject: "Drive-mapper",
      customerName,
      caseId,
      documentType: "Mappestruktur",
      category: "drive",
      notes: "Standardmapper er sikret i Drive.",
    });
    ensured.push({
      caseId,
      customerName,
      driveUrl: textValue(entry?.docs?.drive || entry?.drive, ""),
    });
  };

  for (const entry of entries) {
    ensureCaseShape(entry);
    const driveUrl = textValue(entry?.docs?.drive || entry?.drive, "");
    if (!driveUrl) continue;
    const marker = plainCompactText(`${entry?.kunde || ""} ${entry?.adr || ""} ${entry?.opg || ""} ${driveUrl}`);
    const isCurrentArchiveCandidate =
      marker.includes("gadesvej") ||
      driveUrl.includes("1IPXK472x8-Peasfv7kKU-JrG9oUNb6-4");
    if (!isCurrentArchiveCandidate) continue;
    try {
      await ensureOne(entry);
    } catch (error) {
      appendSyncLog(state, {
        status: "error",
        subject: "Drive-mapper",
        customerName: textValue(entry?.kunde, ""),
        caseId: formatCaseIdForDisplay(entry),
        documentType: "Mappestruktur",
        category: "drive",
        error: formatSyncError(error),
        notes: "Kunne ikke sikre standardmapper for sagen.",
      });
    }
  }
  return ensured;
}

function extractDocumentDate(subject = "", body = "", fallbackIso = "") {
  const source = `${subject}\n${body}`;
  const monthPattern = new RegExp(`(\\d{1,2})\\.\\s*(${Object.keys(DANISH_MONTHS).join("|")})\\s*(\\d{4})`, "i");
  const monthHit = source.match(monthPattern);
  if (monthHit) {
    const day = monthHit[1].padStart(2, "0");
    const month = DANISH_MONTHS[monthHit[2].toLowerCase()];
    const year = monthHit[3];
    if (month) return `${year}-${month}-${day}`;
  }

  const numericHit = source.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/);
  if (numericHit) {
    return `${numericHit[3]}-${numericHit[2].padStart(2, "0")}-${numericHit[1].padStart(2, "0")}`;
  }

  const fallback = String(fallbackIso || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(fallback) ? fallback : new Date().toISOString().slice(0, 10);
}

function inferArchiveSignal(subject = "", body = "", from = "") {
  const subjectSource = plainCompactText(subject);
  const source = plainCompactText(`${subject}\n${body}`);
  const rawSubject = String(subject || "").trim();
  const invoiceMatch = rawSubject.match(/faktura\s+(\d{3,})/i);
  if (!source) return null;
  const isPladebutikMangelMeeting =
    (source.includes("pladebutik") || source.includes("blagardsgade 14") || source.includes("blaagardsgade 14")) &&
    (/udbedring|mangel|mangler|fejl|afslutning|afslutningsmode|billeder|dokumentation/.test(source));
  if (isPladebutikMangelMeeting) {
    return {
      category: "referater",
      documentType: source.includes("afslutningsmode") ? "Afslutningsmoede" : "Byggemodereferat",
      sourceType: isInternalSender(from) ? "internal" : "external",
      fileLabel: source.includes("afslutningsmode") ? "Afslutningsmoede" : "Fejl og mangler moede",
    };
  }
  if (source.includes("microcement") || source.includes("microcoat") || source.includes("urban hald")) {
    return {
      category: "ks",
      documentType: "Materialevalg",
      sourceType: isInternalSender(from) ? "internal" : "external",
      fileLabel: "Materialevalg microcement",
    };
  }
  if (/byggemodereferat|byggemode referat|byggemode|modereferat|moedereferat|referat/.test(subjectSource) || /byggemodereferat|byggemode referat|byggemode|modereferat|moedereferat|referat/.test(source)) {
    return {
      category: "referater",
      documentType: /byggemodereferat|byggemode|moedereferat|modereferat/.test(source) ? "Byggemodereferat" : "Referat",
      sourceType: isInternalSender(from) ? "internal" : "external",
      fileLabel: "",
    };
  }
  if ((subjectSource.includes("kingosvej 1b") && /oversigt|ombygningsarbejder|tilbud/.test(source)) || /transparent oversigt over ombygningsarbejder/.test(source)) {
    return {
      category: "tilbud",
      documentType: "Tilbud",
      sourceType: isInternalSender(from) ? "internal" : "external",
      fileLabel: rawSubject || "Tilbud",
    };
  }
  if (/tilbud|overslagspris|prisgrundlag/.test(subjectSource)) {
    return {
      category: "tilbud",
      documentType: "Tilbud",
      sourceType: isInternalSender(from) ? "internal" : "external",
      fileLabel: rawSubject || "Tilbud",
    };
  }
  if (/tilbud|overslagspris|prisgrundlag/.test(source)) {
    return {
      category: "tilbud",
      documentType: "Tilbud",
      sourceType: isInternalSender(from) ? "internal" : "external",
      fileLabel: rawSubject || "Tilbud",
    };
  }
  if (invoiceMatch) {
    return {
      category: "betaling",
      documentType: "Faktura",
      sourceType: isInternalSender(from) ? "internal" : "external",
      fileLabel: `Faktura ${invoiceMatch[1]}`,
      invoiceNumber: invoiceMatch[1],
    };
  }
  return null;
}

async function extractAttachmentContext(thread: any) {
  const summaries = Array.isArray(thread?.messages) ? thread.messages.map(gmailMessageSummary) : [];
  const documents: any[] = [];
  const texts: string[] = [];

  for (const message of summaries) {
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    for (const attachment of attachments) {
      const mimeType = textValue(attachment?.mimeType, "");
      const filename = textValue(attachment?.filename, "");
      if (!filename) continue;
      documents.push({
        filename,
        mimeType: mimeType || "application/octet-stream",
        sourceMessageId: message.id,
      });
      texts.push(filename);
      if ((/pdf/i.test(mimeType) || /\.pdf$/i.test(filename)) && textValue(attachment?.attachmentId, "")) {
        try {
          const buffer = await getGmailAttachment(message.id, attachment.attachmentId);
          const pdfText = extractPdfText(buffer);
          if (pdfText) texts.push(pdfText);
        } catch {
          // Filename is still archived even if PDF text extraction fails.
        }
      }
    }
  }

  return {
    text: texts.join("\n\n"),
    documents,
  };
}

function inferCustomerName(thread: any, sager: any[]) {
  const messages = Array.isArray(thread?.messages) ? thread.messages.map(gmailMessageSummary) : [];
  const combined = messages
    .map((message) => [message.subject, message.from, message.snippet, message.body].filter(Boolean).join("\n"))
    .join("\n\n");
  const matched = matchCaseFromText(sager, combined);
  if (matched) return textValue(matched.kunde, "Ukendt kunde");
  const external = messages.find((message) => !isInternalSender(message.from));
  if (/@dke\.dk/i.test(String(external?.from || ""))) return "DKE";
  if (external?.from) return textValue(external.from.split("<")[0].trim(), "Ukendt kunde");
  return "SMG / NSTSF";
}

function inferTagsAndType(subject = "", body = "", from = "") {
  const source = String(`${subject} ${body}`).toLowerCase();
  const tags = new Set<string>();
  if (/tilbud|overslagspris|prisgrundlag|pipeline/.test(source)) tags.add("tilbud");
  if (/referat|byggemøde|aflevering/.test(source)) tags.add("referat");
  if (/mangel|skade|fejl|udbedr/.test(source)) tags.add("mangler");
  if (/billeder|foto|ks|dokumentation/.test(source)) tags.add("billeder");
  if (/dato|hvornår|deadline|mandag|tirsdag|onsdag|torsdag|fredag/.test(source)) tags.add("dato");
  if (isInternalSender(from)) tags.add("internt");
  return {
    tags: [...tags],
    type: tags.has("tilbud") ? "sales" : "todo",
  };
}

function topicTokens(subject = "", body = "") {
  const source = `${subject} ${body}`
    .toLowerCase()
    .replace(/[^a-z0-9æøå\s]/g, " ");
  const stop = new Set([
    "vedr",
    "re",
    "sv",
    "vs",
    "fw",
    "fwd",
    "mail",
    "sag",
    "kunde",
    "til",
    "fra",
    "ang",
    "status",
    "helt",
    "skal",
    "med",
    "for",
    "der",
    "det",
    "har",
    "som",
    "ikke",
  ]);
  return [...new Set(source.split(/\s+/).filter((token) => token.length >= 4 && !stop.has(token)))];
}

function similarTopic(a: any, b: any) {
  const left = topicTokens(a?.subject, a?.body);
  const right = new Set(topicTokens(b?.subject, b?.body));
  const overlap = left.filter((token) => right.has(token));
  return overlap.length >= 1;
}

function sameCustomer(a: any, b: any) {
  const left = String(a?.kunde || "").toLowerCase();
  const right = String(b?.kunde || "").toLowerCase();
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.includes("dke") && right.includes("dke")) return true;
  return false;
}

function resolveHandledItems(items: any[]) {
  return items.map((item) => {
    if (item.handled) return item;
    const currentDate = new Date(String(item.date || "")).getTime();
    const newerInternal = items.find((candidate) => {
      if (!candidate || candidate === item) return false;
      if (candidate.latestSenderType !== "internal") return false;
      if (!sameCustomer(item, candidate)) return false;
      if (!similarTopic(item, candidate)) return false;
      return new Date(String(candidate.date || "")).getTime() > currentDate;
    });
    return newerInternal ? { ...item, handled: true } : item;
  });
}

function toEmailEntry(thread: any, sager: any[]) {
  const summaries = Array.isArray(thread?.messages) ? thread.messages.map(gmailMessageSummary) : [];
  if (!summaries.length) return null;
  const dated = summaries
    .map((summary) => ({ ...summary, isoDate: parseMessageDate(summary) }))
    .sort((a, b) => String(a.isoDate).localeCompare(String(b.isoDate)));
  const latest = dated[dated.length - 1];
  const latestExternal = [...dated].reverse().find((summary) => !isInternalSender(summary.from));
  const latestIsInternal = isInternalSender(latest.from);
  const hasExternal = dated.some((summary) => !isInternalSender(summary.from));
  const { tags, type } = inferTagsAndType(latest.subject, latest.body, latest.from);
  return {
    id: textValue(thread?.id, latest.id),
    threadId: textValue(thread?.id, latest.threadId),
    kunde: inferCustomerName(thread, sager),
    from: latest.from,
    subject: latest.subject || textValue(thread?.snippet, "Mail uden emne"),
    date: latest.isoDate,
    preview: latest.snippet || latest.body.slice(0, 180),
    body: latest.body || latest.snippet,
    tags,
    handled: hasExternal ? latestIsInternal : false,
    type,
    latestSenderType: latestIsInternal ? "internal" : "external",
    repliedAt: latestIsInternal && latestExternal ? latest.isoDate : "",
    syncedAt: new Date().toISOString(),
  };
}

function buildArchiveMarkdown(thread: any, item: any, matched: any, signal: any, documentDate: string) {
  const summaries = Array.isArray(thread?.messages) ? thread.messages.map(gmailMessageSummary) : [];
  const displayCaseId = formatCaseIdForDisplay(matched);
  const address = textValue(matched?.adr, "");
  const blocks = summaries
    .map((message) => {
      const messageDate = parseMessageDate(message).slice(0, 10);
      const body = textValue(message.body || message.snippet, "").trim();
      return [
        "## Mail",
        `- Fra: ${textValue(message.from, "Ukendt afsender")}`,
        `- Dato: ${messageDate}`,
        `- Emne: ${textValue(message.subject, item.subject || "Mail uden emne")}`,
        "",
        body || "_Ingen tekst udtrukket fra mailen._",
      ].join("\n");
    })
    .join("\n\n---\n\n");

  return [
    `# ${signal.documentType}`,
    "",
    `- Dato: ${documentDate}`,
    `- Kunde/Sag: ${displayCaseId || "Ikke fundet"}`,
    `- Kunde: ${textValue(matched?.kunde, item.kunde || "Ukendt kunde")}`,
    address ? `- Adresse: ${address}` : "",
    `- Arkiveret fra mailtråd: ${textValue(item.subject, "Mail uden emne")}`,
    "",
    "## Kort resume",
    "",
    textValue(item.preview || item.body, "Ingen preview fra mailen."),
    "",
    "## Vedhæftninger",
    "",
    summaries
      .flatMap((message) => Array.isArray(message.attachments) ? message.attachments : [])
      .map((attachment: any) => `- ${textValue(attachment?.filename, "Vedhæftning uden navn")}`)
      .join("\n") || "_Ingen vedhæftninger registreret._",
    "",
    blocks,
    "",
  ]
    .filter(Boolean)
    .join("\n");
}

function normalizeFileStemPart(value = "") {
  return String(value || "")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildArchiveFileTitle(documentDate: string, signal: any, displayCaseId: string, subject = "") {
  const label = signal?.fileLabel || signal?.documentType || normalizeFileStemPart(subject) || "Dokument";
  const parts = [
    normalizeFileStemPart(documentDate),
    normalizeFileStemPart(displayCaseId),
    normalizeFileStemPart(label),
  ].filter(Boolean);
  if (parts.length) return parts.join(" - ");
  return normalizeFileStemPart(subject) || "Dokument";
}

function parseMoneyValue(value = "") {
  const normalized = String(value || "").replace(/\./g, "").replace(/\s/g, "").replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

function formatAmount(value: number) {
  return value > 0 ? String(Math.round(value)) : "";
}

function amountContextIsExVat(context = "") {
  const source = plainCompactText(context);
  if (!source.includes("moms")) return false;
  if (/\binkl\b|\binklusive\b|\bmed moms\b/.test(source)) return false;
  return /\bekskl\b|\beksklusive\b|\bex moms\b|\bexcl\b/.test(source);
}

function amountAsVatInclusive(value: number, context = "") {
  if (!value) return 0;
  return amountContextIsExVat(context) ? Math.round(value * 1.25) : value;
}

function invoiceLikeMoneyValues(text = "") {
  const source = String(text || "");
  return [...source.matchAll(/(\d{1,3}(?:[.\s]\d{3})*(?:,\d{2})?|\d{4,})(?:\s*kr\.?)?/gi)]
    .map((match) => parseMoneyValue(match[1]))
    .filter((value) => value >= 1000);
}

function vatInclusiveFromMoneyValues(values: number[], fallbackToLargest = false) {
  const unique = [...new Set(values)].filter((value) => value >= 1000).sort((a, b) => b - a);
  if (!unique.length) return 0;
  for (const subtotal of unique) {
    const vat = unique.find((value) => value < subtotal && value / subtotal >= 0.249 && value / subtotal <= 0.251);
    if (!vat) continue;
    const calculatedTotal = Math.round(subtotal + vat);
    const existingTotal = unique.find((value) => Math.abs(value - calculatedTotal) <= 2);
    return existingTotal || calculatedTotal;
  }
  return fallbackToLargest ? unique[0] : 0;
}

function extractEnterpriseAmount(text = "") {
  const source = String(text || "");
  const budgetRange = source.match(/budget[^\d]{0,40}(\d{1,3})\s*[-–]\s*(\d{1,3})\s*k\b/i);
  if (budgetRange) {
    const high = Number(budgetRange[2]);
    if (Number.isFinite(high) && high > 0) return high * 1000;
  }
  const patterns = [
    /(?:samlet\s+)?(?:entreprisesum|entreprise|tilbudssum|samlet\s+beløb|samlet\s+beloeb|overslagspris)[^\d]{0,80}(\d{1,3}(?:[.\s]\d{3})*(?:,\d{2})?|\d{4,})(?:\s*kr\.?)?/gi,
    /(\d{1,3}(?:[.\s]\d{3})*(?:,\d{2})?|\d{4,})\s*kr\.?[^\n\r]{0,80}(?:samlet\s+)?(?:entreprisesum|entreprise|tilbudssum|samlet\s+beløb|samlet\s+beloeb|overslagspris)/gi,
  ];
  const values: number[] = [];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) {
      const value = parseMoneyValue(match[1]);
      if (value >= 1000) values.push(amountAsVatInclusive(value, match[0]));
    }
  }
  return values.length ? Math.max(...values) : 0;
}

function cleanExtractedAddress(value = "") {
  return textValue(value, "")
    .replace(/\s+/g, " ")
    .replace(/\s+,/g, ",")
    .replace(/\b(st|kl|kld)\b\.?/gi, (match) => `${match.replace(/\./g, "").toLowerCase()}.`)
    .replace(/\b(tv|th|mf)\b\.?/gi, (match) => `${match.replace(/\./g, "").toLowerCase()}.`)
    .replace(/\s+$/g, "")
    .trim();
}

function extractDanishAddress(text = "") {
  const source = textValue(text, "");
  const pattern = /\b((?:(?:[A-ZÆØÅ]\.?\s*){1,3})?(?:[A-ZÆØÅ][A-Za-zÆØÅæøå.'-]*\s+){0,3}[A-ZÆØÅ][A-Za-zÆØÅæøå.'-]*(?:vej|gade|allé|alle|stræde|straede|plads|boulevard|vænge|vaenge|bakke|bakken)\s+\d+\s*[A-Za-z]?(?:\s*,?\s*(?:st\.?|kl\.?|kld\.?|\d+\.?)\s*(?:tv\.?|th\.?|mf\.?)?)?)/gu;
  const matches = [...source.matchAll(pattern)]
    .map((match) => cleanExtractedAddress(match[1]))
    .filter((value) => value && /\d/.test(value));
  return matches[0] || "";
}

function inferOfferCustomerName(text = "", messages: any[] = []) {
  const source = textValue(text, "");
  const greeting = source.match(/\bKære\s+([A-ZÆØÅ][A-Za-zÆØÅæøå'-]+(?:\s+[A-ZÆØÅ][A-Za-zÆØÅæøå'-]+){0,2})\b/);
  if (greeting?.[1]) return greeting[1].trim();
  const recipient = messages
    .flatMap((message) => textValue(message?.to, "").split(/,/))
    .map((value) => value.trim())
    .find((value) => value && !/@nstsf\.dk/i.test(value));
  const local = recipient?.match(/<?([^<@\s]+)@/)?.[1] || "";
  const name = local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
  return name || "Ny kunde";
}

function inferOfferScope(text = "") {
  const source = textValue(text, "");
  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const numbered = lines
    .map((line) => line.match(/^\d+[.)]\s+(.+)$/)?.[1]?.trim() || "")
    .filter((line) => line && line.length <= 120)
    .slice(0, 3);
  if (numbered.length === 1) return numbered[0];
  if (numbered.length > 1) {
    const last = numbered.at(-1);
    return `${numbered.slice(0, -1).join(", ")} og ${last}`;
  }
  return "Tilbud";
}

function findExistingCaseByAddress(sager: any[], address = "") {
  const target = normalizeAddressForLooseMatch(address);
  if (!target) return null;
  return (Array.isArray(sager) ? sager : []).find((entry: any) => {
    const current = normalizeAddressForLooseMatch(textValue(entry?.adr, ""));
    return current && (current.includes(target) || target.includes(current));
  }) || null;
}

function createCustomerCaseFromOffer(state: any, thread: any, signal: any, archiveText = "", documentDate = "") {
  if (!state || signal?.category !== "tilbud" || signal?.sourceType !== "internal") return null;
  const messages = Array.isArray(thread?.messages) ? thread.messages.map(gmailMessageSummary) : [];
  const address = extractDanishAddress(archiveText);
  if (!address) return null;
  const existing = findExistingCaseByAddress(state.sager || [], address);
  if (existing) return ensureCaseShape(existing);

  const customerNumber = nextCustomerNumber(state.sager || []);
  const customerName = inferOfferCustomerName(archiveText, messages);
  const offerAmount = extractEnterpriseAmount(archiveText);
  const created = ensureCaseShape({
    k: 4,
    sid: `${customerNumber}a`,
    nr: customerNumber,
    kunde: customerName,
    adr: address,
    opg: inferOfferScope(archiveText),
    b: offerAmount ? formatAmount(offerAmount) : "0",
    u: "0",
    dato: "",
    status: "Tilbud sendt",
    start: "",
    slut: "",
    sort: Array.isArray(state.sager) ? state.sager.length : 0,
    workflow: {
      offerDate: documentDate,
      latestOfferDate: documentDate,
      nextAction: "Følg op på tilbud.",
      currentStage: "Tilbud sendt",
    },
    docs: {},
  });
  state.sager = Array.isArray(state.sager) ? state.sager : [];
  state.sager.push(created);
  appendSyncLog(state, {
    status: "updated",
    threadId: textValue(thread?.id, ""),
    subject: "Ny kunde oprettet fra tilbud",
    customerName,
    caseId: formatCaseIdForDisplay(created),
    documentType: "Kunde",
    category: "kunder",
    notes: `${customerName} er oprettet som K-${customerNumber} med status Tilbud sendt ud fra tilbudsmailen.`,
  });
  return created;
}

function extractInvoiceAmount(text = "") {
  const source = String(text || "");
  const totalValues: number[] = [];
  const totalPattern = /(?:total(?:\s+inkl\.?\s+moms)?|i alt(?:\s+inkl\.?\s+moms)?|beløb\s+inkl\.?\s+moms|beloeb\s+inkl\.?\s+moms|saldo|at betale)[^\d]{0,80}(\d{1,3}(?:[.\s]\d{3})*(?:,\d{2})?|\d{4,})(?:\s*kr\.?)?/gi;
  let match: RegExpExecArray | null;
  while ((match = totalPattern.exec(source))) {
    const value = parseMoneyValue(match[1]);
    if (value >= 1000) totalValues.push(value);
  }
  const totalBlockPattern = /(?:total\s+dkk|total|i alt(?:\s+inkl\.?\s+moms)?|beløb\s+inkl\.?\s+moms|beloeb\s+inkl\.?\s+moms|at betale)[\s\S]{0,180}/gi;
  while ((match = totalBlockPattern.exec(source))) {
    const values = [...match[0].matchAll(/(\d{1,3}(?:[.\s]\d{3})*(?:,\d{2})?|\d{4,})/g)]
      .map((candidate) => parseMoneyValue(candidate[1]))
      .filter((value) => value >= 1000);
    if (values.length) totalValues.push(Math.max(...values));
  }

  const krValues: number[] = [];
  const krPattern = /(\d{1,3}(?:[.\s]\d{3})*(?:,\d{2})?|\d{4,})\s*kr\.?/gi;
  while ((match = krPattern.exec(source))) {
    const value = parseMoneyValue(match[1]);
    if (value >= 1000) krValues.push(value);
  }
  const vatInclusive = vatInclusiveFromMoneyValues(invoiceLikeMoneyValues(source), false);
  if (vatInclusive) totalValues.push(vatInclusive);
  if (totalValues.length) return Math.max(...totalValues);
  if (!krValues.length) return 0;
  return vatInclusiveFromMoneyValues(krValues, true);
}

function normalizeDanishDate(day = "", month = "", year = "") {
  const yyyy = String(year || "").padStart(4, "20");
  const mm = String(month || "").padStart(2, "0");
  const dd = String(day || "").padStart(2, "0");
  return /^\d{4}-\d{2}-\d{2}$/.test(`${yyyy}-${mm}-${dd}`) ? `${yyyy}-${mm}-${dd}` : "";
}

function extractInvoiceDueDate(text = "") {
  const source = String(text || "");
  const patterns = [
    /forfaldsdato[^\d]{0,30}(\d{1,2})[./-](\d{1,2})[./-](\d{4})/i,
    /fakturaen\s+betales\s+senest[^\d]{0,30}(\d{1,2})[./-](\d{1,2})[./-](\d{4})/i,
    /betales\s+senest[^\d]{0,30}(\d{1,2})[./-](\d{1,2})[./-](\d{4})/i,
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) return normalizeDanishDate(match[1], match[2], match[3]);
  }
  return "";
}

function ensureTask(matched: any, title: string, payload: Record<string, unknown>) {
  matched.tasks = Array.isArray(matched.tasks) ? matched.tasks : [];
  const existing = matched.tasks.some((task: any) => normalizeCaseKey(task?.title) === normalizeCaseKey(title) && String(task?.status || "").toLowerCase() !== "fuldført");
  if (existing) return false;
  matched.tasks.unshift({
    id: randomUUID(),
    title,
    status: "Åben",
    createdAt: new Date().toISOString(),
    ...payload,
  });
  return true;
}

function ensureCustomerReplyTasksFromInvoiceThread(matched: any, threadText = "", invoiceNumber = "") {
  const compact = plainCompactText(threadText);
  if (!compact) return false;
  const hasCustomerFollowup =
    compact.includes("vil i se pa") ||
    compact.includes("mangler at blive udbedret") ||
    compact.includes("send blot billeder") ||
    compact.includes("braendeovnsattest") ||
    compact.includes("brandeovnsattest") ||
    compact.includes("billeder nar det er udfort");
  if (!hasCustomerFollowup) return false;

  const needsPhotos = compact.includes("billeder") || compact.includes("photos");
  const needsFireplaceCertificate = compact.includes("braendeovnsattest") || compact.includes("brandeovnsattest");
  const needsPaint = compact.includes("botte maling") || compact.includes("bøtte maling") || compact.includes("maling til os");
  const notes = [
    `Kunden har svaret i fakturatråden${invoiceNumber ? ` for faktura ${invoiceNumber}` : ""} med konkrete udeståender.`,
    "- Udbedr de sidste detaljer/mangler jf. billedlinket.",
    needsPhotos ? "- Send billeder, når arbejdet er udført." : "",
    needsPaint ? "- Aftal/sæt en bøtte maling til drift pga. løbende facadeskader." : "",
    needsFireplaceCertificate ? "- Send brændeovnsattest for brændeovnen på 2. sal." : "",
  ].filter(Boolean).join("\n");
  return ensureTask(matched, "Udbedr sidste detaljer og send dokumentation", {
    dueDate: new Date().toISOString().slice(0, 10),
    owner: "Søren",
    notes,
    source: "gmail_invoice_reply",
    bucket: "now",
  });
}

function findCaseByAllMarkers(state: any, markers: string[]) {
  const markerCompacts = markers.map((marker) => plainCompactText(marker)).filter(Boolean);
  if (!markerCompacts.length) return null;
  const entries = Array.isArray(state?.sager) ? state.sager : [];
  const scored = entries
    .map((entry: any, index: number) => {
      const hay = plainCompactText(`${entry?.kunde || ""} ${entry?.adr || ""} ${entry?.opg || ""} ${entry?.info || ""}`);
      const score = markerCompacts.reduce((sum, marker) => sum + (hay.includes(marker) ? 1 : 0), 0);
      return { entry, index, score };
    })
    .filter((result) => result.score >= markerCompacts.length)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return scored[0]?.entry || null;
}

function applyArchiveSideEffects(matched: any, signal: any, archiveText = "", documentDate = "") {
  if (!matched || !signal) return;
  matched.workflow = matched.workflow && typeof matched.workflow === "object" ? matched.workflow : {};
  const enterpriseAmount = extractEnterpriseAmount(archiveText);
  if (enterpriseAmount) {
    const previous = parseMoneyValue(textValue(matched.b, ""));
    if (!previous || Math.abs(previous - enterpriseAmount) >= 1) {
      matched.b = formatAmount(enterpriseAmount);
      matched.workflow.enterpriseUpdatedAt = documentDate || new Date().toISOString().slice(0, 10);
    }
  }
  if (signal.category === "betaling") {
    if (signal.invoiceNumber) matched.fak = String(signal.invoiceNumber);
    const paidConfirmed = invoicePaidConfirmed(archiveText);
    const alreadyPaidSameInvoice = textValue(matched.status, "").toLowerCase().includes("betalt") &&
      (!signal.invoiceNumber || textValue(matched.fak || matched.workflow?.invoiceNumber, "") === textValue(signal.invoiceNumber, ""));
    matched.status = paidConfirmed || alreadyPaidSameInvoice ? "Faktura betalt" : "Faktura sendt";
    matched.workflow.invoiceNumber = textValue(signal.invoiceNumber, matched.workflow.invoiceNumber);
    matched.workflow.invoiceSentDate = documentDate || new Date().toISOString().slice(0, 10);
    const invoiceAmount = extractInvoiceAmount(archiveText);
    if (paidConfirmed) {
      matched.workflow.invoicePaidDate = documentDate || new Date().toISOString().slice(0, 10);
      if (invoiceAmount) matched.workflow.invoicePaidAmount = formatAmount(invoiceAmount);
      matched.u = "0";
    } else if (invoiceAmount && !alreadyPaidSameInvoice) {
      matched.u = formatAmount(invoiceAmount);
    }
    matched.dato = documentDate || matched.dato || new Date().toISOString().slice(0, 10);
    return;
  }
  if (signal.category === "referater") {
    const compact = plainCompactText(`${matched?.kunde || ""} ${matched?.adr || ""} ${matched?.opg || ""} ${archiveText}`);
    if (compact.includes("pladebutik") || compact.includes("blagardsgade 14") || compact.includes("blaagardsgade 14")) {
      matched.status = "Referat arkiveret";
      if ([2, 3, 4, 5].includes(Number(matched.k || 0))) matched.k = 1;
      matched.workflow.currentStage = textValue(matched.workflow.currentStage, "Fejl og mangler");
      matched.workflow.latestMeetingDate = documentDate || matched.workflow.latestMeetingDate || new Date().toISOString().slice(0, 10);
    }
  }
  if (signal.category === "tilbud") {
    if ([3, 5].includes(Number(matched.k || 0))) matched.k = 4;
    matched.status = "Tilbud sendt";
    matched.workflow.offerDate = textValue(matched.workflow.offerDate, documentDate);
    matched.workflow.latestOfferDate = documentDate || matched.workflow.latestOfferDate;
  }
}

function addDaysIso(dateIso: string, days: number) {
  const base = /^\d{4}-\d{2}-\d{2}$/.test(dateIso) ? new Date(`${dateIso}T00:00:00.000Z`) : new Date();
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

function ensureUnmatchedMailTask(state: any, result: any, item: any, errorText: string, possibleCase: any = null) {
  if (result?.error !== "case_not_matched") return false;
  state.internalTasks = Array.isArray(state.internalTasks) ? state.internalTasks : [];
  const threadId = textValue(result?.threadId || item?.threadId || item?.id, "");
  const title = textValue(item?.subject || result?.subject, "Mail kræver manuel opfølgning");
  const existing = state.internalTasks.some((task: any) =>
    textValue(task?.source, "") === "gmail_unmatched" &&
    (textValue(task?.threadId, "") === threadId || textValue(task?.title, "") === title) &&
    String(task?.status || "").toLowerCase() !== "fuldført"
  );
  if (existing) return false;
  state.internalTasks.unshift(normalizeInternalTask({
    id: `gmail-unmatched-${threadId || randomUUID()}`,
    title,
    status: "Åben",
    dueDate: "",
    owner: "",
    source: "gmail_unmatched",
    domain: "mail",
    bucket: "week",
    threadId,
    customerId: possibleCase ? primaryCaseNumber(possibleCase) : "",
    unlinkedRef: possibleCase ? "" : `S-${stableThreeDigitHash(`${title}|${threadId}`)}`,
    notes: `${errorText} Opret eller match kunden/sagen manuelt, og arkivér derefter mailen korrekt.`,
  }));
  return true;
}

function latestThreadSummary(thread: any) {
  const summaries = Array.isArray(thread?.messages) ? thread.messages.map(gmailMessageSummary) : [];
  if (!summaries.length) return null;
  return summaries
    .map((summary) => ({ ...summary, isoDate: parseMessageDate(summary) }))
    .sort((a, b) => String(a.isoDate).localeCompare(String(b.isoDate)))
    .at(-1);
}

function isLedgerFinalWithoutNewMessage(state: any, thread: any) {
  const threadId = textValue(thread?.id, "");
  const previous = ledgerEntryForThread(state, threadId);
  if (!previous || !isFinalLedgerStatus(previous.status)) return false;
  if (textValue(previous.status, "") === "needs_manual_match" && textValue(previous.resolverVersion, "") !== RESOLVER_VERSION) {
    return false;
  }
  const latest = latestThreadSummary(thread);
  if (!latest) return false;
  const previousMessageId = textValue(previous.latestMessageId, "");
  const previousMessageAt = textValue(previous.latestMessageAt, "");
  const latestMessageId = textValue(latest.id, "");
  const latestMessageAt = textValue(latest.isoDate, "");
  if (previousMessageId && latestMessageId && previousMessageId === latestMessageId) return true;
  if (previousMessageAt && latestMessageAt && previousMessageAt === latestMessageAt) return true;
  return false;
}

function fullThreadText(thread: any) {
  const summaries = Array.isArray(thread?.messages) ? thread.messages.map(gmailMessageSummary) : [];
  return summaries
    .map((message) => [message.subject, message.from, message.to, message.cc, message.snippet, message.body]
      .filter(Boolean)
      .join("\n"))
    .join("\n\n");
}

function isActionableInternalInboxMail(thread: any) {
  const latest = latestThreadSummary(thread);
  if (!latest || !isInternalSender(latest.from)) return false;
  const source = `${latest.subject || ""}\n${latest.snippet || ""}\n${latest.body || ""}`;
  const compact = plainCompactText(source);
  if (!compact) return false;
  if (/\b(til orientering|fyi|noteret|ingen kommentar|tak for info|bare til info)\b/i.test(source)) return false;
  const hasRequestSignal = /\?/.test(source) ||
    /\b(kan|vil|skal|ma|må)\s+(du|i|vi)\b/.test(compact) ||
    /\b(kan du|kan i|vil du|vil i|ma du|må du|ma i|må i|har du mulighed|har i mulighed)\b/.test(compact);
  const hasInstruction =
    /\b(skal|husk|afklar|aftal|send|ring|opret|folg op|lav|ryd|flyt|tjek|undersog|svar|book|planlaeg)\b/.test(compact) ||
    hasRequestSignal;
  const hasConcreteSignal =
    hasRequestSignal ||
    /\b(dato|deadline|frist|billeder|foto|ks|dokumentation|mangler|mangel|skade|fejl|udbedr|tilbud|faktura|betaling|bogforing|bogføring|kontrakt|lon|loen|køkken|kokken|aflevering|godkend|underskrift)\b/.test(compact);
  const isSmgInstruction = isSmgSender(latest.from) && hasConcreteSignal;
  return Boolean((hasInstruction && hasConcreteSignal) || isSmgInstruction);
}

function internalInboxTaskTitle(thread: any) {
  const latest = latestThreadSummary(thread);
  const subject = textValue(latest?.subject, "Intern mail kræver opfølgning")
    .replace(/^(re|sv|fw|fwd):\s*/i, "")
    .trim();
  return subject || "Intern mail kræver opfølgning";
}

function internalInboxTaskNotes(thread: any) {
  const latest = latestThreadSummary(thread);
  const body = textValue(latest?.body || latest?.snippet, "");
  const trimmed = body.replace(/\s+/g, " ").trim();
  const excerpt = trimmed.length > 240 ? `${trimmed.slice(0, 237)}...` : trimmed;
  return excerpt || "Intern/SMG-mail i indbakken indeholder en konkret handling. Vurder og luk opgaven, når den er håndteret.";
}

function internalInboxTaskBucket(thread: any) {
  const latest = latestThreadSummary(thread);
  const compact = plainCompactText(`${latest?.subject || ""}\n${latest?.body || latest?.snippet || ""}`);
  if (/\b(nu|akut|hurtigst|straks|i dag|idag)\b/.test(compact)) return "now";
  if (/\b(dato|deadline|frist|svar|aflevering|mangler|skade|fejl|udbedr|billeder|ks)\b/.test(compact)) return "today";
  return "week";
}

function ensureInternalInboxTask(state: any, thread: any) {
  if (!isActionableInternalInboxMail(thread)) return false;
  state.internalTasks = Array.isArray(state.internalTasks) ? state.internalTasks : [];
  const threadId = textValue(thread?.id, "");
  const text = fullThreadText(thread);
  const matched = matchCaseWithConfidence(state.sager || [], text);
  const title = internalInboxTaskTitle(thread);
  const notes = internalInboxTaskNotes(thread);
  const existingInternal = state.internalTasks.some((task: any) =>
    textValue(task?.source, "") === "gmail_internal_instruction" &&
    ((threadId && textValue(task?.threadId, "") === threadId) || normalizeCaseKey(task?.title) === normalizeCaseKey(title))
  );
  if (existingInternal) return false;

  if (matched.confident && matched.entry) {
    ensureCaseShape(matched.entry);
    matched.entry.tasks = Array.isArray(matched.entry.tasks) ? matched.entry.tasks : [];
    const existingCaseTask = matched.entry.tasks.some((task: any) =>
      textValue(task?.source, "") === "gmail_internal_instruction" &&
      ((threadId && textValue(task?.threadId, "") === threadId) || normalizeCaseKey(task?.title) === normalizeCaseKey(title))
    );
    if (existingCaseTask) return false;
    matched.entry.tasks.unshift({
      id: randomUUID(),
      title,
      status: "Åben",
      createdAt: new Date().toISOString(),
      dueDate: internalInboxTaskBucket(thread) === "week" ? "" : new Date().toISOString().slice(0, 10),
      owner: "Søren",
      notes,
      source: "gmail_internal_instruction",
      threadId,
    });
    return {
      created: true,
      title,
      notes,
      threadId,
      customerName: textValue(matched.entry.kunde, ""),
      caseId: formatCaseIdForDisplay(matched.entry),
      linked: true,
    };
  }

  const unlinkedRef = `S-${stableThreeDigitHash(`${title}|${threadId || text}`)}`;
  state.internalTasks.unshift(normalizeInternalTask({
    id: `gmail-internal-${threadId || randomUUID()}`,
    title,
    status: "Åben",
    dueDate: internalInboxTaskBucket(thread) === "week" ? "" : new Date().toISOString().slice(0, 10),
    owner: "Søren",
    notes,
    source: "gmail_internal_instruction",
    domain: "mail",
    bucket: internalInboxTaskBucket(thread),
    threadId,
    customerId: "",
    unlinkedRef,
  }));
  return {
    created: true,
    title,
    notes,
    threadId,
    customerName: "Intern opgave",
    caseId: unlinkedRef,
    linked: false,
  };
}

function ensureInternalInboxTasks(state: any, threads: any[]) {
  const created: any[] = [];
  for (const thread of threads) {
    const result = ensureInternalInboxTask(state, thread);
    if (result && typeof result === "object") created.push(result);
  }
  return created;
}

function threadIntentSignals(thread: any) {
  const latest = latestThreadSummary(thread);
  const text = fullThreadText(thread);
  const compact = plainCompactText(`${latest?.subject || ""}\n${text}`);
  const source = `${latest?.subject || ""}\n${latest?.snippet || ""}\n${latest?.body || ""}`;
  const hasFyi = /\b(til orientering|fyi|noteret|ingen kommentar|tak for info|bare til info)\b/i.test(source);
  const hasQuestion = /\?/.test(source);
  const hasRequestSignal = hasQuestion ||
    /\b(kan|vil|skal|ma|må)\s+(du|i|vi)\b/.test(compact) ||
    /\b(kan du|kan i|vil du|vil i|ma du|må du|ma i|må i|har du mulighed|har i mulighed)\b/.test(compact);
  const hasInstruction = /\b(skal|husk|afklar|aftal|send|ring|opret|folg op|lav|ryd|flyt|tjek|undersog|svar|book|planlaeg|kan du|ma du gerne|må du gerne|vend venligst retur|giv besked)\b/.test(compact);
  const hasConcreteSignal = /\b(status|dato|deadline|frist|billeder|foto|ks|dokumentation|mangler|mangel|skade|fejl|udbedr|tilbud|faktura|betaling|bogforing|bogføring|kontrakt|lon|loen|kokken|køkken|aflevering|godkend|underskrift|plan)\b/.test(compact);
  const hasCustomerTaskSignal =
    compact.includes("bulowsvej") ||
    compact.includes("blaagardsgade") ||
    compact.includes("blagardsgade") ||
    compact.includes("ryesgade") ||
    compact.includes("lykkesholms") ||
    compact.includes("gadesvej") ||
    compact.includes("dke") ||
    compact.includes("charlotte");
  return {
    latest,
    text,
    compact,
    hasFyi,
    hasQuestion,
    hasRequestSignal,
    hasInstruction,
    hasConcreteSignal,
    hasCustomerTaskSignal,
    isInternal: isInternalSender(latest?.from || ""),
  };
}

function classifyThreadIntent(thread: any, item: any = null) {
  const signals = threadIntentSignals(thread);
  const latest = signals.latest;
  if (!latest) return { intent: "ignore", lane: "ignore", reason: "Tom Gmail-tråd." };
  const archiveSignal = inferArchiveSignal(item?.subject || latest.subject, signals.text || item?.body, latest.from);
  if (archiveSignal) {
    const lane = archiveSignal.category === "betaling"
      ? "invoice"
      : archiveSignal.category === "tilbud" || archiveSignal.category === "referater"
        ? "archive"
        : "archive";
    return { intent: "archive_candidate", lane, reason: `${archiveSignal.documentType} skal arkiveres.`, archiveSignal };
  }
  if (signals.hasFyi && !signals.hasQuestion && !signals.hasInstruction) {
    return { intent: "ignore", lane: "inbox", reason: "FYI/orientering uden konkret handling." };
  }
  if (signals.hasRequestSignal) {
    return { intent: "task_candidate", lane: signals.isInternal ? "internal" : "inbox", reason: "Mailen indeholder et spørgsmål eller en direkte anmodning." };
  }
  if ((signals.hasInstruction || signals.hasQuestion || signals.isInternal) && signals.hasConcreteSignal) {
    return { intent: "task_candidate", lane: signals.isInternal ? "internal" : "inbox", reason: "Mailen indeholder konkret handling eller afklaring." };
  }
  if (signals.hasCustomerTaskSignal && (signals.hasQuestion || signals.hasConcreteSignal)) {
    return { intent: "task_candidate", lane: "inbox", reason: "Kundespecifik statusmail kræver vurdering." };
  }
  return { intent: "ignore", lane: "inbox", reason: "Ingen arkiv-, kundeopdaterings- eller opgavesignal." };
}

function taskTitleFromThread(thread: any) {
  const latest = latestThreadSummary(thread);
  const subject = textValue(latest?.subject, "Mail kræver opfølgning")
    .replace(/^(re|sv|fw|fwd|vs):\s*/i, "")
    .trim();
  return subject || "Mail kræver opfølgning";
}

function taskNotesFromThread(thread: any) {
  const latest = latestThreadSummary(thread);
  const body = textValue(latest?.body || latest?.snippet, "");
  const trimmed = body.replace(/\s+/g, " ").trim();
  const excerpt = trimmed.length > 260 ? `${trimmed.slice(0, 257)}...` : trimmed;
  return excerpt || "Mailen indeholder en konkret handling eller afklaring. Vurder og luk opgaven, når den er håndteret.";
}

function taskBucketFromThread(thread: any) {
  const signals = threadIntentSignals(thread);
  if (/\b(nu|akut|hurtigst|straks|i dag|idag)\b/.test(signals.compact)) return "now";
  if (/\b(status|dato|deadline|frist|svar|aflevering|mangler|skade|fejl|udbedr|billeder|ks)\b/.test(signals.compact)) return "today";
  return "week";
}

function ensureTaskCandidateFromThread(state: any, thread: any) {
  state.internalTasks = Array.isArray(state.internalTasks) ? state.internalTasks : [];
  const threadId = textValue(thread?.id, "");
  const text = fullThreadText(thread);
  const matched = matchCaseWithConfidence(state.sager || [], text);
  const title = taskTitleFromThread(thread);
  const notes = taskNotesFromThread(thread);
  const bucket = taskBucketFromThread(thread);
  const dueDate = bucket === "week" ? "" : new Date().toISOString().slice(0, 10);

  const existingInternal = state.internalTasks.some((task: any) =>
    threadId && textValue(task?.threadId, "") === threadId && String(task?.status || "").toLowerCase() !== "fuldført"
  );
  if (existingInternal) return { created: false, reason: "Opgaven findes allerede.", threadId, title };

  if (matched.confident && matched.entry) {
    ensureCaseShape(matched.entry);
    matched.entry.tasks = Array.isArray(matched.entry.tasks) ? matched.entry.tasks : [];
    const existingCaseTask = matched.entry.tasks.some((task: any) =>
      threadId && textValue(task?.threadId, "") === threadId && String(task?.status || "").toLowerCase() !== "fuldført"
    );
    if (existingCaseTask) return { created: false, reason: "Opgaven findes allerede på sagen.", threadId, title };
    matched.entry.tasks.unshift({
      id: randomUUID(),
      title,
      status: "Åben",
      createdAt: new Date().toISOString(),
      dueDate,
      owner: "Søren",
      notes,
      source: "gmail_task_candidate",
      threadId,
    });
    return {
      created: true,
      threadId,
      title,
      notes,
      customerName: textValue(matched.entry.kunde, ""),
      caseId: formatCaseIdForDisplay(matched.entry),
      taskId: textValue(matched.entry.tasks[0]?.id, ""),
      linked: true,
    };
  }

  const existingByTitle = state.internalTasks.some((task: any) =>
    normalizeCaseKey(task?.title) === normalizeCaseKey(title) &&
    String(task?.status || "").toLowerCase() !== "fuldført"
  );
  if (existingByTitle) return { created: false, reason: "En tilsvarende intern opgave findes allerede.", threadId, title };
  const unlinkedRef = `S-${stableThreeDigitHash(`${title}|${threadId || text}`)}`;
  const task = normalizeInternalTask({
    id: `gmail-task-${threadId || randomUUID()}`,
    title,
    status: "Åben",
    dueDate,
    owner: "Søren",
    notes,
    source: "gmail_task_candidate",
    domain: "mail",
    bucket,
    threadId,
    customerId: "",
    unlinkedRef,
  });
  state.internalTasks.unshift(task);
  return {
    created: true,
    threadId,
    title,
    notes,
    customerName: "Intern opgave",
    caseId: unlinkedRef,
    taskId: task.id,
    linked: false,
  };
}

function ensureOfferFollowupTask(matched: any, signal: any, archiveText: string, documentDate: string) {
  if (!matched) return;
  const compact = plainCompactText(archiveText);
  const isRelevant =
    signal?.category === "tilbud" ||
    compact.includes("tilbud") ||
    compact.includes("overslagspris") ||
    compact.includes("prisgrundlag");
  if (!isRelevant) return;
  matched.workflow = matched.workflow && typeof matched.workflow === "object" ? matched.workflow : {};
  matched.workflow.offerDate = textValue(matched.workflow.offerDate, documentDate);
  matched.workflow.latestOfferDate = textValue(matched.workflow.latestOfferDate, documentDate);
  matched.workflow.nextAction = textValue(matched.workflow.nextAction, "Følg op på tilbud.");
  const isRevised = compact.includes("revideret") || compact.includes("revidere") || compact.includes("revision");
  const title = isRevised ? "Følg op på revideret tilbud" : "Følg op på tilbud";
  const existing = (matched.tasks || []).some((task: any) => {
    return normalizeCaseKey(task?.title) === normalizeCaseKey(title) && String(task?.status || "").toLowerCase() !== "fuldført";
  });
  if (existing) return;
  matched.tasks = Array.isArray(matched.tasks) ? matched.tasks : [];
  matched.tasks.unshift({
    id: randomUUID(),
    title,
    status: "Åben",
    dueDate: addDaysIso(documentDate, 7),
    owner: "Søren",
    notes: `${isRevised ? "Der er afgivet et revideret tilbud" : "Der er afgivet et tilbud"}. Følg op med kunden senest syv dage efter tilbudsdatoen.`,
    createdAt: new Date().toISOString(),
  });
}

function repairDocsFromActivityLog(state: any) {
  const entries = Array.isArray(state?.sager) ? state.sager : [];
  let repaired = 0;
  for (const entry of entries) {
    ensureCaseShape(entry);
    const activities = Array.isArray(entry.activityLog) ? entry.activityLog : [];
    for (const activity of activities) {
      if (textValue(activity?.type, "") !== "gmail_archive") continue;
      const category = textValue(activity?.archiveCategory || activity?.category, "");
      if (!category || !Array.isArray(entry.docs?.[category])) continue;
      const fileName = textValue(activity?.fileName, "");
      const driveUrl = textValue(activity?.driveUrl, "");
      const documentDate = textValue(activity?.documentDate, textValue(activity?.createdAt, "").slice(0, 10));
      const archiveKey = textValue(activity?.archiveKey, "");
      const threadId = textValue(activity?.threadId, "");
      const title = fileName
        ? fileName.replace(/\.md$/i, "")
        : textValue(activity?.subject || activity?.documentType, "Dokument");
      const before = entry.docs[category].length;
      pushDocs(entry.docs[category], [{
        titel: title,
        dato: documentDate,
        url: driveUrl,
        fileName,
        mimeType: "text/markdown",
        archiveKey,
        threadId,
        notes: textValue(activity?.notes, ""),
      }]);
      if (entry.docs[category].length > before) repaired += 1;
      if (category === "referater" && Array.isArray(entry.docs.byggereferater)) {
        const referatBefore = entry.docs.byggereferater.length;
        pushDocs(entry.docs.byggereferater, [{
          titel: title,
          dato: documentDate,
          url: driveUrl,
          fileName,
          mimeType: "text/markdown",
          archiveKey,
          threadId,
          notes: textValue(activity?.notes, ""),
        }]);
        if (entry.docs.byggereferater.length > referatBefore) repaired += 1;
      }
    }
  }
  return repaired;
}

function rebuildArchiveManifestFromActivities(state: any) {
  const entries = Array.isArray(state?.sager) ? state.sager : [];
  let changed = 0;
  for (const entry of entries) {
    ensureCaseShape(entry);
    const caseId = formatCaseIdForDisplay(entry);
    const activities = Array.isArray(entry.activityLog) ? entry.activityLog : [];
    for (const activity of activities) {
      if (textValue(activity?.type, "") !== "gmail_archive") continue;
      const archiveKey = textValue(activity?.archiveKey, "");
      if (!archiveKey) continue;
      if (archiveManifestEntry(state, archiveKey)) continue;
      registerArchiveManifest(state, archiveKey, {
        threadId: textValue(activity?.threadId, ""),
        caseId,
        customerName: textValue(entry?.kunde, ""),
        category: textValue(activity?.archiveCategory || activity?.category, ""),
        documentType: textValue(activity?.documentType, ""),
        documentDate: textValue(activity?.documentDate, textValue(activity?.createdAt, "").slice(0, 10)),
        title: textValue(activity?.fileName, "").replace(/\.md$/i, "") || textValue(activity?.subject || activity?.documentType, "Dokument"),
        fileName: textValue(activity?.fileName, ""),
        driveUrl: textValue(activity?.driveUrl, ""),
        fileId: textValue(activity?.fileId, ""),
        mimeType: "text/markdown",
        status: "archived",
        restoredFromActivityLog: true,
      });
      changed += 1;
    }
  }
  return changed;
}

async function archiveQualifiedThread(thread: any, item: any, state: any, integration: any, actor: any) {
  const summaries = Array.isArray(thread?.messages) ? thread.messages.map(gmailMessageSummary) : [];
  const threadText = summaries
    .map((message) => [message.subject, message.from, message.snippet, message.body].filter(Boolean).join("\n"))
    .join("\n\n");
  const initialSignal = inferArchiveSignal(item?.subject, threadText || item?.body, item?.from);
  if (!initialSignal) return null;
  const attachmentContext = await extractAttachmentContext(thread);
  const combined = [threadText, attachmentContext.text].filter(Boolean).join("\n\n");
  const signal = inferArchiveSignal(item?.subject, combined || threadText || item?.body, item?.from) || initialSignal;

  const archiveText = combined || `${item?.subject}\n${item?.body}`;
  let matched = null;
  const currentThreadId = textValue(item?.threadId || thread?.id, "");
  const manualResolution = manualReviewResolutionForThread(state, currentThreadId);
  if (manualResolution?.action === "match_case" && manualResolution?.caseId) {
    matched = findCaseByDisplayRef(state, textValue(manualResolution.caseId, ""));
  }
  if (!matched && signal.category === "betaling") {
    const invoiceMatch = archiveText.match(/\bfaktura\s*(?:nr\.?|nummer)?\s*[:#-]?\s*(\d{3,})\b/i);
    const invoiceCaseMatch = matchInvoiceToCase(state, archiveText, invoiceMatch?.[1] || "");
    if (!invoiceCaseMatch.matched) {
      return {
        ok: false,
        threadId: textValue(item?.threadId || thread?.id, ""),
        subject: textValue(item?.subject, ""),
        customerName: textValue(item?.kunde, ""),
        documentType: signal.documentType,
        category: signal.category,
        error: invoiceCaseMatch.ambiguous ? "invoice_match_ambiguous" : "invoice_match_low_confidence",
        matchedCaseId: "",
        invoiceNumber: invoiceMatch?.[1] || "",
      };
    }
    matched = invoiceCaseMatch.matched;
  } else if (!matched) {
    matched = matchCaseFromText(state.sager || [], archiveText);
  }
  const documentDate = extractDocumentDate(item?.subject, combined || item?.body, item?.date);
  if (!matched && signal.category === "tilbud") {
    matched = createCustomerCaseFromOffer(state, thread, signal, archiveText, documentDate);
  }
  if (!matched) {
    return {
      ok: false,
      threadId: textValue(item?.threadId || thread?.id, ""),
      subject: textValue(item?.subject, ""),
      customerName: textValue(item?.kunde, ""),
      documentType: signal.documentType,
      category: signal.category,
      error: "case_not_matched",
      possibleCase: matchCaseWithConfidence(state.sager || [], archiveText).entry,
    };
  }

  ensureCaseShape(matched);
  const displayCaseId = formatCaseIdForDisplay(matched) || textValue(matched?.nr, "");
  const archiveKey = buildArchiveKey(thread, signal, documentDate, displayCaseId, item?.subject || archiveText);
  const fileTitle = buildArchiveFileTitle(documentDate, signal, displayCaseId, item?.subject);
  const fileName = `${fileTitle}.md`;
  const existingManifest = archiveManifestEntry(state, archiveKey);
  if (existingManifest?.driveUrl || existingManifest?.fileName) {
    const repairedDocument = {
      title: textValue(existingManifest.title, fileTitle),
      fileName: textValue(existingManifest.fileName, fileName),
      mimeType: textValue(existingManifest.mimeType, "text/markdown"),
      date: textValue(existingManifest.documentDate, documentDate),
      url: textValue(existingManifest.driveUrl, ""),
      fileId: textValue(existingManifest.fileId, ""),
      archiveKey,
      threadId: currentThreadId,
      notes: `Automatisk arkiveret fra Gmail-sync. Tråd: ${currentThreadId}`,
    };
    pushDocs(matched.docs[signal.category] || [], [repairedDocument]);
    if (signal.category === "referater") {
      pushDocs(matched.docs.byggereferater, [repairedDocument]);
    }
    recordProjection(state, archiveKey, {
      status: "skipped_existing_manifest",
      threadId: currentThreadId,
      caseId: displayCaseId,
      customerName: textValue(matched?.kunde, item?.kunde || ""),
      category: signal.category,
      documentType: signal.documentType,
      documentDate,
      fileName: textValue(existingManifest.fileName, fileName),
      driveUrl: textValue(existingManifest.driveUrl, ""),
      fileId: textValue(existingManifest.fileId, ""),
    });
    closeReviewQueueItem(state, currentThreadId, archiveKey);
    return {
      ok: true,
      skipped: true,
      archiveKey,
      category: signal.category,
      matchedCaseId: displayCaseId,
      customerName: textValue(matched?.kunde, item?.kunde || ""),
      documentType: signal.documentType,
      documentDate,
      driveUrl: textValue(existingManifest.driveUrl, ""),
      fileName: textValue(existingManifest.fileName, fileName),
    };
  }
  applyArchiveSideEffects(matched, signal, archiveText, documentDate);
  ensureOfferFollowupTask(matched, signal, archiveText, documentDate);
  const normalizedDocumentType = normalizeCaseKey(signal.documentType);

  const alreadyArchived = (matched.activityLog || []).some((entry: any) => {
    if (String(entry?.type) !== "gmail_archive") return false;
    if (String(entry?.archiveKey || "") === archiveKey) return true;
    const sameThread = textValue(entry?.threadId, "") === currentThreadId;
    const sameType = normalizeCaseKey(entry?.documentType) === normalizedDocumentType;
    const sameDate = textValue(entry?.documentDate, "") === documentDate;
    const sameFile = textValue(entry?.fileName, "") === fileName;
    return sameFile || (sameThread && sameType && sameDate);
  });
  if (alreadyArchived) {
    const existingEntry = (matched.activityLog || []).find((entry: any) => {
      if (String(entry?.type) !== "gmail_archive") return false;
      if (String(entry?.archiveKey || "") === archiveKey) return true;
      const sameThread = textValue(entry?.threadId, "") === currentThreadId;
      const sameType = normalizeCaseKey(entry?.documentType) === normalizedDocumentType;
      const sameDate = textValue(entry?.documentDate, "") === documentDate;
      const sameFile = textValue(entry?.fileName, "") === fileName;
      return sameFile || (sameThread && sameType && sameDate);
    }) || {};
    const repairedDocument = {
      title: fileTitle,
      fileName,
      mimeType: "text/markdown",
      date: documentDate,
      url: textValue(existingEntry?.driveUrl, ""),
      fileId: textValue(existingEntry?.fileId, ""),
      archiveKey,
      threadId: currentThreadId,
      notes: `Automatisk arkiveret fra Gmail-sync. Tråd: ${textValue(item?.threadId || thread?.id, "")}`,
    };
    registerArchiveManifest(state, archiveKey, {
      threadId: currentThreadId,
      caseId: displayCaseId,
      customerName: textValue(matched?.kunde, item?.kunde || ""),
      category: signal.category,
      documentType: signal.documentType,
      documentDate,
      title: fileTitle,
      fileName,
      driveUrl: textValue(existingEntry?.driveUrl, ""),
      fileId: textValue(existingEntry?.fileId, ""),
      mimeType: "text/markdown",
      status: "archived",
    });
    pushDocs(matched.docs[signal.category] || [], [repairedDocument]);
    if (signal.category === "referater") {
      pushDocs(matched.docs.byggereferater, [repairedDocument]);
    }
    recordProjection(state, archiveKey, {
      status: "skipped_existing_activity",
      threadId: currentThreadId,
      caseId: displayCaseId,
      customerName: textValue(matched?.kunde, item?.kunde || ""),
      category: signal.category,
      documentType: signal.documentType,
      documentDate,
      fileName,
      driveUrl: textValue(existingEntry?.driveUrl, ""),
      fileId: textValue(existingEntry?.fileId, ""),
    });
    closeReviewQueueItem(state, currentThreadId, archiveKey);
    return {
      ok: true,
      skipped: true,
      archiveKey,
      category: signal.category,
      matchedCaseId: displayCaseId,
      customerName: textValue(matched?.kunde, item?.kunde || ""),
      documentType: signal.documentType,
      documentDate,
      driveUrl: textValue(existingEntry?.driveUrl, ""),
      fileName,
    };
  }

  const document = {
    title: fileTitle,
    fileName,
    mimeType: "text/markdown",
    contentText: buildArchiveMarkdown(thread, item, matched, signal, documentDate),
    date: documentDate,
    archiveKey,
    threadId: currentThreadId,
    notes: `Automatisk arkiveret fra Gmail-sync. Tråd: ${textValue(item?.threadId || thread?.id, "")}`,
  };

  let driveFolder = textValue(matched.docs?.drive, "");
  let uploaded: any = null;
  let foundExistingDriveFile = false;
  if (integration.configured) {
    const folderInfo = await ensureCaseDriveFolders(matched, displayCaseId, matched.kunde);
    driveFolder = textValue(folderInfo?.caseFolder?.webViewLink, driveFolder);
    matched.docs.drive = driveFolder;
    const folderId = textValue(folderInfo?.folders?.[signal.category]?.id, "");
    if (!folderId) throw new Error(`drive_folder_missing:${signal.category}`);
    uploaded = await findDriveFileByName(folderId, fileName);
    foundExistingDriveFile = Boolean(uploaded);
    if (!uploaded) uploaded = await uploadDriveFile(folderId, document);
    document.url = textValue(uploaded?.webViewLink, "");
    document.fileId = textValue(uploaded?.id, "");
    document.mimeType = textValue(uploaded?.mimeType, document.mimeType);
  }

  if (foundExistingDriveFile) {
    pushDocs(matched.docs[signal.category] || [], [document]);
    if (signal.category === "referater") {
      pushDocs(matched.docs.byggereferater, [document]);
    }
    appendActivity(matched, actor, {
      type: "gmail_archive",
      archiveKey,
      threadId: textValue(item?.threadId || thread?.id, ""),
      subject: textValue(item?.subject, ""),
      archiveCategory: signal.category,
      documentType: signal.documentType,
      documentDate,
      fileName: document.fileName,
      driveUrl: textValue(document.url, ""),
      sourceType: signal.sourceType,
      attachmentCount: attachmentContext.documents.length,
      skippedUpload: true,
    });
    registerArchiveManifest(state, archiveKey, {
      threadId: currentThreadId,
      caseId: displayCaseId,
      customerName: textValue(matched?.kunde, item?.kunde || ""),
      category: signal.category,
      documentType: signal.documentType,
      documentDate,
      title: fileTitle,
      fileName: document.fileName,
      driveUrl: textValue(document.url, ""),
      fileId: textValue(document.fileId, ""),
      mimeType: textValue(document.mimeType, "text/markdown"),
      status: "archived",
      skippedUpload: true,
    });
    recordProjection(state, archiveKey, {
      status: "skipped_existing_drive_file",
      threadId: currentThreadId,
      caseId: displayCaseId,
      customerName: textValue(matched?.kunde, item?.kunde || ""),
      category: signal.category,
      documentType: signal.documentType,
      documentDate,
      fileName: document.fileName,
      driveUrl: textValue(document.url, ""),
      fileId: textValue(document.fileId, ""),
    });
    closeReviewQueueItem(state, currentThreadId, archiveKey);
    return {
      ok: true,
      skipped: true,
      archiveKey,
      category: signal.category,
      matchedCaseId: displayCaseId,
      customerName: textValue(matched?.kunde, item?.kunde || ""),
      documentType: signal.documentType,
      documentDate,
      driveUrl: textValue(document.url, ""),
      fileName,
      driveFolder,
    };
  }

  pushDocs(matched.docs[signal.category] || [], [document]);
  if (signal.category === "referater") {
    pushDocs(matched.docs.byggereferater, [document]);
  }
  appendActivity(matched, actor, {
    type: "gmail_archive",
    archiveKey,
    threadId: textValue(item?.threadId || thread?.id, ""),
    subject: textValue(item?.subject, ""),
    archiveCategory: signal.category,
    documentType: signal.documentType,
    documentDate,
    fileName: document.fileName,
    driveUrl: textValue(document.url, ""),
    sourceType: signal.sourceType,
    attachmentCount: attachmentContext.documents.length,
  });
  registerArchiveManifest(state, archiveKey, {
    threadId: currentThreadId,
    caseId: displayCaseId,
    customerName: textValue(matched?.kunde, item?.kunde || ""),
    category: signal.category,
    documentType: signal.documentType,
    documentDate,
    title: fileTitle,
    fileName: document.fileName,
    driveUrl: textValue(document.url, ""),
    fileId: textValue(document.fileId, ""),
    mimeType: textValue(document.mimeType, "text/markdown"),
    status: "archived",
  });
  recordProjection(state, archiveKey, {
    status: "projected",
    threadId: currentThreadId,
    caseId: displayCaseId,
    customerName: textValue(matched?.kunde, item?.kunde || ""),
    category: signal.category,
    documentType: signal.documentType,
    documentDate,
    fileName: document.fileName,
    driveUrl: textValue(document.url, ""),
    fileId: textValue(document.fileId, ""),
  });
  closeReviewQueueItem(state, currentThreadId, archiveKey);

  return {
    ok: true,
    archiveKey,
    threadId: textValue(item?.threadId || thread?.id, ""),
    category: signal.category,
    matchedCaseId: displayCaseId,
    customerName: textValue(matched?.kunde, item?.kunde || ""),
    documentType: signal.documentType,
    documentDate,
    driveUrl: textValue(document.url, ""),
    fileName: document.fileName,
    driveFolder,
  };
}

export default async (request: Request) => {
  const auth = authorizeDashboardRequest(request, { allowActionsToken: true });
  if (!auth.ok) return auth.response;

  if (request.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }

  const integration = googleIntegrationStatus();
  if (!integration.configured) {
    return json({ ok: false, error: "google_not_configured" }, 400);
  }

  let requestBody: any = {};
  try {
    requestBody = await request.clone().json();
  } catch {
    requestBody = {};
  }
  const state = await loadDashboardState();
  if (!state) return json({ ok: false, error: "no_state" }, 404);
  const syncRunId = startSyncRun(state, textValue(requestBody?.trigger, auth.actor?.type === "actions" ? "actions" : "manual"));
  const migratedSyncLogEntries = normalizeExistingSyncLog(state);
  const syncStartedAt = Date.now();
  const isNearFunctionTimeout = () => Date.now() - syncStartedAt > 18000;
  const archivedResults: any[] = [];
  const archiveErrors: any[] = [];
  const ensuredFolders: any[] = [];
  const manifestBackfilled = rebuildArchiveManifestFromActivities(state);

  try {
    const archiveThreadBatches = await Promise.allSettled(
      ARCHIVE_QUERIES.map((query) => listRecentGmailThreads(query, 10)),
    );
    const archiveThreads = dedupeThreads(archiveThreadBatches
      .filter((result): result is PromiseFulfilledResult<any[]> => result.status === "fulfilled")
      .flatMap((result) => result.value));
    archiveThreadBatches.forEach((result, index) => {
      if (result.status === "fulfilled") return;
      appendSyncLog(state, {
        status: "error",
        subject: "Opdatér Sager",
        customerName: "",
        caseId: "",
        documentType: "Gmail-søgning",
        category: "gmail",
        error: formatSyncError(result.reason),
        notes: `Gmail-søgning ${index + 1} svarede ikke korrekt. Sync fortsatte med de øvrige søgninger.`,
      });
    });
    const internalInboxThreads = isNearFunctionTimeout() ? [] : await listRecentGmailThreads(INTERNAL_ACTION_INBOX_QUERY, 12);
    const inboxThreads = isNearFunctionTimeout() ? [] : await listRecentGmailThreads(SYNC_QUERY, 10);
    queueDiscoveredThreads(state, [
      { lane: "internal_inbox", priority: 95, threads: internalInboxThreads },
      { lane: "archive", priority: 60, threads: archiveThreads },
      { lane: "inbox", priority: 30, threads: inboxThreads },
    ]);
    const queuedThreads = selectQueuedThreads(state, 16);
    const threads = queuedThreads.map((thread: any) => ({ id: thread.id, historyId: thread.historyId }));
    const fullThreadResults = await Promise.allSettled(
      threads.map((thread: any) => getGmailThread(String(thread.id))),
    );
    const fullThreads = fullThreadResults
      .filter((result): result is PromiseFulfilledResult<any> => result.status === "fulfilled")
      .map((result) => result.value);
    for (const thread of fullThreads) {
      recordIngestion(state, thread);
    }
    const processableFullThreads: any[] = [];
    for (const thread of fullThreads) {
      if (isLedgerFinalWithoutNewMessage(state, thread)) {
        const previous = ledgerEntryForThread(state, textValue(thread?.id, ""));
        updateThreadLedger(state, thread, {
          status: textValue(previous?.status, "processed"),
          intent: textValue(previous?.intent, "ignore"),
          lane: textValue(previous?.lane, "inbox"),
          reason: "Gmail-label eller arkivstatus ændret uden ny besked. Tråden blev ikke behandlet igen.",
        });
        markQueuedThreadProcessed(state, thread);
        continue;
      }
      processableFullThreads.push(thread);
    }
    const invoiceRegistration = await registerInvoicesFromThreads(state, processableFullThreads);
    const invoicesUpdated = Number(invoiceRegistration?.changed || 0);
    const taskCandidatesCreated: any[] = [];
    const dkeQuestionTasksCreated = 0;
    if (invoicesUpdated) {
      for (const entry of invoiceRegistration.changedCases || []) {
        appendSyncLog(state, {
          status: "archived",
          threadId: textValue(entry.threadId, ""),
          subject: entry.invoiceNumber ? `Faktura ${entry.invoiceNumber}` : "Faktura",
          customerName: textValue(entry.customerName, ""),
          caseId: textValue(entry.caseId, ""),
          documentType: "Faktura",
          category: "betaling",
          notes: entry.paid
            ? `${entry.invoiceNumber ? `Faktura ${entry.invoiceNumber}` : "Faktura"} er registreret som betalt på sagen via betalingsbekræftelse i mail${entry.amount ? ` med beløb ${entry.amount} kr. inkl. moms` : ""}.`
            : `${entry.invoiceNumber ? `Faktura ${entry.invoiceNumber}` : "Faktura"} er registreret på sagen via sikker Gmail/state-match${entry.amount ? ` med beløb ${entry.amount} kr. inkl. moms` : ""}.`,
        });
      }
    }
    fullThreadResults.forEach((result, index) => {
      if (result.status === "fulfilled") return;
      const threadId = textValue(threads[index]?.id, "");
      const errorText = formatSyncError(result.reason);
      recordResolution(state, threadId, {
        status: "fetch_failed",
        intent: "gmail_fetch",
        error: errorText,
      });
      archiveErrors.push({
        ok: false,
        threadId,
        subject: threadId ? `Mailtråd ${threadId}` : "Mailtråd",
        error: errorText,
      });
      markQueuedThreadAttempt(state, threadId);
      appendSyncLog(state, {
        status: "error",
        subject: threadId ? `Mailtråd ${threadId}` : "Mailtråd",
        customerName: "",
        caseId: "",
        documentType: "",
        category: "",
        error: errorText,
        notes: "Kunne ikke hente mailtråden fra Gmail.",
      });
    });

    const items = resolveHandledItems(processableFullThreads
      .map((thread) => toEmailEntry(thread, state.sager || []))
      .filter(Boolean)
      .sort((a: any, b: any) => String(b.date).localeCompare(String(a.date))));
    const itemByThreadId = new Map(items.map((item: any) => [textValue(item.threadId || item.id, ""), item]));
    const intentByThreadId = new Map<string, any>();

    for (const thread of processableFullThreads) {
      const threadId = textValue(thread?.id, "");
      const item = itemByThreadId.get(threadId);
      const intent = classifyThreadIntent(thread, item);
      intentByThreadId.set(threadId, intent);
      recordClassification(state, thread, item, intent);
      updateThreadLedger(state, thread, {
        intent: intent.intent,
        lane: intent.lane,
        status: intent.intent === "ignore" ? "ignored" : "new",
        reason: intent.reason,
        subject: textValue(item?.subject || latestThreadSummary(thread)?.subject, ""),
      });
      if (intent.intent !== "task_candidate") continue;
      const result = ensureTaskCandidateFromThread(state, thread);
      recordResolution(state, threadId, {
        status: result.created ? "task_created" : "processed",
        intent: "task_candidate",
        lane: textValue(intent.lane, ""),
        caseId: textValue(result.caseId, ""),
        customerName: textValue(result.customerName, ""),
        taskId: textValue(result.taskId, ""),
        linked: Boolean(result.linked),
        reason: textValue(result.reason, intent.reason),
      });
      updateThreadLedger(state, thread, {
        intent: intent.intent,
        lane: intent.lane,
        status: result.created ? "task_created" : "processed",
        taskId: textValue(result.taskId, ""),
        caseId: textValue(result.caseId, ""),
        customerId: textValue(result.caseId, "").match(/(\d+)/)?.[1] || "",
        reason: textValue(result.reason, intent.reason),
        subject: textValue(item?.subject || result.title, ""),
      });
      if (!result.created) continue;
      taskCandidatesCreated.push(result);
      appendSyncLog(state, {
        status: "task_created",
        archiveKey: `task-candidate-${textValue(result.threadId, "") || stableThreeDigitHash(result.title)}`,
        threadId: textValue(result.threadId, ""),
        subject: textValue(result.title, "Opgave"),
        customerName: textValue(result.customerName, ""),
        caseId: textValue(result.caseId, ""),
        documentType: "Opgave",
        category: "sager",
        notes: result.linked
          ? "Mailen er oprettet som opgave på den matchede kunde."
          : "Mailen er oprettet som intern opgave uden sikkert kundematch.",
      });
    }
    if (!taskCandidatesCreated.length && internalInboxThreads.length) {
      appendSyncLog(state, {
        status: "skipped",
        subject: "Intern indbakke gennemgået",
        customerName: "SMG / NSTSF",
        caseId: "",
        documentType: "Opgave-screening",
        category: "sager",
        notes: `${internalInboxThreads.length} interne/SMG-indbakke-mails blev hentet. Ingen nye opgaver blev oprettet, fordi de allerede fandtes eller ikke havde konkret handlingssignal.`,
      });
    }

    for (const thread of processableFullThreads) {
      if (isNearFunctionTimeout()) {
        appendSyncLog(state, {
          status: "error",
          subject: "Opdatér Sager",
          customerName: "",
          caseId: "",
          documentType: "Tidsbudget",
          category: "sync",
          error: "Google API svarede for langsomt. Sync blev stoppet kontrolleret.",
          notes: "Ikke alle tråde blev behandlet i dette kald. Tryk Opdatér Sager igen for næste batch.",
        });
        break;
      }
      const threadId = textValue(thread?.id, "");
      const item = itemByThreadId.get(threadId);
      if (!item) {
        markQueuedThreadProcessed(state, thread);
        continue;
      }
      const intent = intentByThreadId.get(threadId) || classifyThreadIntent(thread, item);
      if (intent.intent !== "archive_candidate") {
        markQueuedThreadProcessed(state, thread);
        continue;
      }
      try {
        const result = await archiveQualifiedThread(thread, item, state, integration, auth.actor);
        if (!result) {
          recordResolution(state, threadId, {
            status: "ignored",
            intent: "archive_candidate",
            lane: textValue(intent.lane, "archive"),
            reason: "Ingen arkivsignal efter fuld trådlæsning.",
          });
          updateThreadLedger(state, thread, {
            intent: textValue(intent.intent, "ignore"),
            lane: textValue(intent.lane, "inbox"),
            status: "ignored",
            reason: "Ingen arkivsignal efter fuld trådlæsning.",
          });
          continue;
        }
        if (result.ok) {
          recordResolution(state, threadId, {
            status: result.skipped ? "already_projected" : "projected",
            intent: "archive_candidate",
            lane: textValue(intent.lane, "archive"),
            caseId: textValue(result.matchedCaseId, ""),
            customerName: textValue(result.customerName, ""),
            documentType: textValue(result.documentType, ""),
            documentDate: textValue(result.documentDate, ""),
            category: textValue(result.category || signalCategoryFromResult(result), ""),
            archiveKey: textValue(result.archiveKey, ""),
            fileName: textValue(result.fileName, ""),
            driveUrl: textValue(result.driveUrl, ""),
            reason: result.skipped ? "Allerede arkiveret." : "Arkiveret i Drive.",
          });
          updateThreadLedger(state, thread, {
            intent: "archive_candidate",
            lane: textValue(intent.lane, "archive"),
            status: result.skipped ? "processed" : "archived",
            caseId: textValue(result.matchedCaseId, ""),
            customerId: textValue(result.matchedCaseId, "").match(/(\d+)/)?.[1] || "",
            driveUrl: textValue(result.driveUrl, ""),
            reason: result.skipped ? "Allerede arkiveret." : "Arkiveret i Drive.",
          });
          if (!result.skipped) {
            appendSyncLog(state, {
              status: "archived",
              archiveKey: textValue(result.archiveKey, ""),
              threadId: textValue(result.threadId || item?.threadId || thread?.id, ""),
              subject: textValue(item?.subject, ""),
              customerName: textValue(result.customerName, ""),
              caseId: textValue(result.matchedCaseId, ""),
              documentType: textValue(result.documentType, ""),
              documentDate: textValue(result.documentDate, ""),
              category: textValue(result.documentType ? signalCategoryFromResult(result) : "", ""),
              fileName: textValue(result.fileName, ""),
              driveUrl: textValue(result.driveUrl, ""),
              notes: `Arkiveret i Drive som ${textValue(result.fileName, "dokument")}.`,
            });
            item.archivedAt = new Date().toISOString();
            item.archivedCaseId = result.matchedCaseId;
            item.archivedCustomer = result.customerName;
            item.archivedType = result.documentType;
            item.archivedDate = result.documentDate;
            item.archivedUrl = result.driveUrl || "";
            archivedResults.push(result);
          }
        } else {
          const errorText = formatSyncError(result.error);
          const taskCreated = ensureUnmatchedMailTask(state, result, item, errorText, result.possibleCase);
          const isMatchReview = ["case_not_matched", "invoice_match_low_confidence", "invoice_match_ambiguous"].includes(textValue(result.error, ""));
          recordResolution(state, threadId, {
            status: isMatchReview ? "needs_review" : "failed_retryable",
            intent: "archive_candidate",
            lane: textValue(intent.lane, "archive"),
            caseId: textValue(result.matchedCaseId, ""),
            customerName: textValue(result.customerName, ""),
            documentType: textValue(result.documentType, ""),
            category: textValue(result.category, ""),
            error: errorText,
            possibleCaseId: textValue(result.possibleCase?.sid || result.possibleCase?.nr, ""),
            possibleCustomerName: textValue(result.possibleCase?.kunde, ""),
          });
          if (isMatchReview) {
            upsertReviewQueueItem(state, {
              status: "open",
              threadId: textValue(result.threadId || item?.threadId || thread?.id, ""),
              subject: textValue(item?.subject, ""),
              customerName: textValue(result.customerName, ""),
              caseId: textValue(result.matchedCaseId, ""),
              documentType: textValue(result.documentType, ""),
              category: textValue(result.category, ""),
              error: errorText,
              notes: taskCreated ? "Oprettet som opgave uden dato, indtil den matches manuelt." : "Kræver manuelt match før arkivering.",
              possibleCaseId: textValue(result.possibleCase?.sid || result.possibleCase?.nr, ""),
              possibleCustomerName: textValue(result.possibleCase?.kunde, ""),
            });
          }
          updateThreadLedger(state, thread, {
            intent: "archive_candidate",
            lane: textValue(intent.lane, "archive"),
            status: isMatchReview ? "needs_manual_match" : "failed_retryable",
            attempts: Number(ledgerEntryForThread(state, threadId)?.attempts || 0) + 1,
            caseId: textValue(result.matchedCaseId, ""),
            reason: errorText,
          });
          appendSyncLog(state, {
            status: isMatchReview ? "needs_review" : "error",
            threadId: textValue(result.threadId || item?.threadId || thread?.id, ""),
            subject: textValue(item?.subject, ""),
            customerName: textValue(result.customerName, ""),
            caseId: textValue(result.matchedCaseId, ""),
            documentType: textValue(result.documentType, ""),
            category: textValue(result.category, ""),
            error: errorText,
            notes: taskCreated ? `${errorText} Oprettet som opgave uden dato.` : errorText,
          });
          if (!isMatchReview) archiveErrors.push({ ...result, error: errorText });
        }
      } catch (error) {
        const errorText = formatSyncError(error);
        const attempts = Number(ledgerEntryForThread(state, threadId)?.attempts || 0) + 1;
        recordResolution(state, threadId, {
          status: attempts >= 3 ? "failed_final" : "failed_retryable",
          intent: "archive_candidate",
          lane: textValue(intent.lane, "archive"),
          error: errorText,
          attempts,
        });
        updateThreadLedger(state, thread, {
          intent: "archive_candidate",
          lane: textValue(intent.lane, "archive"),
          status: attempts >= 3 ? "failed_final" : "failed_retryable",
          attempts,
          nextRetryAt: attempts >= 3 ? "" : addDaysIso(new Date().toISOString().slice(0, 10), attempts >= 2 ? 1 : 0),
          reason: errorText,
        });
        appendSyncLog(state, {
          status: "error",
          threadId,
          subject: textValue(item?.subject, ""),
          customerName: textValue(item?.kunde, ""),
          caseId: "",
          documentType: "",
          category: "",
          error: errorText,
          notes: "Teknisk fejl under Gmail-sync.",
        });
        archiveErrors.push({
          ok: false,
          threadId,
          subject: textValue(item?.subject, ""),
          error: errorText,
        });
      }
      markQueuedThreadProcessed(state, thread);
    }

    state.emails = items;
    const repairedDocs = repairDocsFromActivityLog(state);
    if (repairedDocs) {
      appendSyncLog(state, {
        status: "updated",
        subject: "Dokumentlister repareret",
        customerName: "",
        caseId: "",
        documentType: "Dokumentliste",
        category: "sync",
        notes: `${repairedDocs} arkiverede dokument${repairedDocs === 1 ? "" : "er"} blev genskabt på kundernes dokumentlister ud fra activityLog.`,
      });
    }
    const sanitizedSyncLogEntries = normalizeExistingSyncLog(state);
    finishSyncRun(state, syncRunId, {
      status: "completed",
      synced: items.length,
      archived: archivedResults.length,
      archiveErrors: archiveErrors.length,
      reviewItemsOpen: pipelineSnapshot(state).openReviewItems,
    });
    refreshNormalizedSyncRecords(state);
    const savedAt = await saveDashboardState(state);
    const pipeline = pipelineSnapshot(state);

    return json({
      ok: true,
      gmailSyncBuild: GMAIL_SYNC_BUILD_VERSION,
      pipelineVersion: PIPELINE_VERSION,
      resolverVersion: RESOLVER_VERSION,
      syncRunId,
      savedAt,
      synced: items.length,
      unhandled: items.filter((item: any) => !item.handled).length,
      archived: archivedResults.length,
      dkeQuestionTasksCreated,
      taskCandidatesCreated: taskCandidatesCreated.length,
      internalInboxTasksCreated: taskCandidatesCreated.length,
      invoicesUpdated,
      manifestBackfilled,
      repairedDocs,
      migratedSyncLogEntries: migratedSyncLogEntries + sanitizedSyncLogEntries,
      syncDiagnostics: syncLogDiagnostics(state),
      pipeline,
      ensuredFolders: ensuredFolders.length,
      archiveErrors,
      archivedCases: archivedResults.map((entry) => ({
        archiveKey: entry.archiveKey,
        threadId: entry.threadId,
        caseId: entry.matchedCaseId,
        customerName: entry.customerName,
        documentType: entry.documentType,
        documentDate: entry.documentDate,
        driveUrl: entry.driveUrl,
        fileName: entry.fileName,
      })),
      note: archivedResults.length
        ? "Gmail-tråde er hentet, relevante dokumenter er arkiveret i Drive og state er opdateret."
        : archiveErrors.length
          ? "Gmail-tråde blev behandlet, men en eller flere arkiveringer fejlede."
          : ensuredFolders.length
            ? "Drive-mapper er sikret for sager med Drive-link, og Gmail-tråde er gemt i central state."
            : "Gmail-tråde er hentet og gemt i central state.",
    });
  } catch (error) {
    const errorText = formatSyncError(error);
    appendSyncLog(state, {
      status: "error",
      subject: "Opdatér Sager",
      customerName: "",
      caseId: "",
      documentType: "",
      category: "",
      error: errorText,
      notes: "Gmail-sync stoppede før trådene kunne behandles.",
    });
    const sanitizedSyncLogEntries = normalizeExistingSyncLog(state);
    finishSyncRun(state, syncRunId, {
      status: "failed",
      error: errorText,
    });
    refreshNormalizedSyncRecords(state);
    const savedAt = await saveDashboardState(state);
    const pipeline = pipelineSnapshot(state);
    return json({
      ok: true,
      gmailSyncBuild: GMAIL_SYNC_BUILD_VERSION,
      pipelineVersion: PIPELINE_VERSION,
      resolverVersion: RESOLVER_VERSION,
      syncRunId,
      savedAt,
      synced: 0,
      unhandled: 0,
      archived: 0,
      ensuredFolders: ensuredFolders.length,
      manifestBackfilled,
      migratedSyncLogEntries: migratedSyncLogEntries + sanitizedSyncLogEntries,
      syncDiagnostics: syncLogDiagnostics(state),
      pipeline,
      archiveErrors: [{
        ok: false,
        threadId: "",
        subject: "Opdatér Sager",
        error: errorText,
      }],
      archivedCases: [],
      note: `Gmail-sync fejlede: ${errorText}`,
    });
  }
};

function signalCategoryFromResult(result: any) {
  const type = textValue(result?.documentType, "").toLowerCase();
  if (type.includes("byggemodereferat") || type.includes("referat")) return "referater";
  if (type.includes("tilbud")) return "tilbud";
  if (type.includes("faktura")) return "betaling";
  if (type.includes("mail")) return "mails";
  return "";
}

export const __test = {
  applyArchiveSideEffects,
  buildArchiveFileTitle,
  buildArchiveKey,
  extractEnterpriseAmount,
  extractInvoiceAmount,
  inferArchiveSignal,
  matchCaseFromText,
  plainCompactText,
  registerArchiveManifest,
  repairDocsFromActivityLog,
  rebuildArchiveManifestFromActivities,
};

export const config = {
  path: "/api/gmail-sync",
  maxDuration: 26,
};
