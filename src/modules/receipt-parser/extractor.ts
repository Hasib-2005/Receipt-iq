import { createWorker } from 'tesseract.js';
import { ParsedReceipt, ReceiptItem } from '@/contracts/receipt';

// সংখ্যা ক্লিনিং (কমা বা ডট ফরম্যাটকে স্ট্যান্ডার্ড ডেসিমেল নাম্বারে রূপান্তর)
function cleanNumber(valStr: string): number {
  let cleaned = valStr.trim();
  // ইউরোপীয় ফরম্যাট (1.250,50 -> 1250.50)
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

  // ১. কারেন্সি ডিটেকশন (Universal Currency Detection)
  let currency = '$';
  if (fullTextLower.includes('chf')) currency = 'CHF';
  else if (fullTextLower.includes('€') || fullTextLower.includes('eur')) currency = '€';
  else if (fullTextLower.includes('£') || fullTextLower.includes('gbp')) currency = '£';
  else if (fullTextLower.includes('tk') || fullTextLower.includes('bdt') || fullTextLower.includes('taka')) currency = 'Tk';
  else if (fullTextLower.includes('₹') || fullTextLower.includes('inr') || fullTextLower.includes('rs')) currency = '₹';
  else if (fullTextLower.includes('$') || fullTextLower.includes('usd')) currency = '$';

  // ২. মার্চেন্ট নেম এক্সট্রাকশন (স্মার্ট ব্র্যান্ড ডিকশনারি + ক্লিন হেডার ফিল্টার)
  let merchant = 'Unknown Merchant';
  const brandKeywords: { [key: string]: string[] } = {
    'Berghotel Grosse Scheidegg': ['berghotel', 'grosse scheidegg', 'grindelwald'],
    'Walmart': ['walmart', 'save money. live better', 'save money live better'],
    'Target': ['target', 'expect more. pay less'],
    'Costco': ['costco wholesale', 'costco'],
    'Starbucks': ['starbucks coffee', 'starbucks'],
    'McDonald\'s': ['mcdonald', 'i\'m lovin\' it'],
    'Subway': ['subway', 'eat fresh'],
    'Agora Superstore': ['agora'],
    'Shwapno': ['shwapno', 'swapno'],
    'Meena Bazar': ['meena bazar', 'meenabazar'],
    'Unimart': ['unimart'],
    'KFC': ['kentucky fried chicken', 'kfc'],
    'Pizza Hut': ['pizza hut'],
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
        cleaned.toLowerCase().includes('cash memo') ||
        cleaned.toLowerCase().includes('bill no') ||
        cleaned.toLowerCase().includes('rech.nr');
      if (!isNoise) {
        merchant = line.replace(/[-_*#|]/g, '').trim();
        break;
      }
    }
  }

  // ৩. লাইন আইটেমস পার্সিং
  const items: ReceiptItem[] = [];
  const ignoreKeywords = [
    'total', 'subtotal', 'sub-total', 'tax', 'mwst', 'vat', 'gst', 'cash', 'change', 
    'visa', 'debit', 'mastercard', 'amex', 'balance', 'tend', 'approval', 'trans', 
    'terminal', 'items sold', 'customer copy', 'entspricht', 'euro', 'eur', 'chf',
    'bediente', 'tisch', 'rech.nr', 'invoice', 'table', 'date', 'time', 'phone', 'tel'
  ];

  for (const line of lines) {
    const lower = line.toLowerCase();
    const isIgnored = ignoreKeywords.some((kw) => lower.startsWith(kw) || lower.includes('total'));
    if (isIgnored) continue;

    // লাইনের শেষের দিকে প্রাইস ফরম্যাট ম্যাচ করা (যেমন: 12.50, 54,50, $4.99 ইত্যাদি)
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

  // ৪. টোটাল অ্যামাউন্ট এক্সট্রাকশন (সব ধরণের কি-ওয়ার্ড ও কমা/ডট হ্যান্ডলিং)
  let total: number | null = null;
  const totalKeywordsRegex = /(?:^|\s)(?:TOTAL|SUMME|GESAMT|GRAND\s*TOTAL|BALANCE\s*DUE|AMOUNT\s*DUE|NET\s*PAYABLE|TOTAL\s*PAYABLE|TOTAL\s*AMOUNT|BILL\s*AMOUNT|BALANCE)[\s:;=CHF$€£Tk₹]*([0-9]+[.,][0-9]{2})/i;

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes('subtotal') || lower.includes('mwst') || lower.includes('tax') || lower.includes('vat')) continue;

    const match = line.match(totalKeywordsRegex);
    if (match && match[1]) {
      total = cleanNumber(match[1]);
      break;
    }
  }

  // যদি স্পেসিফিক কি-ওয়ার্ডে না পায়, সাধারণ Total খোঁজা
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

  // আইটেমস যোগ করে ব্যাকআপ টোটাল নির্ধারণ
  if ((total === null || total === 0) && items.length > 0) {
    total = parseFloat(items.reduce((sum, itm) => sum + itm.amount, 0).toFixed(2));
  }

  // ৫. ইউনিভার্সাল ডেট পার্সিং (DD.MM.YYYY, MM/DD/YYYY, YYYY-MM-DD, Text Dates)
  let purchasedAt: string | null = null;

  // প্যাটার্ন ক: টেক্সট মাস (যেমন: 26 Aug 2026, August 26, 2026, 28-Jul-2017)
  const textMonthRegex = /\b(\d{1,2})[-/\s.](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[-/\s.](\d{2,4})\b/i;
  const textMatch = rawText.match(textMonthRegex);

  // প্যাটার্ন খ: YYYY-MM-DD বা YYYY/MM/DD
  const ymdMatch = rawText.match(/\b(\d{4})[\/\-\.]([0-1]?[0-9])[\/\-\.]([0-3]?[0-9])\b/);

  // প্যাটার্ন গ: DD.MM.YYYY / MM-DD-YYYY / DD/MM/YY (টাইমস্ট্যাম্প যেমন 30.07.2007/13:29:17 থাকলেও আলাদা করবে)
  const genericDateMatch = rawText.match(/\b([0-3]?[0-9])[\/\-\.]([0-1]?[0-9])[\/\-\.](\d{2,4})\b/);

  if (textMatch) {
    const months: { [key: string]: string } = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
    };
    let day = textMatch[1].padStart(2, '0');
    let month = months[textMatch[2].toLowerCase().slice(0, 3)];
    let year = textMatch[3].length === 2 ? `20${textMatch[3]}` : textMatch[3];
    purchasedAt = `${year}-${month}-${day}`;
  } else if (ymdMatch) {
    purchasedAt = `${ymdMatch[1]}-${ymdMatch[2].padStart(2, '0')}-${ymdMatch[3].padStart(2, '0')}`;
  } else if (genericDateMatch) {
    let [_, p1, p2, year] = genericDateMatch;
    if (year.length === 2) year = `20${year}`;

    // যদি প্রথম সংখ্যা ১২ এর চেয়ে বড় হয়, তবে নিশ্চিতভাবে DD-MM-YYYY
    if (parseInt(p1, 10) > 12) {
      purchasedAt = `${year}-${p2.padStart(2, '0')}-${p1.padStart(2, '0')}`;
    } else {
      // সাধারণ মার্কিন ফরম্যাট MM-DD-YYYY
      purchasedAt = `${year}-${p1.padStart(2, '0')}-${p2.padStart(2, '0')}`;
    }
  } else {
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