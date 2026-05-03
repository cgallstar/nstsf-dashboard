import { randomUUID } from "node:crypto";

import {
  appendActivity,
  authorizeDashboardRequest,
  ensureCaseShape,
  json,
  loadDashboardState,
  pushDocs,
  saveDashboardState,
  textValue,
} from "./_lib/dashboard.mts";
import {
  ensureCaseDriveFolders,
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
const SYNC_QUERY = `newer_than:30d -in:spam -in:trash ${OWNER_QUERY}`;
const ARCHIVE_QUERIES = [
  `newer_than:90d -in:spam -in:trash ${OWNER_QUERY} ("Faktura" OR "faktura")`,
  `newer_than:45d -in:spam -in:trash ${OWNER_QUERY} ("Byggemødereferat" OR "Byggemodereferat" OR "byggemøde" OR "byggemode")`,
  `newer_than:90d -in:spam -in:trash ${OWNER_QUERY} ("Udbedring af mangler" OR "afslutningsmøde" OR "afslutningsmode") ("Pladebutik" OR "Blågårdsgade 14" OR "Blaagaardsgade 14")`,
  `newer_than:45d -in:spam -in:trash ${OWNER_QUERY} ("Tilbud vedr" OR "tilbud" OR "overslagspris")`,
  `newer_than:45d -in:spam -in:trash ${OWNER_QUERY} ("Faktura" "Nordsjællands Tømrer")`,
  `newer_than:45d -in:spam -in:trash ${OWNER_QUERY} ("Bülowsvej" OR "Bulowsvej" OR "NV Gadesvej" OR "N. V. Gadesvej")`,
  `newer_than:45d -in:spam -in:trash ${OWNER_QUERY} ("Pladebutik" OR "Blågårdsgade 14" OR "Blaagaardsgade 14" OR "Kingosvej 1B")`,
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

function formatSyncError(error: unknown) {
  const message = textValue((error as Error)?.message, "archive_failed");
  if (message.startsWith("google_token_error:")) return "Google OAuth-token kunne ikke fornyes.";
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

function matchCaseFromText(sager: any[], haystack: string) {
  const lower = String(haystack || "").toLowerCase();
  const compact = plainCompactText(haystack);
  let best: any = null;
  let bestScore = 0;
  for (const entry of sager) {
    let score = 0;
    const kunde = String(entry?.kunde || "").toLowerCase();
    const adr = String(entry?.adr || "").toLowerCase();
    const nr = String(entry?.nr || "").toLowerCase();
    const sid = String(entry?.sid || "").toLowerCase();
    const opg = String(entry?.opg || "").toLowerCase();
    const compactKunde = plainCompactText(kunde);
    const compactAdr = plainCompactText(adr);
    const compactNr = plainCompactText(nr);
    const compactSid = plainCompactText(sid);
    const compactPrimary = primaryCaseNumber(entry);
    const compactOpg = plainCompactText(opg);
    if (kunde && lower.includes(kunde)) score += 3;
    if (adr && lower.includes(adr)) score += 5;
    if (nr && lower.includes(nr)) score += 2;
    if (sid && lower.includes(sid)) score += 4;
    if (opg && opg.length > 12 && lower.includes(opg)) score += 1;
    if (compactKunde && compact.includes(compactKunde)) score += 3;
    if (compactAdr && compact.includes(compactAdr)) score += 8;
    if (compactNr && compact.includes(compactNr)) score += 4;
    if (compactSid && compact.includes(compactSid)) score += 5;
    if (compactPrimary && compact.includes(compactPrimary)) score += 5;
    if (compactOpg && compactOpg.length > 12 && compact.includes(compactOpg)) score += 2;
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

function normalizeCaseKey(value: unknown) {
  return String(value || "").replace(/\s+/g, "").trim().toLowerCase();
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
  const primary = primaryCaseNumber(entry);
  if (primary) return primary;
  const raw = textValue(entry?.sid || entry?.nr, "").trim();
  if (!raw) return "";
  return raw.toUpperCase();
}

function plainCompactText(value = "") {
  return String(value || "")
    .replace(/\bN\s*\.?\s*V\s*\.?\s*Gadesvej/gi, "NV Gadesvej")
    .replace(/\bNW[\s_.-]*Gadesvej/gi, "NV Gadesvej")
    .replace(/[æÆ]/g, "ae")
    .replace(/[øØ]/g, "o")
    .replace(/[åÅ]/g, "a")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase();
}

function isGadesvejArchiveThread(signal: any, text = "") {
  if (!signal || signal.category !== "referater") return false;
  const compact = plainCompactText(text);
  return compact.includes("nv gadesvej") && /\b12a?\b/.test(compact);
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
  const before = JSON.stringify({
    fak: matched.fak,
    status: matched.status,
    workflow: matched.workflow,
    dato: matched.dato,
    docs: matched.docs?.betaling,
  });
  matched.fak = invoiceNumber;
  matched.status = "Faktura sendt";
  matched.workflow = matched.workflow && typeof matched.workflow === "object" ? matched.workflow : {};
  matched.workflow.invoiceNumber = invoiceNumber;
  matched.workflow.invoiceSentDate = date || matched.workflow.invoiceSentDate || new Date().toISOString().slice(0, 10);
  if (!textValue(matched.dato, "")) matched.dato = matched.workflow.invoiceSentDate;
  if (amount && !parseMoneyValue(textValue(matched.u, ""))) matched.u = formatAmount(amount);
  const docsChanged = labelInvoiceDocs(matched, invoiceNumber, matched.workflow.invoiceSentDate);
  const after = JSON.stringify({
    fak: matched.fak,
    status: matched.status,
    workflow: matched.workflow,
    dato: matched.dato,
    docs: matched.docs?.betaling,
  });
  return docsChanged || after !== before;
}

function scoreInvoiceCase(entry: any, invoiceText: string) {
  const source = plainCompactText(invoiceText);
  if (!source) return { score: 0, reasons: [] as string[] };
  const reasons: string[] = [];
  let score = 0;
  const address = plainCompactText(entry?.adr || "");
  const customer = plainCompactText(entry?.kunde || "");
  const task = plainCompactText(entry?.opg || "");
  const sid = normalizeCaseKey(entry?.sid || "");
  const nr = normalizeCaseKey(entry?.nr || "");
  const primary = primaryCaseNumber(entry);
  if (address && address.length >= 6 && source.includes(address)) {
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
  if (task && task.length >= 10 && source.includes(task)) {
    score += 2;
    reasons.push("opgave");
  }
  return { score, reasons };
}

function matchInvoiceToCase(state: any, invoiceText: string) {
  const entries = Array.isArray(state?.sager) ? state.sager : [];
  const ranked = entries
    .map((entry: any) => ({ entry, ...scoreInvoiceCase(entry, invoiceText) }))
    .filter((result: any) => result.score > 0)
    .sort((a: any, b: any) => b.score - a.score);
  const best = ranked[0];
  const second = ranked[1];
  if (!best) return { matched: null, score: 0, reasons: [], ambiguous: false };
  const ambiguous = Boolean(second && second.score >= best.score - 2);
  const hasStrongReason = best.reasons.includes("adresse") || best.reasons.includes("sagsID");
  if (best.score < 8 || !hasStrongReason || ambiguous) {
    return { matched: null, score: best.score, reasons: best.reasons, ambiguous };
  }
  return { matched: best.entry, score: best.score, reasons: best.reasons, ambiguous: false };
}

function registerInvoicesFromThreads(state: any, threads: any[]) {
  let changed = 0;
  for (const thread of threads) {
    const summaries = Array.isArray(thread?.messages) ? thread.messages.map(gmailMessageSummary) : [];
    const threadText = summaries
      .map((message) => [message.subject, message.from, message.snippet, message.body].filter(Boolean).join("\n"))
      .join("\n\n");
    const invoiceMatch = threadText.match(/\bfaktura\s*(?:nr\.?|nummer)?\s*[:#-]?\s*(\d{3,})\b/i);
    if (!invoiceMatch) continue;
    const match = matchInvoiceToCase(state, threadText);
    if (!match.matched) {
      appendSyncLog(state, {
        status: "error",
        subject: summaries[0]?.subject || `Faktura ${invoiceMatch[1]}`,
        customerName: "",
        caseId: "",
        documentType: "Faktura",
        category: "betaling",
        error: match.ambiguous ? "invoice_match_ambiguous" : "invoice_match_low_confidence",
        notes: `Faktura ${invoiceMatch[1]} kunne ikke matches sikkert. Bedste score: ${match.score || 0}${match.reasons?.length ? ` (${match.reasons.join(", ")})` : ""}.`,
      });
      continue;
    }
    const matched = match.matched;
    const date = extractDocumentDate(summaries[0]?.subject || "", threadText, summaries[0]?.date);
    const amount = extractInvoiceAmount(threadText);
    const didApply = applyInvoiceToCase(matched, invoiceMatch[1], date, amount);
    if (didApply) {
      appendActivity(matched, { name: "Gmail-sync", email: MAILBOX_OWNER }, {
        type: "invoice_update",
        title: `Faktura ${invoiceMatch[1]} registreret`,
        summary: `Faktura ${invoiceMatch[1]} er registreret på sagen via Gmail-sync (${match.reasons.join(", ")}).`,
      });
      changed += 1;
    }
  }
  return changed;
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
      if (attachment?.attachmentId && Number(attachment?.size || 0) <= 5_000_000) {
        try {
          const content = await getGmailAttachment(message.id, attachment.attachmentId);
          const isPdf = mimeType === "application/pdf" || /\.pdf$/i.test(filename);
          if (isPdf) {
            const pdfText = await extractPdfText(content);
            if (pdfText) texts.push(pdfText);
          } else if (/^text\//i.test(mimeType) || /\.(txt|csv)$/i.test(filename)) {
            const text = content.toString("utf8").trim();
            if (text) texts.push(text.slice(0, 20_000));
          }
        } catch (error) {
          texts.push(`Attachment kunne ikke læses: ${filename} (${formatSyncError(error)})`);
        }
      }
    }
  }

  return {
    text: texts.join("\n\n"),
    documents,
  };
}

async function extractPdfText(content: Buffer) {
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(content), disableWorker: true });
    const pdf = await loadingTask.promise;
    const pages: string[] = [];
    const maxPages = Math.min(Number(pdf.numPages || 0), 8);
    for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
      const page = await pdf.getPage(pageNo);
      const textContent = await page.getTextContent();
      const pageText = Array.isArray(textContent?.items)
        ? textContent.items.map((item: any) => textValue(item?.str, "")).filter(Boolean).join(" ")
        : "";
      if (pageText.trim()) pages.push(pageText.trim());
    }
    return pages.join("\n").slice(0, 40_000);
  } catch {
    return "";
  }
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
    `- SagsID: ${displayCaseId || "Ikke fundet"}`,
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

function extractEnterpriseAmount(text = "") {
  const source = String(text || "");
  const patterns = [
    /(?:samlet\s+)?(?:entreprisesum|entreprise|tilbudssum|samlet\s+beløb|samlet\s+beloeb|overslagspris)[^\d]{0,80}(\d{1,3}(?:[.\s]\d{3})*(?:,\d{2})?|\d{4,})(?:\s*kr\.?)?/gi,
    /(\d{1,3}(?:[.\s]\d{3})*(?:,\d{2})?|\d{4,})\s*kr\.?[^\n\r]{0,80}(?:samlet\s+)?(?:entreprisesum|entreprise|tilbudssum|samlet\s+beløb|samlet\s+beloeb|overslagspris)/gi,
  ];
  const values: number[] = [];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) {
      const value = parseMoneyValue(match[1]);
      if (value >= 1000) values.push(value);
    }
  }
  return values.length ? Math.max(...values) : 0;
}

function extractInvoiceAmount(text = "") {
  const source = String(text || "");
  const patterns = [
    /(?:total|beløb|beloeb|faktura)[^\d]{0,80}(\d{1,3}(?:[.\s]\d{3})*(?:,\d{2})?|\d{4,})(?:\s*kr\.?)?/gi,
    /(\d{1,3}(?:[.\s]\d{3})*(?:,\d{2})?|\d{4,})\s*kr\.?/gi,
  ];
  const values: number[] = [];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) {
      const value = parseMoneyValue(match[1]);
      if (value >= 1000) values.push(value);
    }
  }
  return values.length ? Math.max(...values) : 0;
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
    matched.status = "Faktura sendt";
    matched.workflow.invoiceNumber = textValue(signal.invoiceNumber, matched.workflow.invoiceNumber);
    matched.workflow.invoiceSentDate = documentDate || new Date().toISOString().slice(0, 10);
    const invoiceAmount = extractInvoiceAmount(archiveText);
    if (invoiceAmount && !parseMoneyValue(textValue(matched.u, ""))) matched.u = formatAmount(invoiceAmount);
    if (!textValue(matched.dato, "")) matched.dato = documentDate || new Date().toISOString().slice(0, 10);
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
  const isRevised = compact.includes("revideret") || compact.includes("revidere") || compact.includes("revision") || isGadesvejArchiveThread(signal, archiveText);
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
    const invoiceCaseMatch = matchInvoiceToCase(state, archiveText);
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
    const hasDriveFile = Boolean(textValue(entry?.driveUrl, "") || textValue(entry?.fileId, ""));
    if (!hasDriveFile) return false;
    if (String(entry?.archiveKey || "") === archiveKey) return true;
    const sameThread = textValue(entry?.threadId, "") === currentThreadId;
    const sameType = normalizeCaseKey(entry?.documentType) === normalizedDocumentType;
    const sameDate = textValue(entry?.documentDate, "") === documentDate;
    const sameFile = textValue(entry?.fileName, "") === fileName;
    return sameFile || (sameThread && sameType && sameDate);
  });
  if (alreadyArchived) {
    return {
      ok: true,
      skipped: true,
      archiveKey,
      category: signal.category,
      matchedCaseId: displayCaseId,
      customerName: textValue(matched?.kunde, item?.kunde || ""),
      documentType: signal.documentType,
      documentDate,
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
  if (integration.configured) {
    const folderInfo = await ensureCaseDriveFolders(matched, displayCaseId, matched.kunde);
    driveFolder = textValue(folderInfo?.caseFolder?.webViewLink, driveFolder);
    matched.docs.drive = driveFolder;
    const folderId = textValue(folderInfo?.folders?.[signal.category]?.id, "");
    if (!folderId) throw new Error(`drive_folder_missing:${signal.category}`);
    uploaded = await uploadDriveFile(folderId, document);
    document.url = textValue(uploaded?.webViewLink, "");
    document.fileId = textValue(uploaded?.id, "");
    document.mimeType = textValue(uploaded?.mimeType, document.mimeType);
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
  const archivedResults: any[] = [];
  const archiveErrors: any[] = [];
  const ensuredFolders = await ensureDriveFoldersForLinkedCases(state);

  try {
    const archiveThreadBatches = await Promise.all(
      ARCHIVE_QUERIES.map((query) => listRecentGmailThreads(query, 6)),
    );
    const archiveThreads = dedupeThreads(archiveThreadBatches.flat()).slice(0, 12);
    const inboxThreads = await listRecentGmailThreads(SYNC_QUERY, 8);
    const threads = dedupeThreads([...archiveThreads, ...inboxThreads]).slice(0, 16);
    const fullThreadResults = await Promise.allSettled(
      threads.map((thread: any) => getGmailThread(String(thread.id))),
    );
    const fullThreads = fullThreadResults
      .filter((result): result is PromiseFulfilledResult<any> => result.status === "fulfilled")
      .map((result) => result.value);
    const invoicesUpdated = registerInvoicesFromThreads(state, fullThreads);
    if (invoicesUpdated) {
      appendSyncLog(state, {
        status: "archived",
        subject: "Fakturaer",
        customerName: "",
        caseId: "",
        documentType: "Faktura",
        category: "betaling",
        notes: `${invoicesUpdated} faktura er registreret på en sag via sikker Gmail/PDF-match.`,
      });
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
      const threadId = textValue(thread?.id, "");
      const item = itemByThreadId.get(threadId);
      if (!item) continue;
      try {
        const result = await archiveQualifiedThread(thread, item, state, integration, auth.actor);
        if (!result) continue;
        if (result.ok) {
          appendSyncLog(state, {
            status: result.skipped ? "skipped" : "archived",
            subject: textValue(item?.subject, ""),
            customerName: textValue(result.customerName, ""),
            caseId: textValue(result.matchedCaseId, ""),
            documentType: textValue(result.documentType, ""),
            category: textValue(result.documentType ? signalCategoryFromResult(result) : "", ""),
            fileName: textValue(result.fileName, ""),
            driveUrl: textValue(result.driveUrl, ""),
            notes: result.skipped
              ? "Mailen var allerede arkiveret på sagen."
              : `Arkiveret i Drive som ${textValue(result.fileName, "dokument")}.`,
          });
          if (!result.skipped) {
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
          appendSyncLog(state, {
            status: "error",
            subject: textValue(item?.subject, ""),
            customerName: textValue(result.customerName, ""),
            caseId: textValue(result.matchedCaseId, ""),
            documentType: textValue(result.documentType, ""),
            category: textValue(result.category, ""),
            error: errorText,
            notes: errorText,
          });
          archiveErrors.push({ ...result, error: errorText });
        }
      } catch (error) {
        const errorText = formatSyncError(error);
        appendSyncLog(state, {
          status: "error",
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
    }

    const offerFollowupsCreated = backfillOfferFollowupsFromState(state);
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
      invoicesUpdated,
      ensuredFolders: ensuredFolders.length,
      archiveErrors,
      archivedCases: archivedResults.map((entry) => ({
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
};
