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

const INTERNAL_PATTERNS = [/@nstsf\.dk/i, /gemini-notes@google\.com/i];
const MAILBOX_OWNER = "christian@nstsf.dk";
const NSTSF_QUERY = `(from:${MAILBOX_OWNER} OR from:smg@nstsf.dk OR from:nstsf.dk OR to:${MAILBOX_OWNER} OR cc:${MAILBOX_OWNER})`;
const EXCLUDED_MAIL_QUERY = "-from:cgallstar@gmail.com -from:christian@scventures.vc -to:christian@scventures.vc -cc:christian@scventures.vc -werkhaus";
const OWNER_QUERY = `${NSTSF_QUERY} ${EXCLUDED_MAIL_QUERY}`;
const GADESVEJ_DRIVE_URL = "https://drive.google.com/drive/folders/1IPXK472x8-Peasfv7kKU-JrG9oUNb6-4";
const KNOWN_INVOICE_CASES: Record<string, string> = {
  "1158": "1009",
};
const SYNC_QUERY = `newer_than:30d -in:spam -in:trash ${OWNER_QUERY}`;
const DKE_QUESTION_QUERY = `newer_than:14d -in:spam -in:trash ${OWNER_QUERY} ("DJ-pult" OR "DJ pult" OR "uge 19" OR "endelig aflevering" OR "Bülowsvej 9" OR "Bül. 9" OR "Bulowsvej 9" OR "Bul. 9" OR "Blågårdsgade 14" OR "Blå. 14" OR "Blaagaardsgade 14" OR "Blaa. 14")`;
const ARCHIVE_QUERIES = [
  `newer_than:90d -in:spam -in:trash ${OWNER_QUERY} ("Faktura" OR "faktura")`,
  `newer_than:45d -in:spam -in:trash ${OWNER_QUERY} ("Byggemødereferat" OR "Byggemodereferat" OR "byggemøde" OR "byggemode")`,
  `newer_than:90d -in:spam -in:trash ${OWNER_QUERY} ("Udbedring af mangler" OR "afslutningsmøde" OR "afslutningsmode") ("Pladebutik" OR "Blågårdsgade 14" OR "Blaagaardsgade 14")`,
  `newer_than:45d -in:spam -in:trash ${OWNER_QUERY} ("Tilbud vedr" OR "tilbud" OR "overslagspris")`,
  `newer_than:45d -in:spam -in:trash ${OWNER_QUERY} ("Faktura" "Nordsjællands Tømrer")`,
  `newer_than:45d -in:spam -in:trash ${OWNER_QUERY} ("Bülowsvej" OR "Bulowsvej" OR "NV Gadesvej" OR "N. V. Gadesvej")`,
  `newer_than:45d -in:spam -in:trash ${OWNER_QUERY} ("Pladebutik" OR "Blågårdsgade 14" OR "Blaagaardsgade 14" OR "Kingosvej 1B")`,
  DKE_QUESTION_QUERY,
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
  const archiveKey = textValue(payload.archiveKey, "");
  const threadId = textValue(payload.threadId, "");
  const fileName = textValue(payload.fileName, "");
  const caseId = textValue(payload.caseId, "");
  const subject = textValue(payload.subject, "");
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
  });
  state.syncLog = state.syncLog.slice(0, 80);
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
  state.syncState.processedThreadHistory = state.syncState.processedThreadHistory && typeof state.syncState.processedThreadHistory === "object" && !Array.isArray(state.syncState.processedThreadHistory)
    ? state.syncState.processedThreadHistory
    : {};
  return state.syncState;
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
      if (group.lane !== "dke_questions" && historyId && textValue(syncState.processedThreadHistory?.[id], "") === historyId) continue;
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
  return syncState.gmailQueue
    .filter((item: any) => {
      const id = textValue(item?.id, "");
      const historyId = textValue(item?.historyId, "");
      return id && (item?.lane === "dke_questions" || !historyId || textValue(syncState.processedThreadHistory?.[id], "") !== historyId);
    })
    .sort((a: any, b: any) =>
      Number(b.priority || 0) - Number(a.priority || 0) ||
      Number(a.attempts || 0) - Number(b.attempts || 0) ||
      String(a.discoveredAt || "").localeCompare(String(b.discoveredAt || ""))
    )
    .slice(0, max);
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

