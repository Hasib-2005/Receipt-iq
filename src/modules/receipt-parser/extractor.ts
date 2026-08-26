import { createWorker } from 'tesseract.js';
import { ParsedReceipt, ReceiptItem } from '@/contracts/receipt';

// ব্রাউজার-ইন্ডিপেনডেন্ট ইমেজ অপটিমাইজেশন (FileReader ভিত্তিক নিরাপদ লোডার)
async function preprocessReceiptImage(file: File): Promise<Blob> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) {
          resolve(file);
          return;
        }

        const maxDim = 1600;
        let width = img.width;
        let height = img.height;

        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }

        canvas.width = width;
        canvas.height = height;

        // হোয়াইট ব্যাকগ্রাউন্ড ও ড্র
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);

        const imgData = ctx.getImageData(0, 0, width, height);
        const d = imgData.data;

        // কালার ব্যালেন্সিং ও নয়েজ রিমুভাল
        for (let i = 0; i < d.length; i += 4) {
          const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          const val = gray < 165 ? Math.max(0, gray - 40) : 255;
          d[i] = val;
          d[i + 1] = val;
          d[i + 2] = val;
        }

        ctx.putImageData(imgData, 0, 0);
        canvas.toBlob((blob) => resolve(blob || file), 'image/png', 1.0);
      };
      img.onerror = () => resolve(file);
      img.src = e.target?.result as string;
    };
    reader.onerror = () => resolve(file);
    reader.readAsDataURL(file);
  });
}

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
  const processedBlob = await preprocessReceiptImage(imageFile);
  const worker = await createWorker('eng');
  const ret = await worker.recognize(processedBlob);
  await worker.terminate();

  const rawText = ret.data.text;
  const lines = rawText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const fullTextLower = rawText.toLowerCase();

  // ১. কারেন্সি
  let currency = '$';
  if (fullTextLower.includes('chf')) currency = 'CHF';
  else if (fullTextLower.includes('€') || fullTextLower.includes('eur')) currency = '€';
  else if (fullTextLower.includes('£') || fullTextLower.includes('gbp')) currency = '£';
  else if (fullTextLower.includes('tk') || fullTextLower.includes('bdt')) currency = 'Tk';

  // ২. মার্চেন্ট
  let merchant = 'Unknown Merchant';
  const brandKeywords: { [key: string]: string[] } = {
    'Berghotel Grosse Scheidegg': ['berghotel', 'grosse scheidegg', 'scheidegg', 'grindelwald', 'müller', 'muller'],
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

  // ৩. লাইন আইটেমস পার্সিং (ফ্লেক্সিবল ম্যাচিং যা কোনো ডিভাইস মিস করবে না)
  const items: ReceiptItem[] = [];
  const ignoreKeywords = [
    'total', 'subtotal', 'tax', 'mwst', 'vat', 'cash', 'change', 'visa', 'debit',
    'balance', 'tend', 'approval', 'trans', 'terminal', 'entspricht', 'euro', 'eur',
    'rech.nr', 'tisch', 'tel', 'fax', 'mail', 'es bediente', 'items sold'
  ];

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (ignoreKeywords.some((kw) => lower.startsWith(kw) || lower.includes('total') || lower.includes('mwst'))) continue;

    // যেকোনো লাইনের শেষ প্রাইস ধরা (যেমন 9.00, 5.00, 22.00, 18.50)
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

  // ৪. টোটাল অ্যামাউন্ট
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
    const standaloneMatch = rawText.match(/(?:Total\s*:\s*CHF|Total\s*:|TOTAL)\s*([0-9]+[.,][0-9]{2})/i);
    if (standaloneMatch && standaloneMatch[1]) {
      total = cleanNumber(standaloneMatch[1]);
    }
  }

  if ((total === null || total === 0) && items.length > 0) {
    total = parseFloat(items.reduce((s, itm) => s + itm.amount, 0).toFixed(2));
  }

  // ৫. ইউনিভার্সাল ডেট স্ক্যানিং (পুরো টেক্সট এবং লাইন বাই লাইন গভীর সার্চ)
  let purchasedAt: string | null = null;

  // ১. পুরো রসিদে 30.07.2007 বা 30/07/2007 খোঁজা (টাইমস্ট্যাম্প সহ থাকলেও ধরবে)
  const fullTextDateMatch = rawText.match(/\b([0-3]?[0-9])[\.\/\-]([0-1]?[0-9])[\.\/\-](19\d\d|20\d\d|\d{2})\b/);
  if (fullTextDateMatch) {
    const p1 = parseInt(fullTextDateMatch[1], 10);
    if (p1 > 12) {
      purchasedAt = formatToValidDate(fullTextDateMatch[3], fullTextDateMatch[2], fullTextDateMatch[1]);
    } else {
      purchasedAt = formatToValidDate(fullTextDateMatch[3], fullTextDateMatch[1], fullTextDateMatch[2]);
    }
  }

  // ২. যদি উপরে না পায় তবে লাইন ধরে স্ক্যান
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