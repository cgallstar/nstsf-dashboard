import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { getStore } from "@netlify/blobs";

const STORE_NAME = "nstsf-dashboard";
const STATE_KEY = "state-v1";
const SESSION_COOKIE = "nstsf_session";
const AUTH_SECRET = Netlify.env.get("DASHBOARD_AUTH_SECRET") || "nstsf-auth-fallback-2026";
const ACTIONS_TOKEN = Netlify.env.get("GPT_ACTIONS_TOKEN") || "";

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

export function textValue(value: unknown, fallback = "") {
  if (value === null || value === undefined) return fallback;
  return String(value);
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

function sign(value: string) {
  return createHmac("sha256", AUTH_SECRET).update(value).digest("base64url");
}

function readCookieSession(request: Request) {
  const cookies = parseCookies(request.headers.get("cookie") || "");
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;

  const idx = token.lastIndexOf(".");
  if (idx === -1) return null;
  const payload = token.slice(0, idx);
  const signature = token.slice(idx + 1);
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!session.exp || session.exp < Date.now()) return null;
    return {
      type: "session",
      name: textValue(session.name, session.email || "Dashboard user"),
      email: textValue(session.email, ""),
      role: textValue(session.role, "user"),
    };
  } catch {
    return null;
  }
}

function readApiKey(request: Request) {
  const authHeader = request.headers.get("authorization") || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const key = bearer || request.headers.get("x-api-key") || "";
  if (!ACTIONS_TOKEN || !key) return null;
  return key === ACTIONS_TOKEN
    ? {
        type: "actions",
        name: textValue(request.headers.get("x-actor-name"), "Custom GPT"),
        email: textValue(request.headers.get("x-actor-email"), ""),
        role: "system",
      }
    : null;
}

export function authorizeDashboardRequest(request: Request, options: { allowActionsToken?: boolean } = {}) {
  const session = readCookieSession(request);
  if (session) return { ok: true as const, actor: session };

  if (options.allowActionsToken) {
    const actor = readApiKey(request);
    if (actor) return { ok: true as const, actor };
  }

  return { ok: false as const, response: json({ ok: false, error: "unauthorized" }, 401) };
}

export function store() {
  return getStore(STORE_NAME, { consistency: "strong" });
}

export async function loadDashboardState() {
  const entry = await store().getWithMetadata(STATE_KEY, { type: "json" });
  if (!entry?.data || !Array.isArray((entry.data as any).sager)) {
    return null;
  }
  return entry.data as any;
}

export async function saveDashboardState(state: any) {
  const savedAt = new Date().toISOString();
  state.savedAt = savedAt;
  state.schema = state.schema || "nstsf-dashboard-state-v1";
  await store().setJSON(STATE_KEY, state, { metadata: { savedAt } });
  return savedAt;
}

export function normalizeDoc(doc: any) {
  return {
    titel: textValue(doc?.titel || doc?.title, "Dokument"),
    dato: textValue(doc?.dato || doc?.date, new Date().toISOString().slice(0, 10)),
    url: textValue(doc?.url, ""),
    fileId: textValue(doc?.fileId, ""),
    mimeType: textValue(doc?.mimeType, ""),
    notes: textValue(doc?.notes, ""),
  };
}

export function normalizeTask(task: any) {
  return {
    id: textValue(task?.id, randomUUID()),
    title: textValue(task?.title || task, "Opgave"),
    status: textValue(task?.status, "Åben"),
    dueDate: textValue(task?.dueDate, ""),
    owner: textValue(task?.owner, ""),
    notes: textValue(task?.notes, ""),
    createdAt: new Date().toISOString(),
  };
}

export function normalizeChangeOrder(item: any) {
  return {
    id: textValue(item?.id, randomUUID()),
    title: textValue(item?.title || item, "Ekstraarbejde"),
    status: textValue(item?.status, "Afventer"),
    amount: textValue(item?.amount, ""),
    notes: textValue(item?.notes, ""),
    createdAt: new Date().toISOString(),
  };
}

export function normalizeDraft(draft: any) {
  return {
    id: textValue(draft?.id, randomUUID()),
    subject: textValue(draft?.subject, "Mailudkast"),
    body: textValue(draft?.body, ""),
    recipients: Array.isArray(draft?.recipients) ? draft.recipients.map((r: unknown) => String(r)) : [],
    cc: Array.isArray(draft?.cc) ? draft.cc.map((r: unknown) => String(r)) : [],
    bcc: Array.isArray(draft?.bcc) ? draft.bcc.map((r: unknown) => String(r)) : [],
    gmailDraftId: textValue(draft?.gmailDraftId, ""),
    status: textValue(draft?.status, "Klar til godkendelse"),
    createdAt: new Date().toISOString(),
    type: textValue(draft?.type, "general"),
  };
}

export function ensureCaseShape(entry: any) {
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

export function matchCase(sager: any[], caseNumber: string, customerName: string) {
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

export function pushDocs(target: any[], items: any[]) {
  items.map(normalizeDoc).forEach((item) => target.unshift(item));
}

export function appendActivity(caseEntry: any, actor: any, payload: Record<string, unknown>) {
  caseEntry.activityLog.unshift({
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    actor: {
      name: textValue(actor?.name, "System"),
      email: textValue(actor?.email, ""),
      type: textValue(actor?.type, "system"),
    },
    ...payload,
  });
}
