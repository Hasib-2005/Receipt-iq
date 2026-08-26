import { createWorker } from 'tesseract.js';
import { ParsedReceipt, ReceiptItem } from '@/contracts/receipt';

export async function extractReceiptFromImage(imageFile: File): Promise<ParsedReceipt> {
  const worker = await createWorker('eng');
  const ret = await worker.recognize(imageFile);
  await worker.terminate();

  const rawText = ret.data.text;
  const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean);

  // ১. Merchant Name (লোগো নয়েজ ফিল্টার)
  let merchant = 'Unknown Merchant';
  const knownMerchants = ['walmart', 'target', 'costco', 'starbucks', 'dhaba', 'mcdonald'];
  
  for (const line of lines.slice(0, 8)) {
    const matched = knownMerchants.find((m) => line.toLowerCase().includes(m));
    if (matched) {
      merchant = matched.toUpperCase();
      break;
    }
  }
  if (merchant === 'Unknown Merchant' && lines.length > 0) {
    merchant = lines.find((l) => l.length > 3 && !l.match(/^[0-9\W]+$/)) || lines[0];
  }

  // ২. Items ও Price আলাদা করা (বারকোড ও X/O/N ফ্ল্যাগ হ্যান্ডলিং)
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

  // ৪. Date (2-digit সাল যেমন 07/28/17 বা 4-digit সাল সাপোর্ট)
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