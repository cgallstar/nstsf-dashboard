import { randomUUID } from "node:crypto";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_DRAFTS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/drafts";
const GMAIL_THREADS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/threads";
const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const GOOGLE_DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";

function env(name: string) {
  return String(Netlify.env.get(name) || "").trim();
}

function text(value: unknown, fallback = "") {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function toBase64Url(input: string | Buffer) {
  return Buffer.from(input).toString("base64url");
}

function fromBase64(data = "") {
  const normalized = String(data).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64");
}

function escapeHeader(value = "") {
  return String(value).replace(/[\r\n]+/g, " ").trim();
}

function encodeQuotedPrintable(textBody: string) {
  return textBody
    .replace(/\r?\n/g, "\r\n")
    .replace(/[\u0080-\uFFFF]/g, (char) => {
      return Buffer.from(char, "utf8")
        .toString("hex")
        .match(/.{1,2}/g)!
        .map((byte) => `=${byte.toUpperCase()}`)
        .join("");
    })
    .replace(/=$/gm, "=3D");
}

function buildMimeMessage(body: any) {
  const to = Array.isArray(body.recipients) ? body.recipients.map((x: unknown) => String(x)).filter(Boolean) : [];
  const cc = Array.isArray(body.cc) ? body.cc.map((x: unknown) => String(x)).filter(Boolean) : [];
  const bcc = Array.isArray(body.bcc) ? body.bcc.map((x: unknown) => String(x)).filter(Boolean) : [];
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  const subject = escapeHeader(text(body.subject, "Mailudkast"));
  const plain = text(body.body, "");
  const html = text(body.html, "");

  const headers = [
    `Subject: ${subject}`,
    to.length ? `To: ${to.join(", ")}` : "",
    cc.length ? `Cc: ${cc.join(", ")}` : "",
    bcc.length ? `Bcc: ${bcc.join(", ")}` : "",
    "MIME-Version: 1.0",
  ].filter(Boolean);

  if (!attachments.length && !html) {
    const message = [
      ...headers,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: quoted-printable",
      "",
      encodeQuotedPrintable(plain),
    ].join("\r\n");
    return toBase64Url(message);
  }

  const altBoundary = `alt_${randomUUID()}`;
  const mixedBoundary = `mix_${randomUUID()}`;
  const alternativeParts = [
    `--${altBoundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: quoted-printable",
    "",
    encodeQuotedPrintable(plain),
  ];

  if (html) {
    alternativeParts.push(
      `--${altBoundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: quoted-printable",
      "",
      encodeQuotedPrintable(html),
    );
  }
  alternativeParts.push(`--${altBoundary}--`, "");

  if (!attachments.length) {
    const message = [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      "",
      ...alternativeParts,
    ].join("\r\n");
    return toBase64Url(message);
  }

  const attachmentParts = attachments.flatMap((attachment: any) => {
    const filename = escapeHeader(text(attachment.fileName || attachment.filename, "attachment.bin"));
    const mimeType = escapeHeader(text(attachment.mimeType, "application/octet-stream"));
    const raw = attachment.contentBase64 ? fromBase64(attachment.contentBase64).toString("base64") : "";
    return [
      `--${mixedBoundary}`,
      `Content-Type: ${mimeType}; name="${filename}"`,
      `Content-Disposition: attachment; filename="${filename}"`,
      "Content-Transfer-Encoding: base64",
      "",
      raw.replace(/(.{76})/g, "$1\r\n"),
      "",
    ];
  });

  const message = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
    "",
    `--${mixedBoundary}`,
    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    "",
    ...alternativeParts,
    ...attachmentParts,
    `--${mixedBoundary}--`,
    "",
  ].join("\r\n");

  return toBase64Url(message);
}

function parseJsonResponse(response: Response) {
  return response.text().then((textBody) => {
    try {
      return textBody ? JSON.parse(textBody) : {};
    } catch {
      return { raw: textBody };
    }
  });
}

