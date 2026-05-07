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

function primaryCaseNumber(entry: any) {
  const compact = textValue(entry?.sid || entry?.nr, "").replace(/\s+/g, "").trim();
  const match = compact.match(/^(\d+)/);
  return match ? match[1] : "";
}

function entryMarker(entry: any) {
  return plainCompactText(`${entry?.kunde || ""} ${entry?.adr || ""} ${entry?.opg || ""} ${entry?.sid || ""} ${entry?.nr || ""} ${entry?.fak || ""} ${entry?.docs?.drive || entry?.drive || ""}`);
}

export function resolveKnownCaseByText(entries: any[], text = "", signal: any = null) {
  const compact = plainCompactText(text);
  const all = Array.isArray(entries) ? entries : [];
  const find = (predicate: (entry: any, marker: string) => boolean) => all.find((entry) => predicate(entry, entryMarker(entry))) || null;
  const hasNvGadesvej10 = compact.includes("nv gadesvej") && /\b10\b/.test(compact);
  const hasNvGadesvej12 = compact.includes("nv gadesvej") && /\b12a?\b/.test(compact);

  if (hasNvGadesvej10) {
    return find((entry, marker) =>
      primaryCaseNumber(entry) === "1015" ||
      marker.includes("signe") ||
      marker.includes("tam") ||
      (marker.includes("nv gadesvej") && /\b10\b/.test(marker))
    );
  }

  if (hasNvGadesvej12) {
    return find((entry, marker) =>
      primaryCaseNumber(entry) === "1006" ||
      marker.includes("mathias") ||
      (marker.includes("nv gadesvej") && /\b12a?\b/.test(marker))
    );
  }

  if (compact.includes("bulowsvej 9")) return find((_entry, marker) => marker.includes("bulowsvej 9"));
  if (compact.includes("blagardsgade 14") || compact.includes("blaagardsgade 14")) {
    return find((_entry, marker) => marker.includes("blagardsgade 14") || marker.includes("blaagardsgade 14") || marker.includes("pladebutik"));
  }
  if (compact.includes("lundebjergvej")) return find((_entry, marker) => marker.includes("lundebjergvej") || marker.includes("core property"));
  if (signal?.category === "tilbud" && compact.includes("kingosvej 1b")) return find((_entry, marker) => marker.includes("kingosvej 1b"));
  return null;
}

export function sourceSignatureFromParts(threadId = "", messageIds: string[] = [], attachmentNames: string[] = [], fallback = "") {
  const source = [...messageIds, ...attachmentNames, fallback].filter(Boolean).join("|");
  return stableThreeDigitHash(source || threadId);
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
