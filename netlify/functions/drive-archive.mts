import {
  appendActivity,
  authorizeDashboardRequest,
  ensureCaseShape,
  json,
  loadDashboardState,
  matchCase,
  pushDocs,
  saveDashboardState,
  textValue,
} from "./_lib/dashboard.mts";

const DOC_MAP: Record<string, string> = {
  tilbud: "tilbud",
  referater: "referater",
  ks: "ks",
  billeder: "billeder",
  ekstraarbejde: "ekstraarbejde",
  betaling: "betaling",
  kontrakter: "kontrakter",
  transkripter: "transkripter",
  mails: "mails",
};

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

  const category = textValue(body.category, "referater").toLowerCase();
  const targetKey = DOC_MAP[category] || "referater";
  const documents = Array.isArray(body.documents) ? body.documents : [];
  pushDocs(matched.docs[targetKey], documents);

  appendActivity(matched, actor, {
    type: "drive_archive",
    category: targetKey,
    folderId: textValue(body.folderId, ""),
    folderName: textValue(body.folderName, ""),
    documentCount: documents.length,
  });

  const savedAt = await saveDashboardState(state);

  return json({
    ok: true,
    savedAt,
    archivedTo: targetKey,
    count: documents.length,
    note: "Drive API er ikke koblet på endnu. Dokumentreferencer er gemt centralt under kunden og klar til næste integrationslag.",
  });
};

export const config = {
  path: "/api/drive-archive",
};
