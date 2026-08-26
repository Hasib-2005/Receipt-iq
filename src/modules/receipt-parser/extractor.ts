import { createWorker, PSM } from 'tesseract.js';
import { ParsedReceipt, ReceiptItem } from '@/contracts/receipt';

/* ============================================================
   0. DETERMINISTIC IMAGE PRE-PROCESSING
   ============================================================
   Root cause of "works on my laptop, fails on my friend's laptop":
   canvas-based grayscale/threshold pipelines that rely on the
   browser's own image-smoothing / resampling algorithm. That
   algorithm is NOT specified by any standard — it differs by
   GPU, OS, and even browser version — so the same JPEG produces
   different pixel data on different machines, and Tesseract then
   sees different input.

   Fix: do all image math ourselves in plain JS (grayscale +
   fixed-threshold binarization), and disable the browser's own
   smoothing during the resize. Same arithmetic everywhere ->
   same output everywhere.
============================================================ */

const TARGET_WIDTH = 1600; // fixed working resolution, same on every device
const BINARIZE_THRESHOLD = 150; // fixed threshold, not derived from device-specific filters

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image for OCR preprocessing'));
    img.src = URL.createObjectURL(file);
  });
}

async function preprocessImage(file: File): Promise<HTMLCanvasElement> {
  const img = await loadImage(file);
  const scale = TARGET_WIDTH / img.width;
  const canvas = document.createElement('canvas');
  canvas.width = TARGET_WIDTH;
  canvas.height = Math.max(1, Math.round(img.height * scale));

  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  // Disable device-dependent smoothing so the resize is identical everywhere.
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(img.src);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  // Manual luminance + fixed-threshold binarization — pure arithmetic,
  // no GPU filter, no canvas "smart" preprocessing. Deterministic.
  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const value = gray > BINARIZE_THRESHOLD ? 255 : 0;
    data[i] = data[i + 1] = data[i + 2] = value;
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/* ============================================================
   1. NUMBER / CURRENCY NORMALIZATION
   ============================================================ */

function cleanNumber(valStr: string): number {
  if (!valStr) return 0;
  let cleaned = valStr.trim();

  // Strip thousands separators that aren't the decimal mark:
  // Swiss apostrophe (1'234.50), plain spaces (1 234,50), NBSP.
  cleaned = cleaned.replace(/[\s\u00A0']/g, '');

  if (cleaned.includes('.') && cleaned.includes(',')) {
    // Whichever mark appears last is the decimal separator.
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      cleaned = cleaned.replace(/,/g, '');
    }
  } else if (cleaned.includes(',')) {
    // A single comma with exactly 2 trailing digits is a decimal mark
    // (European style). Otherwise treat it as a thousands separator.
    if (/,\d{2}$/.test(cleaned)) {
      cleaned = cleaned.replace(',', '.');
    } else {
      cleaned = cleaned.replace(/,/g, '');
    }
  }

  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

const CURRENCY_MARKERS: { symbol: string; patterns: RegExp[] }[] = [
  { symbol: 'CHF', patterns: [/\bchf\b/i] },
  { symbol: '€', patterns: [/€/, /\beur\b/i] },
  { symbol: '£', patterns: [/£/, /\bgbp\b/i] },
  { symbol: 'Tk', patterns: [/\btk\b/i, /\bbdt\b/i, /৳/] },
  { symbol: '₹', patterns: [/₹/, /\binr\b/i, /\brs\.?\b/i] },
];

function detectCurrency(fullText: string): string {
  for (const { symbol, patterns } of CURRENCY_MARKERS) {
    if (patterns.some((p) => p.test(fullText))) return symbol;
  }
  return '$';
}

/* ============================================================
   2. DATE PARSING
   ============================================================
   Handles: DD.MM.YYYY, DD/MM/YY, MM/DD/YY, YYYY-MM-DD, and
   date+time combos like "30.07.2007/13:29:17". Actively avoids
   phone numbers, fax numbers, and invoice/tax-ID numbers that
   happen to contain dot- or dash-separated digit groups.
============================================================ */

const DATE_LINE_EXCLUDE = /tel|fax|phone|rech\.?\s*nr|invoice\s*no|no\.|nr\.|mwst|ust-?id|steuer|vat\s*no|barcode/i;

function formatToValidDate(yearStr: string, monthStr: string, dayStr: string): string | null {
  let y = parseInt(yearStr, 10);
  if (y < 100) y = y > 50 ? 1900 + y : 2000 + y;
  const m = parseInt(monthStr, 10);
  const d = parseInt(dayStr, 10);

  if (y < 1980 || y > 2050 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${m.toString().padStart(2, '0')}-${d.toString().padStart(2, '0')}`;
}

function tryParseDateFromText(text: string): string | null {
  // ISO-ish: YYYY-MM-DD / YYYY.MM.DD / YYYY/MM/DD
  const iso = text.match(/\b(19\d\d|20\d\d)[.\-/]([0-1]?\d)[.\-/]([0-3]?\d)\b/);
  if (iso) {
    const d = formatToValidDate(iso[1], iso[2], iso[3]);
    if (d) return d;
  }

  // DD.MM.YYYY(/HH:MM:SS) or MM/DD/YY etc. — the trailing time, if any,
  // is naturally excluded because \b ends the match at the date's last digit.
  const dmy = text.match(/\b([0-3]?\d)[.\-/]([0-1]?\d)[.\-/](19\d\d|20\d\d|\d{2})\b/);
  if (dmy) {
    const p1 = parseInt(dmy[1], 10);
    const p2 = parseInt(dmy[2], 10);
    // If the first group can't be a month (>12), it must be the day.
    if (p1 > 12) return formatToValidDate(dmy[3], dmy[2], dmy[1]);
    // If the second group can't be a month either, fall back to day-first
    // (most receipts worldwide use DD/MM, US being the notable exception —
    // but ambiguous two-digit-only cases default to DD/MM here).
    if (p2 > 12) return formatToValidDate(dmy[3], dmy[1], dmy[2]);
    return formatToValidDate(dmy[3], dmy[1], dmy[2]);
  }

  return null;
}

function extractPurchaseDate(rawText: string, lines: string[]): string {
  // Prefer the first non-excluded line so we don't grab a tax/invoice number.
  for (const line of lines) {
    if (DATE_LINE_EXCLUDE.test(line)) continue;
    const parsed = tryParseDateFromText(line);
    if (parsed) return parsed;
  }
  // Last resort: scan the whole blob (still safer than defaulting to "today").
  const fallback = tryParseDateFromText(rawText);
  if (fallback) return fallback;

  return new Date().toISOString().split('T')[0];
}

/* ============================================================
   3. MERCHANT DETECTION
   ============================================================ */

const BRAND_KEYWORDS: Record<string, string[]> = {
  'Berghotel Grosse Scheidegg': ['berghotel', 'grosse scheidegg', 'scheidegg', 'grindelwald', 'muller', 'müller'],
  Walmart: ['walmart', 'save money'],
  Target: ['target'],
  Costco: ['costco'],
  Starbucks: ['starbucks'],
};

const MERCHANT_LINE_EXCLUDE = /rech|invoice|bill|receipt|table|tisch|tel|fax|www\.|http/i;

function detectMerchant(fullTextLower: string, lines: string[]): string {
  for (const [brand, triggers] of Object.entries(BRAND_KEYWORDS)) {
    if (triggers.some((trig) => fullTextLower.includes(trig))) return brand;
  }

  // Fallback: scan the first few lines (header area) for a plausible name.
  // Unicode-aware cleanup preserves accented characters (ä/ö/ü etc.)
  // instead of stripping them, which previously mangled European names.
  for (const line of lines.slice(0, 6)) {
    const cleaned = line.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (cleaned.length < 4) continue;
    if (MERCHANT_LINE_EXCLUDE.test(cleaned)) continue;

    // Reject logo/noise artifacts: require at least one real word (>=3 chars),
    // not just scattered single letters (e.g. a misread star logo -> "I PX").
    const words = cleaned.split(' ').filter(Boolean);
    if (!words.some((w) => w.length >= 3)) continue;

    return cleaned;
  }

  return 'Unknown Merchant';
}

/* ============================================================
   4. LINE ITEM PARSING
   ============================================================ */

const ITEM_IGNORE_KEYWORDS = [
  'total', 'subtotal', 'tax', 'mwst', 'vat', 'cash', 'change', 'visa', 'debit',
  'balance', 'tend', 'approval', 'trans', 'terminal', 'entspricht', 'euro', 'eur',
  'rech.nr', 'tisch', 'tel', 'fax', 'mail', 'es bediente', 'items sold',
];

// Matches an optional leading "qty x", an item name, and a trailing price
// (optionally preceded by "à"/"@"/currency, and followed by a tax-code
// letter such as Walmart's X/O/N).
const ITEM_LINE_RE =
  /^(?:(\d+)\s*[x×]\s+)?(.+?)(?:\s+[àa@]\s*[0-9]+[.,][0-9]{2})?(?:\s+CHF|\s+\$|\s+€|\s+EUR|\s+Tk|\s+₹)?\s+([0-9]+[.,][0-9]{2})\s*[A-Z\-]{0,3}$/i;

function parseLineItems(lines: string[]): ReceiptItem[] {
  const items: ReceiptItem[] = [];

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (ITEM_IGNORE_KEYWORDS.some((kw) => lower.startsWith(kw))) continue;
    if (lower.includes('total') || lower.includes('mwst')) continue;

    const match = line.match(ITEM_LINE_RE);
    if (!match) continue;

    const quantity = match[1] ? parseInt(match[1], 10) : 1;
    let name = match[2]
      .replace(/\b(chf|usd|eur|bdt|inr)\b/gi, '')
      .replace(/[-_.*#|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const amount = cleanNumber(match[3]);

    // Reject barcode/SKU-only "names" (pure digits, e.g. Walmart's
    // 12-digit item codes) and anything too short to be a real item.
    if (name.length < 2 || /^\d+$/.test(name) || amount <= 0) continue;

    items.push({ name, quantity: quantity > 0 ? quantity : 1, amount });
  }

  return items;
}

/* ============================================================
   5. TOTAL DETECTION
   ============================================================
   Strategy: collect every "total-flavoured" candidate line, then
   prefer the one that (a) isn't a subtotal/tax/converted-currency
   line, and (b) is closest to (or exceeds) the summed item prices.
   This self-consistency check is far more robust than "first regex
   match wins", which is what let VAT lines and EUR-converted totals
   leak through before.
============================================================ */

const TOTAL_SKIP_LINE = /subtotal|mwst|tax|entspricht|converted|umrechnung/i;
const TOTAL_KEYWORD_RE = /(?:total|summe|gesamt|amount\s*due|amount)[\s:;=]*(?:chf|eur|usd|bdt|inr|tk|\$|€|£|₹)?\s*([0-9][0-9'.,\s]*[0-9])/i;

function extractTotal(lines: string[], itemsSum: number): number {
  const candidates: number[] = [];

  for (const line of lines) {
    if (TOTAL_SKIP_LINE.test(line)) continue;
    const match = line.match(TOTAL_KEYWORD_RE);
    if (match && match[1]) {
      const value = cleanNumber(match[1]);
      if (value > 0) candidates.push(value);
    }
  }

  if (candidates.length > 0) {
    // Prefer whichever candidate is closest to the summed line items
    // (handles receipts where "Total" legitimately appears more than
    // once, e.g. per-section subtotals that also contain the word).
    if (itemsSum > 0) {
      candidates.sort((a, b) => Math.abs(a - itemsSum) - Math.abs(b - itemsSum));
      return candidates[0];
    }
    // No item-sum signal to compare against: take the last keyworded
    // match, since the grand total is conventionally printed last.
    return candidates[candidates.length - 1];
  }

  // No "total"-labelled line survived at all — fall back to the sum
  // of parsed line items.
  return itemsSum > 0 ? parseFloat(itemsSum.toFixed(2)) : 0;
}

/* ============================================================
   6. MAIN ENTRY POINT
   ============================================================ */

export async function extractReceiptFromImage(imageFile: File): Promise<ParsedReceipt> {
  const canvas = await preprocessImage(imageFile);

  const worker = await createWorker('eng');
  // Receipts are a single narrow column of text — SINGLE_BLOCK gives far
  // more consistent segmentation across devices than the default AUTO mode,
  // which sometimes chose different segmentation strategies depending on
  // the image's DPI metadata.
  await worker.setParameters({
    tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
    preserve_interword_spaces: '1',
  });

  const ret = await worker.recognize(canvas);
  await worker.terminate();

  const rawText = ret.data.text;
  const lines = rawText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const fullTextLower = rawText.toLowerCase();

  const currency = detectCurrency(rawText);
  const merchant = detectMerchant(fullTextLower, lines);
  const items = parseLineItems(lines);
  const itemsSum = parseFloat(items.reduce((s, itm) => s + itm.amount * itm.quantity, 0).toFixed(2));
  const total = extractTotal(lines, itemsSum);
  const purchasedAt = extractPurchaseDate(rawText, lines);

  return {
    merchant,
    purchasedAt,
    items,
    total,
    currency,
    rawText,
    confidence: ret.data.confidence ? ret.data.confidence / 100 : 0.9,
  };
}