function isGadesvejArchiveThread(signal: any, text = "") {
  if (!signal || signal.category !== "referater") return false;
  const compact = plainCompactText(text);
  return compact.includes("nv gadesvej") && /\b12a?\b/.test(compact);
}

function isNvGadesvej10Thread(text = "") {
  const compact = plainCompactText(text);
  return compact.includes("nv gadesvej") && /\b10\b/.test(compact);
}

function findOrCreateGadesvejCase(state: any) {
  const entries = Array.isArray(state?.sager) ? state.sager : [];
  const existing = entries.find((entry: any) => {
    const driveUrl = textValue(entry?.docs?.drive || entry?.drive, "");
    const marker = plainCompactText(`${entry?.kunde || ""} ${entry?.adr || ""} ${entry?.opg || ""} ${driveUrl}`);
    return driveUrl.includes("1IPXK472x8-Peasfv7kKU-JrG9oUNb6-4") || (marker.includes("nv gadesvej") && /\b12a?\b/.test(marker));
  });
  if (existing) {
    ensureCaseShape(existing);
    existing.sid = "1006a";
    existing.nr = "1006";
    existing.docs.drive = GADESVEJ_DRIVE_URL;
    existing.drive = GADESVEJ_DRIVE_URL;
    if (!textValue(existing.adr, "")) existing.adr = "N. V. Gadesvej 12A, 1. sal, Fredensborg";
    return existing;
  }

  const created = ensureCaseShape({
    k: 2,
    sid: "1006a",
    nr: "1006",
    kunde: "Mathias & Anna",
    adr: "N. V. Gadesvej 12A, 1. sal, Fredensborg",
    opg: "Byggemodereferat",
    b: "0",
    u: "0",
    dato: "",
    status: "Referat arkiveret",
    sort: entries.length,
    docs: { drive: GADESVEJ_DRIVE_URL },
  });
  entries.push(created);
  state.sager = entries;
  return created;
}

