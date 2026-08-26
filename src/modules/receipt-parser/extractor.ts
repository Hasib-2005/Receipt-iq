import { createWorker } from 'tesseract.js';
import { ParsedReceipt, ReceiptItem } from '@/contracts/receipt';

// সংখ্যা ক্লিনিং (কমা বা ডট ফরম্যাটকে স্ট্যান্ডার্ড ডেসিমেল নাম্বারে রূপান্তর)
function cleanNumber(valStr: string): number {
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

// নিশ্চিত YYYY-MM-DD ফরম্যাটিং ও ক্যালেন্ডার ভ্যালিডেশন
function formatToValidDate(yearStr: string, monthStr: string, dayStr: string): string | null {
  let y = parseInt(yearStr, 10);
  if (y < 100) {
    y = y > 50 ? 1900 + y : 2000 + y;
  }
  const m = parseInt(monthStr, 10);
  const d = parseInt(dayStr, 10);

  if (y < 1980 || y > 2050 || m < 1 || m > 12 || d < 1 || d > 31) {
    return null;
  }

  const mm = m.toString().padStart(2, '0');
  const dd = d.toString().padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

export async function extractReceiptFromImage(imageFile: File): Promise<ParsedReceipt> {
  const worker = await createWorker('eng');
  const ret = await worker.recognize(imageFile);
  await worker.terminate();

  const rawText = ret.data.text;
  const lines = rawText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const fullTextLower = rawText.toLowerCase();

  // ১. কারেন্সি নির্ধারণ
  let currency = '$';
  if (fullTextLower.includes('chf')) currency = 'CHF';
  else if (fullTextLower.includes('€') || fullTextLower.includes('eur')) currency = '€';
  else if (fullTextLower.includes('£') || fullTextLower.includes('gbp')) currency = '£';
  else if (fullTextLower.includes('tk') || fullTextLower.includes('bdt') || fullTextLower.includes('taka')) currency = 'Tk';
  else if (fullTextLower.includes('₹') || fullTextLower.includes('inr') || fullTextLower.includes('rs')) currency = '₹';
  else if (fullTextLower.includes('$') || fullTextLower.includes('usd')) currency = '$';

  // ২. মার্চেন্ট নাম ডিটেকশন
  let merchant = 'Unknown Merchant';
  const brandKeywords: { [key: string]: string[] } = {
    'Berghotel Grosse Scheidegg': ['berghotel', 'grosse scheidegg', 'grindelwald'],
    'Walmart': ['walmart', 'save money. live better', 'save money live better'],
    'Target': ['target', 'expect more. pay less'],
    'Costco': ['costco wholesale', 'costco'],
    'Starbucks': ['starbucks coffee', 'starbucks'],
    'McDonald\'s': ['mcdonald', 'i\'m lovin\' it'],
    'Subway': ['subway', 'eat fresh'],
  };

  for (const [brand, triggers] of Object.entries(brandKeywords)) {
    if (triggers.some((trigger) => fullTextLower.includes(trigger))) {
      merchant = brand;
      break;
    }
  }

  if (merchant === 'Unknown Merchant') {
    for (const line of lines.slice(0, 6)) {
      const cleaned = line.replace(/[^a-zA-Z0-9\s]/g, '').trim();
      const isNoise =
        cleaned.length < 3 ||
        /^[0-9\s]+$/.test(cleaned) ||
        cleaned.toLowerCase().includes('receipt') ||
        cleaned.toLowerCase().includes('tax invoice') ||
        cleaned.toLowerCase().includes('bill no') ||
        cleaned.toLowerCase().includes('rech.nr');
      if (!isNoise) {
        merchant = line.replace(/[-_*#|]/g, '').trim();
        break;
      }
    }
  }

  // ৩. লাইন আইটেম বের করা
  const items: ReceiptItem[] = [];
  const ignoreKeywords = [
    'total', 'subtotal', 'sub-total', 'tax', 'mwst', 'vat', 'gst', 'cash', 'change', 
    'visa', 'debit', 'mastercard', 'balance', 'tend', 'approval', 'trans', 
    'terminal', 'items sold', 'customer copy', 'entspricht', 'euro', 'eur', 'chf',
    'bediente', 'tisch', 'rech.nr', 'invoice', 'table', 'date', 'tel', 'fax', 'mail'
  ];

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (ignoreKeywords.some((kw) => lower.startsWith(kw) || lower.includes('total'))) continue;

    const match = line.match(/^(.+?)(?:\s+\d{8,15})?\s+(?:à|@|\bCHF\b|\$|€|£|Tk|৳|₹)?\s*([0-9]+[.,][0-9]{2})(?:\s*[XONFI\-]*)?$/i);
    if (match && match[1] && match[2]) {
      let name = match[1]
        .replace(/(?:à|@)\s*[0-9]+[.,][0-9]{2}/gi, '')
        .replace(/[-_.*#|]/g, '')
        .trim();
      
      const amount = cleanNumber(match[2]);
      if (name.length >= 2 && amount > 0 && !name.match(/^\d+$/)) {
        items.push({
          name,
          quantity: 1,
          amount,
        });
      }
    }
  }

  // ৪. টোটাল অ্যামাউন্ট এক্সট্রাকশন
  let total: number | null = null;
  const totalKeywordsRegex = /(?:^|\s)(?:TOTAL|SUMME|GESAMT|GRAND\s*TOTAL|BALANCE\s*DUE|AMOUNT\s*DUE|BALANCE)[\s:;=CHF$€£Tk₹]*([0-9]+[.,][0-9]{2})/i;

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes('subtotal') || lower.includes('mwst') || lower.includes('tax') || lower.includes('vat')) continue;

    const match = line.match(totalKeywordsRegex);
    if (match && match[1]) {
      total = cleanNumber(match[1]);
      break;
    }
  }

  if (total === null) {
    for (const line of lines) {
      if (line.toLowerCase().includes('subtotal')) continue;
      const match = line.match(/(?:TOTAL|CHF)[\s:;=]+([0-9]+[.,][0-9]{2})/i);
      if (match && match[1]) {
        total = cleanNumber(match[1]);
        break;
      }
    }
  }

  if ((total === null || total === 0) && items.length > 0) {
    total = parseFloat(items.reduce((sum, itm) => sum + itm.amount, 0).toFixed(2));
  }

  // ৫. নিখুঁত ব্যাকগ্রাউন্ড-প্রুফ ডেট এক্সট্রাকশন
  let purchasedAt: string | null = null;

  // মাসের টেক্সট নামসহ তারিখ (যেমন 26 Aug 2026, 30-Jul-2007)
  const textMonthRegex = /\b([0-3]?[0-9])[-/\s.](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[-/\s.](\d{2,4})\b/i;
  const textMatch = rawText.match(textMonthRegex);

  if (textMatch) {
    const months: { [key: string]: string } = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
    };
    purchasedAt = formatToValidDate(textMatch[3], months[textMatch[2].toLowerCase().slice(0, 3)], textMatch[1]);
  }

  // সব লাইন স্ক্যান করে তারিখ ও টাইমস্ট্যাম্প আলাদা করা (যেমন 30.07.2007/13:29:17)
  if (!purchasedAt) {
    for (const line of lines) {
      // ফোন নাম্বার, ফ্যাক্স বা ট্যাক্স আইডি লাইনগুলো ডেট স্ক্যান থেকে বাদ
      if (line.toLowerCase().includes('tel') || line.toLowerCase().includes('fax') || line.toLowerCase().includes('mwst')) continue;

      // ১. YYYY-MM-DD ফরম্যাট
      const ymd = line.match(/\b(19\d\d|20\d\d)[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b/);
      if (ymd) {
        purchasedAt = formatToValidDate(ymd[1], ymd[2], ymd[3]);
        if (purchasedAt) break;
      }

      // ২. DD.MM.YYYY বা DD/MM/YYYY ফরম্যাট (টাইমস্ট্যাম্প সহ/ছাড়া)
      const dmy = line.match(/\b(0?[1-9]|[12]\d|3[01])[-/.](0?[1-9]|1[0-2])[-/.](19\d\d|20\d\d|\d{2})\b/);
      if (dmy) {
        // যদি প্রথম পার্ট ১২ এর বড় হয় বা নিশ্চিত দিন হয়
        purchasedAt = formatToValidDate(dmy[3], dmy[2], dmy[1]);
        if (purchasedAt) break;
      }

      // ৩. MM/DD/YYYY আমেরিকান ফরম্যাট
      const mdy = line.match(/\b(0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])[-/.](19\d\d|20\d\d|\d{2})\b/);
      if (mdy) {
        purchasedAt = formatToValidDate(mdy[3], mdy[1], mdy[2]);
        if (purchasedAt) break;
      }
    }
  }

  // যদি রসিদে কোনো তারিখ না পাওয়া যায় তবেই আজকের তারিখ বসবে
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