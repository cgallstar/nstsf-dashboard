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
import { createGmailDraft, googleIntegrationStatus } from "./_lib/google.mts";

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
  const actor = {
    ...auth.actor,
    name: textValue(body.actorName, auth.actor?.name || "Custom GPT"),
    email: textValue(body.actorEmail, auth.actor?.email || ""),
  };

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
  draft.source = textValue(body.source, actor.name || auth.actor?.type || "system");
  draft.provider = "gmail";

  const integration = googleIntegrationStatus();
  let providerDraftId = "";
  let providerMessageId = "";
  let providerMode = "state_only";

  if (integration.configured) {
    try {
      const gmailDraft = await createGmailDraft(body);
      providerDraftId = textValue(gmailDraft?.id, "");
      providerMessageId = textValue(gmailDraft?.message?.id, "");
      draft.gmailDraftId = providerDraftId;
      draft.externalStatus = providerDraftId ? "gmail_draft_created" : "not_sent";
      providerMode = providerDraftId ? "gmail_live" : "state_only";
    } catch (error) {
      draft.externalStatus = "gmail_error";
      draft.providerError = textValue((error as Error)?.message, "gmail_error");
      providerMode = "gmail_error";
    }
  }

  matched.mailDrafts.unshift(draft);
  matched.docs.mails.unshift({
    titel: draft.subject,
    dato: String(draft.createdAt).slice(0, 10),
    url: "",
    fileId: draft.gmailDraftId || providerMessageId || "",
    notes: integration.configured
      ? draft.externalStatus === "gmail_draft_created"
        ? "Gmail-kladde oprettet og afventer godkendelse"
        : "Kladde gemt centralt, men Gmail-oprettelse fejlede"
      : "Kladde gemt centralt. Gmail er ikke konfigureret endnu.",
  });

  appendActivity(matched, actor, {
    type: "gmail_draft",
    source: draft.source,
    subject: draft.subject,
    recipients: draft.recipients,
    status: draft.status,
    providerMode,
    gmailDraftId: draft.gmailDraftId || "",
  });

  const savedAt = await saveDashboardState(state);

  return json({
    ok: true,
    mode: "draft_first",
    providerMode,
    savedAt,
    draft: {
      id: draft.id,
      subject: draft.subject,
      status: draft.status,
      recipients: draft.recipients,
      gmailDraftId: draft.gmailDraftId || "",
      externalStatus: draft.externalStatus,
    },
    integration,
    note: integration.configured
      ? draft.externalStatus === "gmail_draft_created"
        ? "Gmail-kladde er oprettet live og gemt centralt under kunden."
        : "Kladde er gemt centralt, men Gmail-oprettelsen fejlede. Se providerError i state."
      : "Kladde er gemt centralt. Google/Gmail OAuth er ikke konfigureret endnu.",
  });
};

export const config = {
  path: "/api/gmail-draft",
};
