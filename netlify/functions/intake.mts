import {
  appendActivity,
  authorizeDashboardRequest,
  ensureCaseShape,
  json,
  loadDashboardState,
  matchCase,
  normalizeChangeOrder,
  normalizeDraft,
  normalizeTask,
  pushDocs,
  saveDashboardState,
  textValue,
} from "./_lib/dashboard.mts";

export default async (request: Request) => {
  const auth = authorizeDashboardRequest(request, { allowActionsToken: true });
  if (!auth.ok) return auth.response;

  if (request.method === "GET") {
    return json({
      ok: true,
      endpoint: "/api/intake",
      authModes: ["dashboard_session", "gpt_actions_token"],
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

  const state = await loadDashboardState();
  if (!state) {
    return json({ ok: false, error: "no_state" }, 404);
  }

  const matched = matchCase(state.sager, body.caseNumber, body.customerName);
  if (!matched) {
    return json({ ok: false, error: "case_not_found" }, 404);
  }

  ensureCaseShape(matched);

  const now = new Date().toISOString();
  appendActivity(matched, auth.actor, {
    type: "intake",
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
      createdAt: now,
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

  const savedAt = await saveDashboardState(state);

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
