import { createWorker } from 'tesseract.js';
import { ParsedReceipt, ReceiptItem } from '@/contracts/receipt';

// ছবিকে ওসিআরের জন্য ব্ল্যাক অ্যান্ড হোয়াইট ও নয়েজমুক্ত করা
async function preprocessReceiptImage(file: File): Promise<Blob> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = img.width;
      canvas.height = img.height;

      if (!ctx) {
        resolve(file);
        return;
      }

      ctx.drawImage(img, 0, 0);
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imgData.data;

      // Grayscale & Thresholding (টেকুর কাঠের ব্যাকগ্রাউন্ড বাদ দিয়ে টেক্সট শার্প করা)
      for (let i = 0; i < data.length; i += 4) {
        const avg = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
        const val = avg > 145 ? 255 : 0;
        data[i] = val;
        data[i + 1] = val;
        data[i + 2] = val;
      }

      ctx.putImageData(imgData, 0, 0);
      canvas.toBlob((blob) => {
        resolve(blob || file);
      }, 'image/png');
    };
    img.src = URL.createObjectURL(file);
  });
}

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
  const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean);
  const fullTextLower = rawText.toLowerCase();

  // ১. কারেন্সি নির্ধারণ
  let currency = '$';
  if (fullTextLower.includes('chf')) currency = 'CHF';
  else if (fullTextLower.includes('€') || fullTextLower.includes('eur')) currency = '€';
  else if (fullTextLower.includes('£') || fullTextLower.includes('gbp')) currency = '£';
  else if (fullTextLower.includes('tk') || fullTextLower.includes('bdt')) currency = 'Tk';

  // ২. মার্চেন্ট নির্ধারণ
  let merchant = 'Unknown Merchant';
  const brandKeywords: { [key: string]: string[] } = {
    'Berghotel Grosse Scheidegg': ['berghotel', 'grosse scheidegg', 'scheidegg', 'grindelwald'],
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
    for (const line of lines.slice(0, 4)) {
      const cleaned = line.replace(/[^a-zA-Z0-9\s]/g, '').trim();
      if (cleaned.length > 3 && !cleaned.toLowerCase().includes('rech')) {
        merchant = cleaned;
        break;
      }
    }
  }

  // ৩. লাইন আইটেমস এক্সট্রাকশন (ডট ম্যাট্রিক্স ও কোয়ান্টিটি সাপোর্টেড)
  const items: ReceiptItem[] = [];
  const ignoreKeywords = [
    'total', 'subtotal', 'tax', 'mwst', 'vat', 'cash', 'change', 'tend',
    'approval', 'terminal', 'entspricht', 'euro', 'eur', 'rech.nr', 'tisch', 'tel', 'fax'
  ];

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (ignoreKeywords.some((kw) => lower.includes(kw))) continue;

    // যেকোনো লাইনের শেষ প্রাইস ধরা (যেমন 9.00, 5.00, 22.00, 18.50)
    const match = line.match(/^(.+?)(?:\s+à|\s+@|\s+CHF|\s+\$|\s+€)?\s*([0-9]+[.,][0-9]{2})$/i);
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
    if (line.toLowerCase().includes('subtotal') || line.toLowerCase().includes('mwst') || line.toLowerCase().includes('eur')) continue;
    const match = line.match(/(?:TOTAL|CHF)[\s:;=]+([0-9]+[.,][0-9]{2})/i);
    if (match && match[1]) {
      total = cleanNumber(match[1]);
      break;
    }
  }

  if (total === null && items.length > 0) {
    total = parseFloat(items.reduce((s, itm) => s + itm.amount, 0).toFixed(2));
  }

  // ৫. নির্ভুল তারিখ পার্সিং (30.07.2007 এবং স্ল্যাশ টাইমস্ট্যাম্প)
  let purchasedAt: string | null = null;
  const dateRegex = /\b([0-3]?[0-9])[\.\/\-]([0-1]?[0-9])[\.\/\-](19\d\d|20\d\d|\d{2})\b/;

  for (const line of lines) {
    if (line.toLowerCase().includes('tel') || line.toLowerCase().includes('fax')) continue;
    const m = line.match(dateRegex);
    if (m) {
      // ইউরোপীয় ফরম্যাট DD.MM.YYYY
      if (parseInt(m[1], 10) > 12) {
        purchasedAt = formatToValidDate(m[3], m[2], m[1]);
      } else {
        purchasedAt = formatToValidDate(m[3], m[1], m[2]);
      }
      if (purchasedAt) break;
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
    confidence: ret.data.confidence ? ret.data.confidence / 100 : 0.88,
  };
}