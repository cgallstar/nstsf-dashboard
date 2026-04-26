import {
  appendActivity,
  authorizeDashboardRequest,
  ensureCaseShape,
  json,
  loadDashboardState,
  matchCase,
  normalizeDraft,
  saveDashboardState,
  textValue,
} from "./_lib/dashboard.mts";

export default async (request: Request) => {
  const auth = authorizeDashboardRequest(request, { allowActionsToken: true });
  if (!auth.ok) return auth.response;

  if (request.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const state = await loadDashboardState();
  if (!state) return json({ ok: false, error: "no_state" }, 404);

  const matched = matchCase(state.sager, body.caseNumber, body.customerName);
  if (!matched) return json({ ok: false, error: "case_not_found" }, 404);
  ensureCaseShape(matched);

  const draft = normalizeDraft({
    type: textValue(body.type, "referat"),
    subject: textValue(body.subject, "Mailudkast"),
    body: textValue(body.body, ""),
    recipients: Array.isArray(body.recipients) ? body.recipients : [],
    cc: Array.isArray(body.cc) ? body.cc : [],
    bcc: Array.isArray(body.bcc) ? body.bcc : [],
    status: "Klar til godkendelse",
  });

  draft.approvalRequired = true;
  draft.externalStatus = "not_sent";
  draft.source = textValue(body.source, auth.actor?.type || "system");

  matched.mailDrafts.unshift(draft);
  matched.docs.mails.unshift({
    titel: draft.subject,
    dato: String(draft.createdAt).slice(0, 10),
    url: "",
    fileId: draft.gmailDraftId || "",
    notes: "Draft oprettet og afventer godkendelse",
  });

  appendActivity(matched, auth.actor, {
    type: "gmail_draft",
    source: draft.source,
    subject: draft.subject,
    recipients: draft.recipients,
    status: draft.status,
  });

  const savedAt = await saveDashboardState(state);

  return json({
    ok: true,
    mode: "draft_first",
    savedAt,
    draft: {
      id: draft.id,
      subject: draft.subject,
      status: draft.status,
      recipients: draft.recipients,
    },
    note: "Gmail API er ikke koblet på endnu. Draft er gemt centralt under kunden og klar til næste integrationslag.",
  });
};

export const config = {
  path: "/api/gmail-draft",
};