async function googleFetch(url: string, init: RequestInit = {}) {
  const accessToken = await getGoogleAccessToken();
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${accessToken}`);
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const details = await parseJsonResponse(response);
    throw new Error(`google_api_error:${response.status}:${JSON.stringify(details)}`);
  }
  return response;
}

function decodeBase64UrlText(data = "") {
  if (!data) return "";
  try {
    return fromBase64(data).toString("utf8");
  } catch {
    return "";
  }
}

function headerValue(headers: any[] = [], name: string) {
  const hit = headers.find((header) => String(header?.name || "").toLowerCase() === name.toLowerCase());
  return text(hit?.value, "");
}

function collectPlainText(payload: any): string[] {
  if (!payload) return [];
  const mimeType = text(payload.mimeType, "");
  const bodyText = decodeBase64UrlText(text(payload?.body?.data, ""));
  const parts = Array.isArray(payload.parts) ? payload.parts.flatMap(collectPlainText) : [];
  if (mimeType.startsWith("text/plain") && bodyText.trim()) return [bodyText, ...parts];
  return parts;
}

export function gmailMessageSummary(message: any) {
  const payload = message?.payload || {};
  const headers = Array.isArray(payload.headers) ? payload.headers : [];
  const plainTextParts = collectPlainText(payload);
  const snippet = text(message?.snippet, "");
  const body = text(plainTextParts.join("\n\n").trim(), snippet);
  return {
    id: text(message?.id, ""),
    threadId: text(message?.threadId, ""),
    subject: headerValue(headers, "Subject"),
    from: headerValue(headers, "From"),
    to: headerValue(headers, "To"),
    cc: headerValue(headers, "Cc"),
    dateHeader: headerValue(headers, "Date"),
    internalDate: text(message?.internalDate, ""),
    labelIds: Array.isArray(message?.labelIds) ? message.labelIds : [],
    snippet,
    body,
  };
}

export async function listRecentGmailThreads(query: string, maxResults = 30) {
  const params = new URLSearchParams({
    q: query,
    maxResults: String(maxResults),
  });
  const response = await googleFetch(`${GMAIL_THREADS_URL}?${params.toString()}`);
  const payload = await response.json();
  return Array.isArray(payload.threads) ? payload.threads : [];
}

export async function getGmailThread(threadId: string) {
  const params = new URLSearchParams({ format: "full" });
  const response = await googleFetch(`${GMAIL_THREADS_URL}/${threadId}?${params.toString()}`);
  return response.json();
}

export function googleIntegrationStatus() {
  const clientId = env("GOOGLE_CLIENT_ID");
  const clientSecret = env("GOOGLE_CLIENT_SECRET");
  const refreshToken = env("GOOGLE_REFRESH_TOKEN");
  return {
    configured: Boolean(clientId && clientSecret && refreshToken),
    hasClientId: Boolean(clientId),
    hasClientSecret: Boolean(clientSecret),
    hasRefreshToken: Boolean(refreshToken),
    rootFolderId: env("GOOGLE_DRIVE_CUSTOMERS_FOLDER_ID"),
  };
}

function categoryCode(caseEntry: any) {
  const raw = String(caseEntry?.k ?? caseEntry?.kategori ?? "").trim();
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : null;
}

function resolveCustomerRootFolderId(caseEntry: any) {
  const activeRootId = env("GOOGLE_DRIVE_ACTIVE_FOLDER_ID");
  const pipelineRootId = env("GOOGLE_DRIVE_PIPELINE_FOLDER_ID");
  const archiveRootId = env("GOOGLE_DRIVE_ARCHIVE_FOLDER_ID");
  const fallbackRootId = env("GOOGLE_DRIVE_CUSTOMERS_FOLDER_ID");
  const code = categoryCode(caseEntry);

  if (code === 4 || code === 5) return pipelineRootId || fallbackRootId;
  if (code === 6 || code === 7) return archiveRootId || fallbackRootId;
  if (code === 1 || code === 2 || code === 3) return activeRootId || fallbackRootId;
  return fallbackRootId;
}

export async function getGoogleAccessToken() {
  const clientId = env("GOOGLE_CLIENT_ID");
  const clientSecret = env("GOOGLE_CLIENT_SECRET");
  const refreshToken = env("GOOGLE_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("google_not_configured");
  }

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    const details = await parseJsonResponse(response);
    throw new Error(`google_token_error:${response.status}:${JSON.stringify(details)}`);
  }

  const payload = await response.json();
  if (!payload.access_token) {
    throw new Error("google_token_missing");
  }

  return String(payload.access_token);
}

export async function createGmailDraft(body: any) {
  const raw = buildMimeMessage(body);
  const response = await googleFetch(GMAIL_DRAFTS_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: { raw } }),
  });
  return response.json();
}

async function listDriveFolderByName(parentId: string, name: string) {
  const query = [
    `mimeType='${GOOGLE_DRIVE_FOLDER_MIME}'`,
    `name='${String(name).replace(/'/g, "\\'")}'`,
    "trashed=false",
    `'${parentId}' in parents`,
  ].join(" and ");
  const params = new URLSearchParams({
    q: query,
    fields: "files(id,name,webViewLink)",
    pageSize: "1",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const response = await googleFetch(`${DRIVE_FILES_URL}?${params.toString()}`);
  const payload = await response.json();
  return Array.isArray(payload.files) && payload.files[0] ? payload.files[0] : null;
}

export async function ensureDriveFolder(name: string, parentId: string) {
  const existing = await listDriveFolderByName(parentId, name);
  if (existing) return existing;

  const response = await googleFetch(DRIVE_FILES_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      mimeType: GOOGLE_DRIVE_FOLDER_MIME,
      parents: [parentId],
    }),
  });
  return response.json();
}

