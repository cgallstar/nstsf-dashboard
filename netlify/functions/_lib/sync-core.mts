export function textValue(value: unknown, fallback = "") {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

export function normalizeCaseKey(value: unknown) {
  return String(value || "").replace(/\s+/g, "").trim().toLowerCase();
}

export function stableThreeDigitHash(value = "") {
  let hash = 0;
  for (const char of String(value || "")) hash = ((hash * 31) + char.charCodeAt(0)) % 900;
  return String(100 + hash).padStart(3, "0").slice(-3);
}

export function stableHash(value = "") {
  let hash = 2166136261;
  for (const char of String(value || "")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function plainCompactText(value = "") {
  return String(value || "")
    .replace(/\bN\s*\.?\s*V\s*\.?\s*Gadesvej/gi, "NV Gadesvej")
    .replace(/\bN\s*\.?\s*W\s*\.?\s*Gadesvej/gi, "NV Gadesvej")
    .replace(/\bNW[\s_.-]*Gadesvej/gi, "NV Gadesvej")
    .replace(/\bN\s*V\s*Gadesvej/gi, "NV Gadesvej")
    .replace(/\blejlighed\b/gi, "lej")
    .replace(/\blejl?\./gi, "lej")
    .replace(/[æÆ]/g, "ae")
    .replace(/[øØ]/g, "o")
    .replace(/[åÅ]/g, "a")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase();
}

export function sourceSignatureFromParts(threadId = "", messageIds: string[] = [], attachmentNames: string[] = [], fallback = "") {
  const source = [...messageIds, ...attachmentNames, fallback].filter(Boolean).join("|");
  return stableHash(source || threadId).slice(0, 12);
}

export function buildArchiveKeyFromParts(input: {
  threadId: string;
  messageIds?: string[];
  attachmentNames?: string[];
  category: string;
  documentType: string;
  documentDate: string;
  displayCaseId: string;
  fallback?: string;
}) {
  return [
    "gmail",
    textValue(input.threadId, ""),
    sourceSignatureFromParts(input.threadId, input.messageIds || [], input.attachmentNames || [], input.fallback || ""),
    normalizeCaseKey(input.category),
    normalizeCaseKey(input.documentType),
    normalizeCaseKey(input.documentDate),
    normalizeCaseKey(input.displayCaseId),
  ].filter(Boolean).join(":");
}

export function parseMoneyValue(value = "") {
  const normalized = String(value || "").replace(/\./g, "").replace(/\s/g, "").replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

function invoiceLikeMoneyValues(text = "") {
  const source = String(text || "");
  return [...source.matchAll(/(\d{1,3}(?:[.\s]\d{3})*(?:,\d{2})?|\d{4,})(?:\s*kr\.?)?/gi)]
    .map((match) => parseMoneyValue(match[1]))
    .filter((value) => value >= 1000);
}

function vatInclusiveFromMoneyValues(values: number[], fallbackToLargest = false) {
  const unique = [...new Set(values)].filter((value) => value >= 1000).sort((a, b) => b - a);
  if (!unique.length) return 0;
  for (const subtotal of unique) {
    const vat = unique.find((value) => value < subtotal && value / subtotal >= 0.249 && value / subtotal <= 0.251);
    if (!vat) continue;
    const calculatedTotal = Math.round(subtotal + vat);
    const existingTotal = unique.find((value) => Math.abs(value - calculatedTotal) <= 2);
    return existingTotal || calculatedTotal;
  }
  return fallbackToLargest ? unique[0] : 0;
}

export function extractInvoiceAmount(text = "") {
  const source = String(text || "");
  const totalValues: number[] = [];
  const totalPattern = /(?:total(?:\s+inkl\.?\s+moms)?|i alt(?:\s+inkl\.?\s+moms)?|beløb\s+inkl\.?\s+moms|beloeb\s+inkl\.?\s+moms|saldo|at betale)[^\d]{0,80}(\d{1,3}(?:[.\s]\d{3})*(?:,\d{2})?|\d{4,})(?:\s*kr\.?)?/gi;
  let match: RegExpExecArray | null;
  while ((match = totalPattern.exec(source))) {
    const value = parseMoneyValue(match[1]);
    if (value >= 1000) totalValues.push(value);
  }
  const totalBlockPattern = /(?:total\s+dkk|total|i alt(?:\s+inkl\.?\s+moms)?|beløb\s+inkl\.?\s+moms|beloeb\s+inkl\.?\s+moms|at betale)[\s\S]{0,180}/gi;
  while ((match = totalBlockPattern.exec(source))) {
    const values = [...match[0].matchAll(/(\d{1,3}(?:[.\s]\d{3})*(?:,\d{2})?|\d{4,})/g)]
      .map((candidate) => parseMoneyValue(candidate[1]))
      .filter((value) => value >= 1000);
    if (values.length) totalValues.push(Math.max(...values));
  }
  const krValues: number[] = [];
  const krPattern = /(\d{1,3}(?:[.\s]\d{3})*(?:,\d{2})?|\d{4,})\s*kr\.?/gi;
  while ((match = krPattern.exec(source))) {
    const value = parseMoneyValue(match[1]);
    if (value >= 1000) krValues.push(value);
  }
  const vatInclusive = vatInclusiveFromMoneyValues(invoiceLikeMoneyValues(source), false);
  if (vatInclusive) totalValues.push(vatInclusive);
  if (totalValues.length) return Math.max(...totalValues);
  if (!krValues.length) return 0;
  return vatInclusiveFromMoneyValues(krValues, true);
}
