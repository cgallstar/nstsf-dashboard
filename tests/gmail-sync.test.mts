import assert from "node:assert/strict";
import {
  buildArchiveKeyFromParts,
  extractInvoiceAmount,
} from "../netlify/functions/_lib/sync-core.mts";

assert.equal(
  extractInvoiceAmount("Subtotal 89.932,00 kr.\nMoms 22.483,00 kr.\nTotal inkl. moms 112.415,00 kr."),
  112415,
);

assert.equal(
  extractInvoiceAmount("Beløb ekskl. moms 30.468,00 kr.\nMoms 7.617,00 kr.\nI alt inkl. moms 38.085,00 kr."),
  38085,
);

const archiveKey = buildArchiveKeyFromParts({
  threadId: "thread-1",
  messageIds: ["msg-1"],
  attachmentNames: ["referat.pdf"],
  category: "referater",
  documentType: "Byggemodereferat",
  documentDate: "2026-04-21",
  displayCaseId: "1006 A",
  fallback: "Byggemødereferat",
});
assert.equal(
  archiveKey,
  buildArchiveKeyFromParts({
    threadId: "thread-1",
    messageIds: ["msg-1"],
    attachmentNames: ["referat.pdf"],
    category: "referater",
    documentType: "Byggemodereferat",
    documentDate: "2026-04-21",
    displayCaseId: "1006 A",
    fallback: "Byggemødereferat",
  }),
);
assert.notEqual(
  archiveKey,
  buildArchiveKeyFromParts({
    threadId: "thread-1",
    messageIds: ["msg-2"],
    attachmentNames: ["referat.pdf"],
    category: "referater",
    documentType: "Byggemodereferat",
    documentDate: "2026-04-21",
    displayCaseId: "1006 A",
    fallback: "Byggemødereferat",
  }),
);

console.log("gmail-sync core tests passed");
