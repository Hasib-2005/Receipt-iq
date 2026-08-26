import { createWorker } from 'tesseract.js';
import { ParsedReceipt, ReceiptItem } from '@/contracts/receipt';

export async function extractReceiptFromImage(imageFile: File): Promise<ParsedReceipt> {
  const worker = await createWorker('eng');
  const ret = await worker.recognize(imageFile);
  await worker.terminate();

  const rawText = ret.data.text;
  const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean);

  // ১. নির্ভুল Merchant Name ডিটেকশন
  let merchant = 'Unknown Merchant';
  const fullTextLower = rawText.toLowerCase();

  // পরিচিত বড় ব্র্যান্ড ও স্লোগান ম্যাপিং
  const brandKeywords: { [key: string]: string[] } = {
    'Walmart': ['walmart', 'save money. live better', 'save money live better'],
    'Target': ['target', 'expect more. pay less'],
    'Costco': ['costco wholesale', 'costco'],
    'Starbucks': ['starbucks coffee', 'starbucks'],
    'McDonald\'s': ['mcdonald', 'i\'m lovin\' it'],
    'Subway': ['subway', 'eat fresh'],
    'Home Depot': ['home depot'],
    'Walgreens': ['walgreens'],
  };

  for (const [brand, triggers] of Object.entries(brandKeywords)) {
    if (triggers.some((trigger) => fullTextLower.includes(trigger))) {
      merchant = brand;
      break;
    }
  }

  // যদি ডিকশনারিতে না মিলে, তবে ওপরের লাইনগুলোর মধ্য থেকে নয়েজ বাদে প্রথম অর্থপূর্ণ নাম নেওয়া
  if (merchant === 'Unknown Merchant') {
    for (const line of lines.slice(0, 5)) {
      // অপ্রয়োজনীয় ছোট নয়েজ বা অদ্ভুত চিহ্ন ফিল্টার
      const cleaned = line.replace(/[^a-zA-Z0-9\s]/g, '').trim();
      const isNoise = cleaned.length < 4 || /^[0-9\s]+$/.test(cleaned) || cleaned.toLowerCase().includes('receipt');
      if (!isNoise) {
        merchant = cleaned;
        break;
      }
    }
  }

  // ২. Items ও Price আলাদা করা
  const items: ReceiptItem[] = [];
  const itemLineRegex = /^(.*?)(?:\s+\d{8,15})?\s+[\$]?([0-9]+\.[0-9]{2})(?:\s*[XONFI\-]*)?$/i;
  const ignoreKeywords = [
    'total', 'subtotal', 'tax', 'cash', 'change', 'visa', 'debit', 'mastercard', 
    'balance', 'tend', 'approval', 'trans', 'terminal', 'items sold', 'customer copy'
  ];

  for (const line of lines) {
    const lower = line.toLowerCase();
    const isIgnored = ignoreKeywords.some((kw) => lower.includes(kw));
    if (isIgnored) continue;

    const match = line.match(itemLineRegex);
    if (match && match[1] && match[2]) {
      const name = match[1].replace(/[-_.*#]/g, '').trim();
      const amount = parseFloat(match[2]);
      if (name.length >= 2 && !isNaN(amount) && !name.match(/^\d+$/)) {
        items.push({
          name,
          quantity: 1,
          amount,
        });
      }
    }
  }

  // ৩. Total Amount (Subtotal এড়িয়ে Final Total ধরা)
  let total: number | null = null;
  const exactTotalRegex = /(?:^|\s)(?:TOTAL|BALANCE\s*DUE|AMOUNT\s*DUE)[\s:$]*([0-9]+\.[0-9]{2})/i;
  for (const line of lines) {
    if (line.toLowerCase().includes('subtotal')) continue;
    const match = line.match(exactTotalRegex);
    if (match && match[1]) {
      total = parseFloat(match[1]);
      break;
    }
  }

  if (total === null) {
    const fallbackTotalRegex = /(?:grand\s*total|total)[\s:$]*([0-9]+\.[0-9]{2})/i;
    for (const line of lines) {
      if (line.toLowerCase().includes('subtotal')) continue;
      const match = line.match(fallbackTotalRegex);
      if (match && match[1]) {
        total = parseFloat(match[1]);
        break;
      }
    }
  }

  if (total === null && items.length > 0) {
    total = items.reduce((sum, itm) => sum + itm.amount, 0);
  }

  // ৪. Date (2-digit বা 4-digit সাল সাপোর্ট)
  let purchasedAt: string | null = null;
  const dateMatch = rawText.match(/\b(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})\b/);
  if (dateMatch) {
    let [_, m, d, y] = dateMatch;
    if (y.length === 2) y = `20${y}`;
    purchasedAt = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  } else {
    purchasedAt = new Date().toISOString().split('T')[0];
  }

  return {
    merchant,
    purchasedAt,
    items,
    total: total || 0,
    currency: '$',
    rawText,
    confidence: ret.data.confidence || 0.85,
  };
}