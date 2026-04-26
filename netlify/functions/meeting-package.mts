import {
  appendActivity,
  authorizeDashboardRequest,
  ensureCaseShape,
  json,
  loadDashboardState,
  matchCase,
  normalizeChangeOrder,
  normalizeTask,
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

function docTitle(prefix: string, body: any, customerName: string) {
  const date = textValue(body.reportDate || body.meetingDate, new Date().toISOString().slice(0, 10));
  const meetingType = textValue(body.meetingType, prefix).trim();
  return `${date} - ${customerName} - ${meetingType}`;
}

function makeDoc(title: string, contentText: string, mimeType = "text/markdown") {
  return {
    title,
    fileName: `${title}.md`,
    mimeType,
    contentText,
    date: new Date().toISOString().slice(0, 10),
  };
}

async function archiveCategory(
  matched: any,
  body: any,
  targetKey: string,
  documents: any[],
  integration: ReturnType<typeof googleIntegrationStatus>,
  folderInfo: any,
) {
  let uploadedCount = 0;
  let providerMode = integration.configured ? "drive_live" : "state_only";

  if (integration.configured) {
    try {
      const targetFolderId = textValue(body.folderId, folderInfo?.folders?.[targetKey]?.id || "");
      const uploadable = documents.filter((doc: any) => doc?.contentBase64 || doc?.contentText);
      for (const doc of uploadable) {
        const uploaded = await uploadDriveFile(targetFolderId, doc);
        doc.url = textValue(uploaded?.webViewLink, doc.url || "");
        doc.fileId = textValue(uploaded?.id, doc.fileId || "");
        doc.mimeType = textValue(uploaded?.mimeType, doc.mimeType || "");
        uploadedCount += 1;
      }
    } catch (error) {
      providerMode = "drive_error";
      body.providerError = textValue((error as Error)?.message, "drive_error");
    }
  }

  pushDocs(matched.docs[targetKey], documents);
  return { uploadedCount, providerMode };
}

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

  const now = new Date().toISOString();
  const customerName = textValue(matched.kunde || body.customerName, body.customerName);

  appendActivity(matched, actor, {
    type: "meeting_package",
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

  const docs = body.documents && typeof body.documents === "object" ? body.documents : {};
  const integration = googleIntegrationStatus();
  let folderInfo: any = null;
  let driveMode = integration.configured ? "drive_live" : "state_only";
  let uploadedCount = 0;
  const archived: string[] = [];

  if (integration.configured) {
    try {
      folderInfo = await ensureCaseDriveFolders(matched, matched.nr, matched.kunde);
      matched.docs.drive = textValue(folderInfo?.caseFolder?.webViewLink, matched.docs.drive);
    } catch (error) {
      driveMode = "drive_error";
      body.providerError = textValue((error as Error)?.message, "drive_root_error");
    }
  }

  const referenceDocs = Array.isArray(docs.references) ? [...docs.references] : [];
  const transcriptDocs = Array.isArray(docs.transcripts) ? [...docs.transcripts] : [];
  const ksDocs = Array.isArray(docs.ks) ? [...docs.ks] : [];
  const photoDocs = Array.isArray(docs.photos) ? [...docs.photos] : [];
  const offerDocs = Array.isArray(docs.offers) ? [...docs.offers] : [];
  const contractDocs = Array.isArray(docs.contracts) ? [...docs.contracts] : [];
  const extraDocs = Array.isArray(docs.extraWork) ? [...docs.extraWork] : [];
  const mailDocs = Array.isArray(docs.emails) ? [...docs.emails] : [];

  if (textValue(body.noteText).trim()) {
    const title = docTitle("Referat", body, customerName);
    referenceDocs.unshift(makeDoc(title, textValue(body.noteText)));
  }
  if (textValue(body.transcriptText).trim()) {
    const title = docTitle("Transkript", body, customerName);
    transcriptDocs.unshift(makeDoc(title, textValue(body.transcriptText)));
  }

  const archivePlans: Array<[string, any[]]> = [
    ["referater", referenceDocs],
    ["transkripter", transcriptDocs],
    ["ks", ksDocs],
    ["billeder", photoDocs],
    ["tilbud", offerDocs],
    ["kontrakter", contractDocs],
    ["ekstraarbejde", extraDocs],
    ["mails", mailDocs],
  ];

  for (const [category, documents] of archivePlans) {
    if (!documents.length) continue;
    const targetKey = DOC_MAP[category] || category;
    const result = await archiveCategory(matched, body, targetKey, documents, integration, folderInfo);
    uploadedCount += result.uploadedCount;
    if (result.providerMode === "drive_error") driveMode = "drive_error";
    archived.push(targetKey);
  }

  const savedAt = await saveDashboardState(state);

  return json({
    ok: true,
    savedAt,
    matchedCase: {
      caseNumber: matched.nr,
      customerName: matched.kunde,
      nextAction: matched.workflow.nextAction,
      progressPct: matched.workflow.progressPct,
      tasks: matched.tasks.length,
      driveFolder: matched.docs.drive,
    },
    drive: {
      configured: integration.configured,
      providerMode: driveMode,
      archived,
      uploadedCount,
      driveFolder: matched.docs.drive,
    },
    note: integration.configured
      ? driveMode === "drive_live"
        ? "Mødepakke er gemt på sagen og arkiveret live i Google Drive."
        : "Mødepakke er gemt på sagen, men Drive-arkivering fejlede."
      : "Mødepakke er gemt på sagen. Google Drive er ikke konfigureret endnu.",
  });
};

export const config = {
  path: "/api/meeting-package",
};
