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
import { ensureCaseDriveFolders, googleIntegrationStatus, uploadDriveFile } from "./_lib/google.mts";

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
  const integration = googleIntegrationStatus();
  let providerMode = "state_only";
  let uploadedCount = 0;
  let folderInfo: any = null;

  if (integration.configured) {
    try {
      folderInfo = await ensureCaseDriveFolders(matched, matched.nr, matched.kunde);
      matched.docs.drive = textValue(folderInfo?.caseFolder?.webViewLink, matched.docs.drive);
      const targetFolderId = textValue(body.folderId, folderInfo?.folders?.[targetKey]?.id || "");
      const uploadable = documents.filter((doc: any) => doc?.contentBase64 || doc?.contentText);
      for (const doc of uploadable) {
        const uploaded = await uploadDriveFile(targetFolderId, doc);
        doc.url = textValue(uploaded?.webViewLink, doc.url || "");
        doc.fileId = textValue(uploaded?.id, doc.fileId || "");
        doc.mimeType = textValue(uploaded?.mimeType, doc.mimeType || "");
        uploadedCount += 1;
      }
      providerMode = "drive_live";
    } catch (error) {
      providerMode = "drive_error";
      body.providerError = textValue((error as Error)?.message, "drive_error");
    }
  }

  pushDocs(matched.docs[targetKey], documents);

  appendActivity(matched, actor, {
    type: "drive_archive",
    category: targetKey,
    folderId: textValue(body.folderId, ""),
    folderName: textValue(body.folderName, ""),
    documentCount: documents.length,
    uploadedCount,
    providerMode,
  });

  const savedAt = await saveDashboardState(state);

  return json({
    ok: true,
    savedAt,
    archivedTo: targetKey,
    count: documents.length,
    uploadedCount,
    providerMode,
    integration,
    driveFolder: matched.docs.drive,
    note: integration.configured
      ? providerMode === "drive_live"
        ? "Dokumenter er arkiveret live i Google Drive og gemt centralt under kunden."
        : "Dokumentreferencer er gemt centralt, men Drive-upload fejlede."
      : "Dokumentreferencer er gemt centralt. Google Drive OAuth er ikke konfigureret endnu.",
  });
};

export const config = {
  path: "/api/drive-archive",
};
