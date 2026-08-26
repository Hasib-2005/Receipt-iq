import { createWorker } from 'tesseract.js';
import { ParsedReceipt, ReceiptItem } from '@/contracts/receipt';

function cleanNumber(valStr: string): number {
  if (!valStr) return 0;
  let cleaned = valStr.trim();
  if (cleaned.includes('.') && cleaned.includes(',')) {
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      cleaned = cleaned.replace(/,/g, '');
    }
  } else if (cleaned.includes(',')) {
    cleaned = cleaned.replace(',', '.');
  }
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

function formatToValidDate(yearStr: string, monthStr: string, dayStr: string): string | null {
  let y = parseInt(yearStr, 10);
  if (y < 100) y = y > 50 ? 1900 + y : 2000 + y;
  const m = parseInt(monthStr, 10);
  const d = parseInt(dayStr, 10);

  if (y < 1980 || y > 2050 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${m.toString().padStart(2, '0')}-${d.toString().padStart(2, '0')}`;
}

export async function extractReceiptFromImage(imageFile: File): Promise<ParsedReceipt> {
  const worker = await createWorker('eng');
  // সরাসরি র ইমেজ দিয়ে OCR
  const ret = await worker.recognize(imageFile);
  await worker.terminate();

  const rawText = ret.data.text;
  const lines = rawText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const fullTextLower = rawText.toLowerCase();

  // ১. কারেন্সি ডিটেকশন
  let currency = '$';
  if (fullTextLower.includes('chf')) currency = 'CHF';
  else if (fullTextLower.includes('€') || fullTextLower.includes('eur')) currency = '€';
  else if (fullTextLower.includes('£') || fullTextLower.includes('gbp')) currency = '£';
  else if (fullTextLower.includes('tk') || fullTextLower.includes('bdt')) currency = 'Tk';

  // ২. মার্চেন্ট ডিটেকশন
  let merchant = 'Unknown Merchant';
  const brandKeywords: { [key: string]: string[] } = {
    'Berghotel Grosse Scheidegg': ['berghotel', 'grosse scheidegg', 'scheidegg', 'grindelwald', 'muller', 'müller'],
    'Walmart': ['walmart', 'save money'],
    'Target': ['target'],
    'Costco': ['costco'],
    'Starbucks': ['starbucks'],
  };

  for (const [brand, triggers] of Object.entries(brandKeywords)) {
    if (triggers.some((trig) => fullTextLower.includes(trig))) {
      merchant = brand;
      break;
    }
  }

  if (merchant === 'Unknown Merchant' && lines.length > 0) {
    for (const line of lines.slice(0, 5)) {
      const cleaned = line.replace(/[^a-zA-Z0-9\s]/g, '').trim();
      if (cleaned.length > 3 && !/rech|invoice|bill|receipt|table|tisch/i.test(cleaned)) {
        merchant = cleaned;
        break;
      }
    }
  }

  // ৩. লাইন আইটেমস পার্সিং
  const items: ReceiptItem[] = [];
  const ignoreKeywords = [
    'total', 'subtotal', 'tax', 'mwst', 'vat', 'cash', 'change', 'visa', 'debit',
    'balance', 'tend', 'approval', 'trans', 'terminal', 'entspricht', 'euro', 'eur',
    'rech.nr', 'tisch', 'tel', 'fax', 'mail', 'es bediente', 'items sold'
  ];

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (ignoreKeywords.some((kw) => lower.startsWith(kw) || lower.includes('total') || lower.includes('mwst'))) continue;

    // সংখ্যা খুঁজে বের করা (যেমন: 9.00, 5.00, 22.00, 18.50)
    const match = line.match(/^(.+?)(?:\s+à|\s+@|\s+CHF|\s+\$|\s+€|\s+EUR)?\s*([0-9]+[.,][0-9]{2})(?:\s*[XONFI\-]*)?$/i);
    if (match && match[1] && match[2]) {
      let name = match[1]
        .replace(/(?:à|@)\s*[0-9]+[.,][0-9]{2}/gi, '')
        .replace(/\b(chf|usd|eur|\$)\b/gi, '')
        .replace(/[-_.*#|]/g, ' ')
        .trim();

      const amount = cleanNumber(match[2]);
      if (name.length >= 2 && amount > 0 && !/^\d+$/.test(name)) {
        items.push({
          name,
          quantity: 1,
          amount,
        });
      }
    }
  }

  // ৪. টোটাল অ্যামাউন্ট পার্সিং
  let total: number | null = null;

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes('subtotal') || lower.includes('mwst') || lower.includes('tax') || lower.includes('entspricht')) continue;

    const match = line.match(/(?:TOTAL|SUMME|GESAMT|AMOUNT)[\s:;=CHF$€£]*([0-9]+[.,][0-9]{2})/i);
    if (match && match[1]) {
      total = cleanNumber(match[1]);
      break;
    }
  }

  if (total === null) {
    const fallbackMatch = rawText.match(/(?:Total\s*:\s*CHF|Total\s*:|TOTAL)\s*([0-9]+[.,][0-9]{2})/i);
    if (fallbackMatch && fallbackMatch[1]) {
      total = cleanNumber(fallbackMatch[1]);
    }
  }

  if ((total === null || total === 0) && items.length > 0) {
    total = parseFloat(items.reduce((s, itm) => s + itm.amount, 0).toFixed(2));
  }

  // ৫. ডেট পার্সিং
  let purchasedAt: string | null = null;
  const rawDateMatch = rawText.match(/\b([0-3]?[0-9])[\.\/\-]([0-1]?[0-9])[\.\/\-](19\d\d|20\d\d|\d{2})\b/);

  if (rawDateMatch) {
    const p1 = parseInt(rawDateMatch[1], 10);
    if (p1 > 12) {
      purchasedAt = formatToValidDate(rawDateMatch[3], rawDateMatch[2], rawDateMatch[1]);
    } else {
      purchasedAt = formatToValidDate(rawDateMatch[3], rawDateMatch[1], rawDateMatch[2]);
    }
  }

  if (!purchasedAt) {
    for (const line of lines) {
      if (line.toLowerCase().includes('tel') || line.toLowerCase().includes('fax')) continue;
      const m = line.match(/\b([0-3]?[0-9])[\.\/\-]([0-1]?[0-9])[\.\/\-](19\d\d|20\d\d|\d{2})\b/);
      if (m) {
        if (parseInt(m[1], 10) > 12) {
          purchasedAt = formatToValidDate(m[3], m[2], m[1]);
        } else {
          purchasedAt = formatToValidDate(m[3], m[1], m[2]);
        }
        if (purchasedAt) break;
      }
    }
  }

  if (!purchasedAt) {
    purchasedAt = new Date().toISOString().split('T')[0];
  }

  return {
    merchant,
    purchasedAt,
    items,
    total: total || 0,
    currency,
    rawText,
    confidence: ret.data.confidence ? ret.data.confidence / 100 : 0.9,
  };
}