function findOrCreateKnownCase(state: any, signal: any, text = "") {
  const compact = plainCompactText(text);
  if (isGadesvejArchiveThread(signal, text)) return findOrCreateGadesvejCase(state);
  const entries = Array.isArray(state?.sager) ? state.sager : [];
  const findByMarker = (patterns: RegExp[]) => entries.find((entry: any) => {
    const marker = plainCompactText(`${entry?.kunde || ""} ${entry?.adr || ""} ${entry?.opg || ""} ${entry?.sid || ""} ${entry?.nr || ""} ${entry?.fak || ""} ${entry?.docs?.drive || entry?.drive || ""}`);
    return patterns.some((pattern) => pattern.test(marker));
  });
  const createCase = (payload: any) => {
    const created = ensureCaseShape({
      k: payload.k || 5,
      sid: "",
      nr: "",
      b: "0",
      u: "0",
      dato: "",
      status: payload.status || "Oprettet fra Gmail",
      sort: entries.length,
      docs: {},
      ...payload,
    });
    entries.push(created);
    state.sager = entries;
    return created;
  };

  if (isNvGadesvej10Thread(text)) {
    const existing = findByMarker([/nv gadesvej.*10/, /gadesvej.*10/, /signe/, /tam/]);
    if (existing) return ensureCaseShape(existing);
    return createCase({
      k: 4,
      sid: "1015a",
      nr: "1015",
      kunde: "Signe & Tam",
      adr: "N. V. Gadesvej 10, 1. sal",
      opg: "Istandsættelse af 1. sal",
      b: "600000",
      status: signal?.category === "tilbud" ? "Tilbud sendt" : "Oprettet fra Gmail",
    });
  }

  const isPladebutikThread =
    compact.includes("pladebutik") ||
    ((compact.includes("blagardsgade 14") || compact.includes("blaagardsgade 14")) && compact.includes("udbedring") && compact.includes("mangler"));
  if (isPladebutikThread) {
    const existing = findByMarker([/pladebutik/, /blagardsgade\s*14/, /blaagardsgade\s*14/]);
    if (existing) return ensureCaseShape(existing);
    return createCase({
      k: signal?.category === "referater" ? 1 : 5,
      kunde: "Pladebutik",
      adr: "Blågårdsgade 14",
      opg: "Udbedring af mangler",
      status: signal?.category === "referater" ? "Referat arkiveret" : "Mangler registreret",
    });
  }

  if (compact.includes("kingosvej 1b")) {
    const existing = findByMarker([/kingosvej 1b/]);
    if (existing) return ensureCaseShape(existing);
    return createCase({
      k: 4,
      kunde: "Kingosvej 1B",
      adr: "Kingosvej 1B",
      opg: "Ombygningsarbejder",
      status: "Tilbud sendt",
    });
  }

  return null;
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

function applyInvoiceToCase(matched: any, invoiceNumber: string, date = "", amount = 0) {
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
  matched.workflow.invoiceSentDate = date || matched.workflow.invoiceSentDate || new Date().toISOString().slice(0, 10);
  if (!textValue(matched.dato, "")) matched.dato = matched.workflow.invoiceSentDate;
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

function findCaseByCustomerNumber(state: any, customerNumber = "") {
  const wanted = normalizeCaseKey(customerNumber);
  if (!wanted) return null;
  return (Array.isArray(state?.sager) ? state.sager : []).find((entry: any) => primaryCaseNumber(entry) === wanted) || null;
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
  const knownCustomerNumber = textValue(KNOWN_INVOICE_CASES[invoiceNumber], "");
  if (knownCustomerNumber) {
    const known = findCaseByCustomerNumber(state, knownCustomerNumber);
    if (known) {
      return {
        matched: known,
        score: 30,
        reasons: [`kendt faktura->K-${knownCustomerNumber}`],
        ambiguous: false,
      };
    }
  }
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
          status: "error",
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
    const amount = extractInvoiceAmount(threadText);
    const didApply = applyInvoiceToCase(matched, invoiceMatch[1], date, amount);
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
    if (didApply || didMarkPaid) {
      changed += 1;
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

  const forcedGadesvejCase = {
    k: 2,
    sid: "",
    nr: "",
    kunde: "N. V. Gadesvej 12, 1. sal",
    adr: "N. V. Gadesvej 12, 1. sal, Fredensborg",
    docs: { drive: GADESVEJ_DRIVE_URL },
  };
  try {
    await ensureOne(forcedGadesvejCase);
  } catch (error) {
    appendSyncLog(state, {
      status: "error",
      subject: "Drive-mapper",
      customerName: forcedGadesvejCase.kunde,
      caseId: "",
      documentType: "Mappestruktur",
      category: "drive",
      error: formatSyncError(error),
      notes: "Kunne ikke sikre standardmapper for Gadesvej-mappen.",
    });
  }

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
      fileLabel: "",
    };
  }
  if (/tilbud|overslagspris|prisgrundlag/.test(subjectSource)) {
    return {
      category: "tilbud",
      documentType: "Tilbud",
      sourceType: isInternalSender(from) ? "internal" : "external",
      fileLabel: "",
    };
  }
  if (/tilbud|overslagspris|prisgrundlag/.test(source)) {
    return {
      category: "tilbud",
      documentType: "Tilbud",
      sourceType: isInternalSender(from) ? "internal" : "external",
      fileLabel: "",
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
  if (/^(re|sv|vs|fw|fwd)\s*:/i.test(rawSubject)) {
    return {
      category: "mails",
      documentType: "Mailkorrespondance",
      sourceType: isInternalSender(from) ? "internal" : "external",
      fileLabel: "",
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

function ensureDkeTask(state: any, payload: {
  id: string;
  markers?: string[];
  title: string;
  notes: string;
  threadId: string;
  dueDate?: string;
}) {
  const matched = payload.markers?.length ? findCaseByAllMarkers(state, payload.markers) : null;
  if (matched) {
    ensureCaseShape(matched);
    return ensureTask(matched, payload.title, {
      dueDate: payload.dueDate || new Date().toISOString().slice(0, 10),
      owner: "Søren",
      notes: payload.notes,
      source: "gmail_sync",
      threadId: payload.threadId,
    });
  }

  state.internalTasks = Array.isArray(state.internalTasks) ? state.internalTasks : [];
  const existing = state.internalTasks.some((task: any) =>
    textValue(task?.id, "") === payload.id ||
    (normalizeCaseKey(task?.title) === normalizeCaseKey(payload.title) && String(task?.status || "").toLowerCase() !== "fuldført")
  );
  if (existing) return false;
  state.internalTasks.unshift(normalizeInternalTask({
    id: payload.id,
    title: payload.title,
    status: "Åben",
    dueDate: payload.dueDate || new Date().toISOString().slice(0, 10),
    owner: "Søren",
    source: "gmail_sync",
    domain: "arbejde",
    bucket: "today",
    threadId: payload.threadId,
    customerId: "1002",
    notes: payload.notes,
  }));
  return true;
}

function hasBlaagaardsgade14Signal(compact: string) {
  return compact.includes("blagardsgade 14") ||
    compact.includes("blaagardsgade 14") ||
    /\bblaa?\s*14\b/.test(compact);
}

function hasBulowsvej9Signal(compact: string) {
  return compact.includes("bulowsvej 9") ||
    /\bbul\s*9\b/.test(compact);
}

function ensureDkeCharlotteQuestionTasksFromText(state: any, text: string, threadId = "") {
  let created = 0;
  const compact = plainCompactText(text);
  const isCharlotteThread = compact.includes("charlotte") || compact.includes("dke");
  if (!isCharlotteThread) return 0;

  const stableId = threadId || stableThreeDigitHash(text);
  if ((compact.includes("dj pult") || compact.includes("djpult")) && compact.includes("billeder")) {
    if (ensureDkeTask(state, {
      id: `gmail-dke-dj-pult-billeder-${stableId}`,
      title: "Send DJ-pult-billeder til Charlotte",
      notes: "DKE/Charlotte spørger efter manglende DJ-pult-billeder. Send billeder eller forklar status.",
      threadId,
    })) created += 1;
  }
  if ((compact.includes("endelig aflevering") || compact.includes("aflevering")) && hasBlaagaardsgade14Signal(compact)) {
    if (ensureDkeTask(state, {
      id: `gmail-dke-blaagaardsgade-aflevering-${stableId}`,
      markers: ["Blågårdsgade 14"],
      title: "Svar med dato for endelig aflevering på Blågårdsgade 14",
      notes: "DKE/Charlotte spørger om dato for endelig aflevering på Blågårdsgade 14 kld. th.",
      threadId,
    })) created += 1;
  }
  if (compact.includes("uge 19") && hasBulowsvej9Signal(compact)) {
    if (ensureDkeTask(state, {
      id: `gmail-dke-bulowsvej-uge-19-${stableId}`,
      markers: ["Bülowsvej 9"],
      title: "Svar hvilken dag i uge 19 I kommer på Bülowsvej 9",
      notes: "DKE/Charlotte spørger hvilken dag i uge 19 I kommer på Bülowsvej 9, 2. th.",
      threadId,
    })) created += 1;
  }
  return created;
}

function ensureDkeCharlotteQuestionTasks(state: any, threads: any[]) {
  let created = 0;
  for (const thread of threads) {
    const summaries = Array.isArray(thread?.messages) ? thread.messages.map(gmailMessageSummary) : [];
    const text = summaries
      .map((message) => [message.subject, message.from, message.snippet, message.body].filter(Boolean).join("\n"))
      .join("\n\n");
    created += ensureDkeCharlotteQuestionTasksFromText(state, text, textValue(thread?.id, ""));
  }
  return created;
}

function ensureDkeCharlotteQuestionTasksFromStateEmails(state: any) {
  let created = 0;
  const emails = Array.isArray(state?.emails) ? state.emails : [];
  for (const email of emails) {
    const text = [
      email?.subject,
      email?.from,
      email?.kunde,
      email?.snippet,
      email?.preview,
      email?.body,
      email?.summary,
      email?.suggestion,
    ].filter(Boolean).join("\n");
    created += ensureDkeCharlotteQuestionTasksFromText(state, text, textValue(email?.threadId || email?.id, ""));
  }
  return created;
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

function ensureOfferFollowupTask(matched: any, signal: any, archiveText: string, documentDate: string) {
  if (!matched) return;
  const compact = plainCompactText(archiveText);
  const isRelevant =
    signal?.category === "tilbud" ||
    compact.includes("tilbud") ||
    compact.includes("overslagspris") ||
    compact.includes("prisgrundlag") ||
    isGadesvejArchiveThread(signal, archiveText);
  if (!isRelevant) return;
  matched.workflow = matched.workflow && typeof matched.workflow === "object" ? matched.workflow : {};
  matched.workflow.offerDate = textValue(matched.workflow.offerDate, documentDate);
  matched.workflow.latestOfferDate = textValue(matched.workflow.latestOfferDate, documentDate);
  matched.workflow.nextAction = textValue(matched.workflow.nextAction, "Følg op på tilbud.");
  const isNvGadesvej10 = isNvGadesvej10Thread(archiveText);
  const isRevised = compact.includes("revideret") || compact.includes("revidere") || compact.includes("revision") || isGadesvejArchiveThread(signal, archiveText);
  const title = isNvGadesvej10 ? "Svar på input til tilbud" : isRevised ? "Følg op på revideret tilbud" : "Følg op på tilbud";
  const existing = (matched.tasks || []).some((task: any) => {
    return normalizeCaseKey(task?.title) === normalizeCaseKey(title) && String(task?.status || "").toLowerCase() !== "fuldført";
  });
  if (existing) return;
  matched.tasks = Array.isArray(matched.tasks) ? matched.tasks : [];
  matched.tasks.unshift({
    id: randomUUID(),
    title,
    status: "Åben",
    dueDate: isNvGadesvej10 ? "" : addDaysIso(documentDate, 7),
    owner: "Søren",
    notes: isNvGadesvej10
      ? "Kunden har givet input til tilbud vedr. istandsættelse af 1. sal på NV Gadesvej 10. Budget er angivet til 500-600K. Svar kunden og opdater tilbudsgrundlaget."
      : `${isRevised ? "Der er afgivet et revideret tilbud" : "Der er afgivet et tilbud"}. Følg op med kunden senest syv dage efter tilbudsdatoen.`,
    createdAt: new Date().toISOString(),
  });
}

function applyKnownCaseActions(matched: any, signal: any, archiveText = "", documentDate = "") {
  const compact = plainCompactText(`${matched?.kunde || ""} ${matched?.adr || ""} ${matched?.opg || ""} ${archiveText}`);
  if (compact.includes("kingosvej 1b")) {
    ensureTask(matched, "Følg op på tilbud", {
      dueDate: addDaysIso(documentDate, 7),
      owner: "Søren",
      notes: "Der er sendt transparent oversigt/tilbud på ombygningsarbejder. Følg op med kunden senest syv dage efter tilbudsdatoen.",
    });
  }
  if ((compact.includes("pladebutik") || compact.includes("blagardsgade 14") || compact.includes("blaagardsgade 14")) && signal?.category === "referater") {
    ensureTask(matched, "Følg op på udbedring af mangler", {
      dueDate: addDaysIso(documentDate, 2),
      owner: "Søren",
      notes: "Mødereferat/mail om udbedring af mangler er arkiveret. Afklar ansvar, dato og næste handling.",
    });
  }
}

function backfillOfferFollowupsFromState(state: any) {
  const entries = Array.isArray(state?.sager) ? state.sager : [];
  let created = 0;
  for (const entry of entries) {
    ensureCaseShape(entry);
    if (Array.isArray(entry.tasks)) {
      for (const task of entry.tasks) {
        if (/tilbud/i.test(`${task?.title || ""} ${task?.notes || ""}`) && /christian/i.test(String(task?.owner || ""))) {
          task.owner = "Søren";
        }
      }
    }
    const before = Array.isArray(entry.tasks) ? entry.tasks.length : 0;
    const docs = [
      ...(entry.docs?.tilbud || []),
      ...(entry.docs?.referater || []),
      ...(entry.docs?.byggereferater || []),
      ...(entry.docs?.mails || []),
    ];
    const activities = Array.isArray(entry.activityLog) ? entry.activityLog : [];
    const haystack = [
      entry.kunde,
      entry.adr,
      entry.opg,
      entry.docs?.drive,
      ...docs.flatMap((doc: any) => [doc?.titel, doc?.title, doc?.notes, doc?.dato, doc?.date]),
      ...activities.flatMap((activity: any) => [activity?.subject, activity?.documentType, activity?.fileName, activity?.documentDate, activity?.notes]),
    ].filter(Boolean).join("\n");
    const compact = plainCompactText(haystack);
    const hasOfferSignal =
      compact.includes("tilbud") ||
      compact.includes("overslagspris") ||
      compact.includes("prisgrundlag") ||
      (compact.includes("byggemodereferat") && compact.includes("nv gadesvej"));
    if (!hasOfferSignal) continue;
    const dated = [
      ...docs.map((doc: any) => textValue(doc?.dato || doc?.date, "")),
      ...activities.map((activity: any) => textValue(activity?.documentDate || activity?.createdAt, "").slice(0, 10)),
    ].filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date));
    const documentDate = dated.sort().reverse()[0] || new Date().toISOString().slice(0, 10);
    ensureOfferFollowupTask(entry, { category: compact.includes("byggemodereferat") ? "referater" : "tilbud" }, haystack, documentDate);
    const after = Array.isArray(entry.tasks) ? entry.tasks.length : 0;
    if (after > before) created += after - before;
  }
  return created;
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
  if (signal.category === "betaling") {
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
  } else {
    matched = matchCaseFromText(state.sager || [], archiveText);
  }
  matched = findOrCreateKnownCase(state, signal, archiveText) || matched;
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
  if (isGadesvejArchiveThread(signal, archiveText)) {
    matched.docs.drive = GADESVEJ_DRIVE_URL;
    matched.drive = GADESVEJ_DRIVE_URL;
  }
  const documentDate = extractDocumentDate(item?.subject, combined || item?.body, item?.date);
  const displayCaseId = formatCaseIdForDisplay(matched) || textValue(matched?.nr, "");
  applyArchiveSideEffects(matched, signal, archiveText, documentDate);
  ensureOfferFollowupTask(matched, signal, archiveText, documentDate);
  applyKnownCaseActions(matched, signal, archiveText, documentDate);
  const archiveKey = [
    textValue(item?.threadId || thread?.id, ""),
    signal.category,
    signal.documentType,
    documentDate,
    normalizeCaseKey(displayCaseId || matched?.kunde),
  ].join(":");
  const fileTitle = buildArchiveFileTitle(documentDate, signal, displayCaseId, item?.subject);
  const fileName = `${fileTitle}.md`;
  const currentThreadId = textValue(item?.threadId || thread?.id, "");
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
  const auth = authorizeDashboardRequest(request);
  if (!auth.ok) return auth.response;

  if (request.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }

  const integration = googleIntegrationStatus();
  if (!integration.configured) {
    return json({ ok: false, error: "google_not_configured" }, 400);
  }

  const state = await loadDashboardState();
  if (!state) return json({ ok: false, error: "no_state" }, 404);
  const syncStartedAt = Date.now();
  const isNearFunctionTimeout = () => Date.now() - syncStartedAt > 6500;
  const archivedResults: any[] = [];
  const archiveErrors: any[] = [];
  const ensuredFolders: any[] = [];

  try {
    const dkeQuestionThreads = await listRecentGmailThreads(DKE_QUESTION_QUERY, 6).catch((error) => {
      appendSyncLog(state, {
        status: "error",
        subject: "DKE/Charlotte Gmail-søgning",
        customerName: "DKE / Charlotte",
        caseId: "1002",
        documentType: "Gmail-søgning",
        category: "gmail",
        error: formatSyncError(error),
        notes: "Den prioriterede DKE/Charlotte-søgning svarede ikke korrekt.",
      });
      return [];
    });
    const archiveThreadBatches = await Promise.allSettled(
      ARCHIVE_QUERIES.map((query) => listRecentGmailThreads(query, 5)),
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
    const inboxThreads = isNearFunctionTimeout() ? [] : await listRecentGmailThreads(SYNC_QUERY, 6);
    queueDiscoveredThreads(state, [
      { lane: "dke_questions", priority: 100, threads: dkeQuestionThreads },
      { lane: "archive", priority: 60, threads: archiveThreads },
      { lane: "inbox", priority: 30, threads: inboxThreads },
    ]);
    const queuedThreads = selectQueuedThreads(state, 8);
    const threads = queuedThreads.map((thread: any) => ({ id: thread.id, historyId: thread.historyId }));
    const fullThreadResults = await Promise.allSettled(
      threads.map((thread: any) => getGmailThread(String(thread.id))),
    );
    const fullThreads = fullThreadResults
      .filter((result): result is PromiseFulfilledResult<any> => result.status === "fulfilled")
      .map((result) => result.value);
    const invoiceRegistration = await registerInvoicesFromThreads(state, fullThreads);
    const invoicesUpdated = Number(invoiceRegistration?.changed || 0);
    const dkeQuestionTasksCreated =
      ensureDkeCharlotteQuestionTasks(state, fullThreads) +
      ensureDkeCharlotteQuestionTasksFromStateEmails(state);
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

    const items = resolveHandledItems(fullThreads
      .map((thread) => toEmailEntry(thread, state.sager || []))
      .filter(Boolean)
      .sort((a: any, b: any) => String(b.date).localeCompare(String(a.date))));
    const itemByThreadId = new Map(items.map((item: any) => [textValue(item.threadId || item.id, ""), item]));

    for (const thread of fullThreads) {
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
      try {
        const result = await archiveQualifiedThread(thread, item, state, integration, auth.actor);
        if (!result) continue;
        if (result.ok) {
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
          appendSyncLog(state, {
            status: "error",
            threadId: textValue(result.threadId || item?.threadId || thread?.id, ""),
            subject: textValue(item?.subject, ""),
            customerName: textValue(result.customerName, ""),
            caseId: textValue(result.matchedCaseId, ""),
            documentType: textValue(result.documentType, ""),
            category: textValue(result.category, ""),
            error: errorText,
            notes: taskCreated ? `${errorText} Oprettet som opgave uden dato.` : errorText,
          });
          archiveErrors.push({ ...result, error: errorText });
        }
      } catch (error) {
        const errorText = formatSyncError(error);
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

    const offerFollowupsCreated = backfillOfferFollowupsFromState(state);
    if (dkeQuestionTasksCreated) {
      appendSyncLog(state, {
        status: "archived",
        subject: "DKE/Charlotte åbne spørgsmål",
        customerName: "DKE / Charlotte",
        caseId: "1002",
        documentType: "Action point",
        category: "sager",
        notes: `${dkeQuestionTasksCreated} åbne spørgsmål fra DKE/Charlotte er oprettet som opgaver.`,
      });
    }
    if (offerFollowupsCreated) {
      appendSyncLog(state, {
        status: "archived",
        subject: "Tilbudsopfølgning",
        customerName: "",
        caseId: "",
        documentType: "Action point",
        category: "sager",
        notes: `${offerFollowupsCreated} action point${offerFollowupsCreated === 1 ? "" : "s"} for tilbud er sikret på kundesager.`,
      });
    }

    state.emails = items;
    const savedAt = await saveDashboardState(state);

    return json({
      ok: true,
      savedAt,
      synced: items.length,
      unhandled: items.filter((item: any) => !item.handled).length,
      archived: archivedResults.length,
      offerFollowupsCreated,
      dkeQuestionTasksCreated,
      invoicesUpdated,
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
    const savedAt = await saveDashboardState(state);
    return json({
      ok: true,
      savedAt,
      synced: 0,
      unhandled: 0,
      archived: 0,
      ensuredFolders: ensuredFolders.length,
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

export const config = {
  path: "/api/gmail-sync",
  maxDuration: 26,
};
