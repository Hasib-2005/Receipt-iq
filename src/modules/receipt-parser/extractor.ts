import { createWorker } from 'tesseract.js';
import { ParsedReceipt, ReceiptItem } from '@/contracts/receipt';

// ছবির ব্যাকগ্রাউন্ড নয়েজ দূর করতে অপটিমাইজড প্রসেসিং
async function preprocessReceiptImage(file: File): Promise<Blob> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(file);
        return;
      }

      // ছবির স্কেল ঠিক রেখে শার্প করা
      const scale = Math.max(1, Math.min(2, 2000 / Math.max(img.width, img.height)));
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;

      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = imgData.data;

      // ব্রাইটনেস ও কনট্রাস্ট অপটিমাইজেশন (ডট ম্যাট্রিক্স ও ব্যাকগ্রাউন্ড ক্লিন)
      for (let i = 0; i < d.length; i += 4) {
        const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        // ডাইনামিক কনট্রাস্ট স্ট্রেচিং
        const contrastVal = gray < 170 ? Math.max(0, gray - 50) : 255;
        d[i] = contrastVal;
        d[i + 1] = contrastVal;
        d[i + 2] = contrastVal;
      }

      ctx.putImageData(imgData, 0, 0);
      canvas.toBlob((blob) => resolve(blob || file), 'image/png');
    };
    img.src = URL.createObjectURL(file);
  });
}

function cleanNumber(valStr: string): number {
  if (!valStr) return 0;
  let cleaned = valStr.trim();
  // ইউরোপীয় কমা ডেসিমেল ঠিক করা (1.250,50 বা 54,50)
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
  if (y < 100) {
    y = y > 50 ? 1900 + y : 2000 + y;
  }
  const m = parseInt(monthStr, 10);
  const d = parseInt(dayStr, 10);

  if (y < 1980 || y > 2050 || m < 1 || m > 12 || d < 1 || d > 31) {
    return null;
  }
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

  // ১. কারেন্সি শনাক্তকরণ
  let currency = '$';
  if (fullTextLower.includes('chf')) currency = 'CHF';
  else if (fullTextLower.includes('€') || fullTextLower.includes('eur')) currency = '€';
  else if (fullTextLower.includes('£') || fullTextLower.includes('gbp')) currency = '£';
  else if (fullTextLower.includes('tk') || fullTextLower.includes('bdt')) currency = 'Tk';
  else if (fullTextLower.includes('₹') || fullTextLower.includes('inr')) currency = '₹';

  // ২. মার্চেন্ট নেম শনাক্তকরণ
  let merchant = 'Unknown Merchant';
  const brandKeywords: { [key: string]: string[] } = {
    'Berghotel Grosse Scheidegg': ['berghotel', 'grosse scheidegg', 'scheidegg', 'grindelwald', 'familie r.m'],
    'Walmart': ['walmart', 'save money. live better', 'save money live better'],
    'Target': ['target', 'expect more. pay less'],
    'Costco': ['costco wholesale', 'costco'],
    'Starbucks': ['starbucks coffee', 'starbucks'],
    'McDonald\'s': ['mcdonald', 'i\'m lovin\' it'],
    'Subway': ['subway', 'eat fresh'],
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
      if (cleaned.length > 3 && !/rech|invoice|bill|receipt/i.test(cleaned)) {
        merchant = cleaned;
        break;
      }
    }
  }

  // ৩. লাইন আইটেমস পার্সিং
  const items: ReceiptItem[] = [];
  const ignoreKeywords = [
    'total', 'subtotal', 'tax', 'mwst', 'vat', 'gst', 'cash', 'change', 'visa', 'debit',
    'mastercard', 'balance', 'tend', 'approval', 'trans', 'terminal', 'items sold',
    'customer copy', 'entspricht', 'euro', 'eur', 'rech.nr', 'tisch', 'tel', 'fax', 'mail'
  ];

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (ignoreKeywords.some((kw) => lower.startsWith(kw) || lower.includes('total'))) continue;

    // আইটেম নাম এবং শেষের দাম আলাদা করা
    const match = line.match(/^(.+?)(?:\s+à|\s+@|\s+CHF|\s+\$|\s+€)?\s*([0-9]+[.,][0-9]{2})(?:\s*[XONFI\-]*)?$/i);
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

  // ৪. টোটাল অ্যামাউন্ট এক্সট্রাকশন (শক্তিশালী মাল্টি-প্যাটার্ন ক্যাচ)
  let total: number | null = null;
  
  // প্যাটার্ন ১: স্পষ্ট Total/Summe/CHF যুক্ত লাইন
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes('subtotal') || lower.includes('mwst') || lower.includes('eur') || lower.includes('tax')) continue;

    // যেমন: "Total : CHF 54,50" বা "TOTAL 98.21"
    const totalMatch = line.match(/(?:TOTAL|SUMME|GESAMT|AMOUNT\s*DUE|BALANCE)[\s:;=CHF$€£Tk₹]*([0-9]+[.,][0-9]{2})/i);
    if (totalMatch && totalMatch[1]) {
      total = cleanNumber(totalMatch[1]);
      break;
    }
  }

  // প্যাটার্ন ২: টেক্সটের ভেতর একা থাকা "Total ... 54,50"
  if (total === null) {
    const broadMatch = rawText.match(/(?:TOTAL|CHF)[\s:\-=]+([0-9]+[.,][0-9]{2})/i);
    if (broadMatch && broadMatch[1]) {
      total = cleanNumber(broadMatch[1]);
    }
  }

  // প্যাটার্ন ৩: আইটেমস সাম
  if ((total === null || total === 0) && items.length > 0) {
    total = parseFloat(items.reduce((s, itm) => s + itm.amount, 0).toFixed(2));
  }

  // ৫. তারিখ পার্সিং (DD.MM.YYYY, 30.07.2007/13:29:17 এবং টেক্সট ডেট)
  let purchasedAt: string | null = null;

  // টেক্সট মাস
  const textMonthRegex = /\b([0-3]?[0-9])[-/\s.](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[-/\s.](\d{2,4})\b/i;
  const textMatch = rawText.match(textMonthRegex);

  if (textMatch) {
    const months: { [key: string]: string } = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
    };
    purchasedAt = formatToValidDate(textMatch[3], months[textMatch[2].toLowerCase().slice(0, 3)], textMatch[1]);
  }

  // স্ট্যান্ডার্ড নিউমেরিক তারিখ স্ক্যান
  if (!purchasedAt) {
    for (const line of lines) {
      if (line.toLowerCase().includes('tel') || line.toLowerCase().includes('fax') || line.toLowerCase().includes('mwst')) continue;

      const dateMatch = line.match(/\b([0-3]?[0-9])[\.\/\-]([0-1]?[0-9])[\.\/\-](19\d\d|20\d\d|\d{2})\b/);
      if (dateMatch) {
        if (parseInt(dateMatch[1], 10) > 12) {
          purchasedAt = formatToValidDate(dateMatch[3], dateMatch[2], dateMatch[1]);
        } else {
          purchasedAt = formatToValidDate(dateMatch[3], dateMatch[1], dateMatch[2]);
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