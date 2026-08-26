import { createWorker } from 'tesseract.js';
import { ParsedReceipt, ReceiptItem } from '@/contracts/receipt';

export async function extractReceiptFromImage(imageFile: File): Promise<ParsedReceipt> {
  const worker = await createWorker('eng');
  const ret = await worker.recognize(imageFile);
  await worker.terminate();

  const rawText = ret.data.text;
  const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean);

  // ১. Merchant Name
  let merchant = lines[0] || 'Unknown Merchant';
  if (merchant.toLowerCase().includes('cash receipt')) {
    merchant = 'Cash Receipt Store';
  }

  // ২. Items ও Price আলাদা বের করা
  const items: ReceiptItem[] = [];
  const itemLineRegex = /^(.*?)\s+[\$]?([0-9]+\.[0-9]{2})$/;
  const ignoreKeywords = ['total', 'cash', 'change', 'subtotal', 'tax', 'date', 'bank', 'due', 'thank'];

  for (const line of lines) {
    const isIgnored = ignoreKeywords.some((kw) => line.toLowerCase().includes(kw));
    if (isIgnored) continue;

    const match = line.match(itemLineRegex);
    if (match && match[1] && match[2]) {
      const name = match[1].replace(/[-_.*]/g, '').trim();
      const amount = parseFloat(match[2]);
      if (name.length > 2 && !isNaN(amount)) {
        items.push({
          name,
          quantity: 1,
          amount,
        });
      }
    }
  }

  // ৩. Total Amount
  let total: number | null = null;
  const totalRegex = /(?:total|amount|grand\s*total|balance)[\s:$]*([0-9]+\.[0-9]{2})/i;
  for (const line of lines) {
    const match = line.match(totalRegex);
    if (match && match[1]) {
      total = parseFloat(match[1]);
      break;
    }
  }

  if (total === null && items.length > 0) {
    total = items.reduce((sum, itm) => sum + itm.amount, 0);
  }

  // ৪. Date
  let purchasedAt: string | null = null;
  const dateMatch = rawText.match(/\b(\d{4}[-/.]\d{2}[-/.]\d{2}|\d{2}[-/.]\d{2}[-/.]\d{4})\b/);
  if (dateMatch) {
    purchasedAt = dateMatch[0].replace(/[/.]/g, '-');
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
    confidence: ret.data.confidence || 0.8,
  };
}