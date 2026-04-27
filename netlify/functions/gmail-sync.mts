import {
  authorizeDashboardRequest,
  json,
  loadDashboardState,
  saveDashboardState,
  textValue,
} from "./_lib/dashboard.mts";
import { getGmailThread, gmailMessageSummary, googleIntegrationStatus, listRecentGmailThreads } from "./_lib/google.mts";

const INTERNAL_PATTERNS = [/@nstsf\.dk/i, /gemini-notes@google\.com/i];
const SYNC_QUERY = "newer_than:45d -in:spam -in:trash";

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
  let best: any = null;
  let bestScore = 0;
  for (const entry of sager) {
    let score = 0;
    const kunde = String(entry?.kunde || "").toLowerCase();
    const adr = String(entry?.adr || "").toLowerCase();
    const nr = String(entry?.nr || "").toLowerCase();
    const opg = String(entry?.opg || "").toLowerCase();
    if (kunde && lower.includes(kunde)) score += 3;
    if (adr && lower.includes(adr)) score += 5;
    if (nr && lower.includes(nr)) score += 2;
    if (opg && opg.length > 12 && lower.includes(opg)) score += 1;
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
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

  const threads = await listRecentGmailThreads(SYNC_QUERY, 40);
  const fullThreads = await Promise.all(threads.map((thread: any) => getGmailThread(String(thread.id))));
  const items = fullThreads
    .map((thread) => toEmailEntry(thread, state.sager || []))
    .filter(Boolean)
    .sort((a: any, b: any) => String(b.date).localeCompare(String(a.date)));

  state.emails = items;
  const savedAt = await saveDashboardState(state);

  return json({
    ok: true,
    savedAt,
    synced: items.length,
    unhandled: items.filter((item: any) => !item.handled).length,
    note: "Gmail-tråde er hentet og gemt i central state.",
  });
};

export const config = {
  path: "/api/gmail-sync",
};