export function extractDriveId(value = "") {
  const directId = String(value).match(/[-\w]{20,}/);
  if (!value.includes("http")) return directId ? directId[0] : String(value).trim();
  const folderMatch = String(value).match(/\/folders\/([-\w]{20,})/);
  if (folderMatch) return folderMatch[1];
  const idQuery = String(value).match(/[?&]id=([-\w]{20,})/);
  return idQuery ? idQuery[1] : directId?.[0] || "";
}

export async function ensureCaseDriveFolders(caseEntry: any, caseNumber: string, customerName: string) {
  const rootFolderId = extractDriveId(caseEntry?.docs?.drive || "") || resolveCustomerRootFolderId(caseEntry);
  if (!rootFolderId) {
    throw new Error("drive_root_missing");
  }

  const caseLabel = [text(caseNumber).trim(), text(customerName).trim()].filter(Boolean).join(" - ");
  const caseFolder = caseEntry?.docs?.drive
    ? { id: extractDriveId(caseEntry.docs.drive), webViewLink: caseEntry.docs.drive }
    : await ensureDriveFolder(caseLabel || customerName || "Kunde", rootFolderId);

  const map: Record<string, string> = {
    tilbud: "01 Tilbud",
    referater: "02 Referater",
    ks: "03 KS / Dokumentation",
    billeder: "04 Billeder",
    ekstraarbejde: "05 Ekstraarbejde",
    betaling: "06 Faktura / Betaling",
    kontrakter: "07 Kontrakt / Underskrifter",
    transkripter: "08 Transkripter",
    mails: "09 Mails",
  };

  const folders: Record<string, any> = {};
  for (const [key, folderName] of Object.entries(map)) {
    folders[key] = await ensureDriveFolder(folderName, caseFolder.id);
  }

  return {
    caseFolder,
    folders,
  };
}

export async function uploadDriveFile(parentId: string, document: any) {
  const fileName = text(document.fileName || document.filename || document.titel || document.title, "Dokument.txt");
  const mimeType = text(document.mimeType, document.contentText ? "text/plain" : "application/octet-stream");
  const metadata = {
    name: fileName,
    parents: [parentId],
    description: text(document.notes, ""),
  };

  let mediaBuffer: Buffer;
  if (document.contentBase64) {
    mediaBuffer = fromBase64(document.contentBase64);
  } else if (document.contentText) {
    mediaBuffer = Buffer.from(String(document.contentText), "utf8");
  } else {
    throw new Error("drive_document_content_missing");
  }

  const boundary = `drive_${randomUUID()}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    mediaBuffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const response = await googleFetch(`${DRIVE_UPLOAD_URL}?uploadType=multipart&supportsAllDrives=true`, {
    method: "POST",
    headers: { "content-type": `multipart/related; boundary=${boundary}` },
    body,
  });

  return response.json();
}
