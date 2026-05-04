import {
  authorizeDashboardRequest,
  ensureCaseShape,
  json,
  loadDashboardState,
  saveDashboardState,
  textValue,
} from "./_lib/dashboard.mts";
import {
  ensureCaseDriveFolders,
  googleIntegrationStatus,
  listDriveFilesByName,
  trashDriveFile,
} from "./_lib/google.mts";

const DOC_CATEGORIES = ["tilbud", "referater", "byggereferater", "mails", "betaling", "ks", "billeder", "ekstraarbejde", "kontrakter", "transkripter"];

function normalizeFileName(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function docFileName(doc: any) {
  const title = textValue(doc?.titel || doc?.title, "");
  const explicit = textValue(doc?.fileName || doc?.filename, "");
  if (explicit) return normalizeFileName(explicit);
  if (!title) return "";
  return /\.md$/i.test(title) ? normalizeFileName(title) : normalizeFileName(`${title}.md`);
}

function docKey(doc: any) {
  const fileId = textValue(doc?.fileId, "");
  const url = textValue(doc?.url, "");
  if (fileId) return `file:${fileId}`;
  if (url) return `url:${url}`;
  return [
    textValue(doc?.titel || doc?.title, "").toLowerCase().replace(/\s+/g, " ").trim(),
    textValue(doc?.dato || doc?.date, ""),
    textValue(doc?.mimeType, ""),
  ].join("|");
}

function dedupeStateDocs(caseEntry: any) {
  let removed = 0;
  for (const category of DOC_CATEGORIES) {
    const docs = Array.isArray(caseEntry?.docs?.[category]) ? caseEntry.docs[category] : [];
    const seen = new Set<string>();
    const kept: any[] = [];
    for (const doc of docs) {
      const key = docKey(doc);
      if (seen.has(key)) {
        removed += 1;
        continue;
      }
      seen.add(key);
      kept.push(doc);
    }
    caseEntry.docs[category] = kept;
  }
  return removed;
}

function pickKeeper(files: any[]) {
  return [...files].sort((a, b) => {
    const aHasLink = textValue(a?.webViewLink, "") ? 1 : 0;
    const bHasLink = textValue(b?.webViewLink, "") ? 1 : 0;
    if (aHasLink !== bHasLink) return bHasLink - aHasLink;
    return textValue(b?.modifiedTime || b?.createdTime, "").localeCompare(textValue(a?.modifiedTime || a?.createdTime, ""));
  })[0];
}

export default async (request: Request) => {
  const auth = authorizeDashboardRequest(request, { allowActionsToken: true });
  if (!auth.ok) return auth.response;

  if (request.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const execute = body?.execute === true;
  const state = await loadDashboardState();
  if (!state) return json({ ok: false, error: "no_state" }, 404);

  const integration = googleIntegrationStatus();
  if (!integration.configured) return json({ ok: false, error: "google_not_configured" }, 400);

  const plans: any[] = [];
  let stateDuplicatesRemoved = 0;

  for (const caseEntry of Array.isArray(state.sager) ? state.sager : []) {
    ensureCaseShape(caseEntry);
    stateDuplicatesRemoved += dedupeStateDocs(caseEntry);

    const caseId = textValue(caseEntry.sid || caseEntry.nr, "");
    const customerName = textValue(caseEntry.kunde, "");
    const docsByCategory = DOC_CATEGORIES.flatMap((category) => {
      const docs = Array.isArray(caseEntry?.docs?.[category]) ? caseEntry.docs[category] : [];
      return docs.map((doc: any) => ({ category, doc, fileName: docFileName(doc) })).filter((entry) => entry.fileName);
    });
    if (!docsByCategory.length) continue;

    let folderInfo: any;
    try {
      folderInfo = await ensureCaseDriveFolders(caseEntry, caseId, customerName);
    } catch {
      continue;
    }

    const seenNames = new Set<string>();
    for (const entry of docsByCategory) {
      const nameKey = `${entry.category}:${entry.fileName}`;
      if (seenNames.has(nameKey)) continue;
      seenNames.add(nameKey);
      const folderId = textValue(folderInfo?.folders?.[entry.category]?.id, "");
      if (!folderId) continue;
      const files = await listDriveFilesByName(folderId, entry.fileName);
      if (files.length <= 1) continue;
      const keeper = pickKeeper(files);
      const duplicates = files.filter((file) => textValue(file?.id, "") !== textValue(keeper?.id, ""));
      plans.push({
        caseId,
        customerName,
        category: entry.category,
        fileName: entry.fileName,
        folderId,
        keeper,
        duplicates,
      });
    }
  }

  const trashed: any[] = [];
  if (execute) {
    for (const plan of plans) {
      for (const duplicate of plan.duplicates) {
        const fileId = textValue(duplicate?.id, "");
        if (!fileId) continue;
        await trashDriveFile(fileId);
        trashed.push({
          caseId: plan.caseId,
          customerName: plan.customerName,
          category: plan.category,
          fileName: plan.fileName,
          fileId,
          webViewLink: textValue(duplicate?.webViewLink, ""),
        });
      }
    }
  }

  const savedAt = execute || stateDuplicatesRemoved ? await saveDashboardState(state) : state.savedAt;

  return json({
    ok: true,
    mode: execute ? "execute" : "preview",
    savedAt,
    duplicateGroups: plans.length,
    duplicateFiles: plans.reduce((sum, plan) => sum + plan.duplicates.length, 0),
    stateDuplicatesRemoved,
    trashed,
    plans: plans.map((plan) => ({
      caseId: plan.caseId,
      customerName: plan.customerName,
      category: plan.category,
      fileName: plan.fileName,
      keeper: {
        id: textValue(plan.keeper?.id, ""),
        webViewLink: textValue(plan.keeper?.webViewLink, ""),
        modifiedTime: textValue(plan.keeper?.modifiedTime, ""),
      },
      duplicates: plan.duplicates.map((file: any) => ({
        id: textValue(file?.id, ""),
        webViewLink: textValue(file?.webViewLink, ""),
        modifiedTime: textValue(file?.modifiedTime, ""),
      })),
    })),
  });
};

export const config = {
  path: "/api/drive-cleanup",
  maxDuration: 26,
};
