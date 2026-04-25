import { createHmac, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";

const STORE_NAME = "nstsf-dashboard";
const STATE_KEY = "state-v1";
const SESSION_COOKIE = "nstsf_session";
const AUTH_SECRET = Netlify.env.get("DASHBOARD_AUTH_SECRET") || "nstsf-auth-fallback-2026";

const json = (body: unknown, status = 200) =>
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

function sign(value: string) {
  return createHmac("sha256", AUTH_SECRET).update(value).digest("base64url");
}

function authorize(request: Request) {
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
    return { ok: true, session };
  } catch {
    return { ok: false, response: json({ ok: false, error: "unauthorized" }, 401) };
  }
}

function store() {
  return getStore(STORE_NAME, { consistency: "strong" });
}

function textValue(value: unknown, fallback = "") {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function normalizeDoc(doc: any) {
  return {
    titel: textValue(doc?.titel || doc?.title, "Dokument"),
    dato: textValue(doc?.dato || doc?.date, new Date().toISOString().slice(0, 10)),
    url: textValue(doc?.url, ""),
    fileId: textValue(doc?.fileId, ""),
  };
}

function normalizeTask(task: any) {
  return {
    title: textValue(task?.title || task, "Opgave"),
    status: textValue(task?.status, "Åben"),
    dueDate: textValue(task?.dueDate, ""),
    owner: textValue(task?.owner, ""),
    notes: textValue(task?.notes, ""),
    createdAt: new Date().toISOString(),
  };
}

function normalizeChangeOrder(item: any) {
  return {
    title: textValue(item?.title || item, "Ekstraarbejde"),
    status: textValue(item?.status, "Afventer"),
    amount: textValue(item?.amount, ""),
    notes: textValue(item?.notes, ""),
    createdAt: new Date().toISOString(),
  };
}

function normalizeDraft(draft: any) {
  return {
    subject: textValue(draft?.subject, "Mailudkast"),
    body: textValue(draft?.body, ""),
    recipients: Array.isArray(draft?.recipients) ? draft.recipients.map((r: unknown) => String(r)) : [],
    gmailDraftId: textValue(draft?.gmailDraftId, ""),
    status: textValue(draft?.status, "Klar til godkendelse"),
    createdAt: new Date().toISOString(),
  };
}

function ensureCaseShape(entry: any) {
  entry.workflow = {
    nextAction: textValue(entry?.workflow?.nextAction, ""),
    summaryStatus: textValue(entry?.workflow?.summaryStatus, ""),
    progressPct: Number(entry?.workflow?.progressPct) || 0,
    signatureStatus: textValue(entry?.workflow?.signatureStatus, ""),
    acceptedScope: textValue(entry?.workflow?.acceptedScope, ""),
    exclusions: textValue(entry?.workflow?.exclusions, ""),
    currentStage: textValue(entry?.workflow?.currentStage, ""),
    nextStep: textValue(entry?.workflow?.nextStep, ""),
  };
  entry.tasks = Array.isArray(entry?.tasks) ? entry.tasks : [];
  entry.stageLog = Array.isArray(entry?.stageLog) ? entry.stageLog : [];
  entry.changeOrders = Array.isArray(entry?.changeOrders) ? entry.changeOrders : [];
  entry.mailDrafts = Array.isArray(entry?.mailDrafts) ? entry.mailDrafts : [];
  entry.activityLog = Array.isArray(entry?.activityLog) ? entry.activityLog : [];
  entry.docs = {
    drive: textValue(entry?.docs?.drive || entry?.drive, ""),
    byggereferater: Array.isArray(entry?.docs?.byggereferater) ? entry.docs.byggereferater : [],
    transkripter: Array.isArray(entry?.docs?.transkripter) ? entry.docs.transkripter : [],
    tilbud: Array.isArray(entry?.docs?.tilbud) ? entry.docs.tilbud : [],
    referater: Array.isArray(entry?.docs?.referater) ? entry.docs.referater : [],
    ks: Array.isArray(entry?.docs?.ks) ? entry.docs.ks : [],
    billeder: Array.isArray(entry?.docs?.billeder) ? entry.docs.billeder : [],
    ekstraarbejde: Array.isArray(entry?.docs?.ekstraarbejde) ? entry.docs.ekstraarbejde : [],
    betaling: Array.isArray(entry?.docs?.betaling) ? entry.docs.betaling : [],
    kontrakter: Array.isArray(entry?.docs?.kontrakter) ? entry.docs.kontrakter : [],
    mails: Array.isArray(entry?.docs?.mails) ? entry.docs.mails : [],
  };
  return entry;
}

function matchCase(sager: any[], caseNumber: string, customerName: string) {
  const nr = textValue(caseNumber, "").trim().toLowerCase();
  const customer = textValue(customerName, "").trim().toLowerCase();
  return sager.find((entry) => {
    const sagNr = textValue(entry?.nr, "").trim().toLowerCase();
    const kunde = textValue(entry?.kunde, "").trim().toLowerCase();
    if (nr && sagNr && nr === sagNr) return true;
    if (!customer || !kunde) return false;
    return kunde.includes(customer) || customer.includes(kunde);
  });
}

function pushDocs(target: any[], items: any[]) {
  items.map(normalizeDoc).forEach((item) => target.unshift(item));
}

export default async (request: Request) => {
  const auth = authorize(request);
  if (!auth.ok) return auth.response;

  if (request.method === "GET") {
    return json({
      ok: true,
      endpoint: "/api/intake",
      actions: ["create_note", "create_meeting_summary", "create_email_draft", "archive_to_drive", "update_case_progress"],
    });
  }

  if (request.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const entry = await store().getWithMetadata(STATE_KEY, { type: "json" });
  if (!entry?.data || !Array.isArray((entry.data as any).sager)) {
    return json({ ok: false, error: "no_state" }, 404);
  }

  const state: any = entry.data;
  const matched = matchCase(state.sager, body.caseNumber, body.customerName);
  if (!matched) {
    return json({ ok: false, error: "case_not_found" }, 404);
  }

  ensureCaseShape(matched);

  const now = new Date().toISOString();
  matched.activityLog.unshift({
    createdAt: now,
    source: textValue(body.source, "custom-gpt"),
    meetingType: textValue(body.meetingType, ""),
    noteText: textValue(body.noteText, ""),
    transcriptText: textValue(body.transcriptText, ""),
    decisions: Array.isArray(body.decisions) ? body.decisions.map((x: unknown) => String(x)) : [],
    nextAction: textValue(body.nextAction, ""),
  });

  if (body.nextAction) matched.workflow.nextAction = textValue(body.nextAction);
  if (body.summaryStatus) matched.workflow.summaryStatus = textValue(body.summaryStatus);
  if (body.signatureStatus) matched.workflow.signatureStatus = textValue(body.signatureStatus);
  if (body.acceptedScope) matched.workflow.acceptedScope = textValue(body.acceptedScope);
  if (body.exclusions) matched.workflow.exclusions = textValue(body.exclusions);
  if (body.currentStage) matched.workflow.currentStage = textValue(body.currentStage);
  if (body.nextStep) matched.workflow.nextStep = textValue(body.nextStep);
  if (body.progressPct !== undefined) matched.workflow.progressPct = Number(body.progressPct) || 0;

  if (Array.isArray(body.todos)) {
    body.todos.map(normalizeTask).forEach((task: any) => matched.tasks.unshift(task));
  }

  if (Array.isArray(body.changeOrders)) {
    body.changeOrders.map(normalizeChangeOrder).forEach((item: any) => matched.changeOrders.unshift(item));
  }

  if (body.currentStage || body.progressPct !== undefined || body.stageNote) {
    matched.stageLog.unshift({
      title: textValue(body.currentStage || body.stageTitle, "Stadeopdatering"),
      date: textValue(body.stageDate, now.slice(0, 10)),
      progressPct: body.progressPct !== undefined ? Number(body.progressPct) || 0 : matched.workflow.progressPct,
      notes: textValue(body.stageNote || body.noteText, ""),
    });
  }

  if (body.draft) {
    matched.mailDrafts.unshift(normalizeDraft(body.draft));
  }

  const docs = body.documents && typeof body.documents === "object" ? body.documents : {};
  if (Array.isArray(docs.transcripts)) pushDocs(matched.docs.transkripter, docs.transcripts);
  if (Array.isArray(docs.references)) {
    pushDocs(matched.docs.byggereferater, docs.references);
    pushDocs(matched.docs.referater, docs.references);
  }
  if (Array.isArray(docs.offers)) pushDocs(matched.docs.tilbud, docs.offers);
  if (Array.isArray(docs.ks)) pushDocs(matched.docs.ks, docs.ks);
  if (Array.isArray(docs.photos)) pushDocs(matched.docs.billeder, docs.photos);
  if (Array.isArray(docs.contracts)) pushDocs(matched.docs.kontrakter, docs.contracts);
  if (Array.isArray(docs.extraWork)) pushDocs(matched.docs.ekstraarbejde, docs.extraWork);
  if (Array.isArray(docs.emails)) pushDocs(matched.docs.mails, docs.emails);

  const savedAt = new Date().toISOString();
  state.savedAt = savedAt;
  state.schema = state.schema || "nstsf-dashboard-state-v1";

  await store().setJSON(STATE_KEY, state, { metadata: { savedAt } });

  return json({
    ok: true,
    savedAt,
    matchedCase: {
      caseNumber: matched.nr,
      customerName: matched.kunde,
      nextAction: matched.workflow.nextAction,
      progressPct: matched.workflow.progressPct,
      drafts: matched.mailDrafts.length,
      tasks: matched.tasks.length,
    },
  });
};

export const config = {
  path: "/api/intake",
};
