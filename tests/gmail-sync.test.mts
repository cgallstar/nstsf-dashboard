import assert from "node:assert/strict";
import {
  buildArchiveKeyFromParts,
  extractInvoiceAmount,
  resolveKnownCaseByText,
} from "../netlify/functions/_lib/sync-core.mts";

function cases() {
  return [
    {
      k: 2,
      sid: "1006a",
      nr: "1006",
      kunde: "Mathias & Anna",
      adr: "N. V. Gadesvej 12A, 1. sal",
      opg: "Fuld renovering.",
      docs: {},
    },
    {
      k: 4,
      sid: "1015a",
      nr: "1015",
      kunde: "Signe & Tam",
      adr: "N. V. Gadesvej 10, 1. sal",
      opg: "Istandsættelse af 1. sal",
      docs: {},
    },
  ];
}

assert.equal(
  resolveKnownCaseByText(
    cases(),
    "Svar på spørgsmål vedr. tilbud – NV Gadesvej 10\nN. V. Gadesvej 10, 1. sal\nBudget 5-600K",
    { category: "tilbud" },
  )?.nr,
  "1015",
);

assert.equal(
  resolveKnownCaseByText(
    cases(),
    "Tilbud på facaderenovering N W gadesvej 12\nN. V. Gadesvej 12A, 1. sal",
    { category: "tilbud" },
  )?.nr,
  "1006",
);

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

assert.equal(
  resolveKnownCaseByText(
    cases(),
    "Svar på spørgsmål vedr. tilbud – NV Gadesvej 10",
    { category: "tilbud" },
  )?.nr,
  "1015",
);

assert.equal(
  resolveKnownCaseByText(
    cases(),
    "Tilbud på facaderenovering N W gadesvej 12",
    { category: "tilbud" },
  )?.nr,
  "1006",
);

console.log("gmail-sync core tests passed");
