import { createWorker } from 'tesseract.js';
import { ParsedReceipt } from '@/contracts/receipt';

export async function extractReceiptFromImage(imageFile: File): Promise<ParsedReceipt> {
  const worker = await createWorker('eng');
  const ret = await worker.recognize(imageFile);
  await worker.terminate();

  const rawText = ret.data.text;
  const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean);

  // ১. Merchant Name (প্রথম অর্থপূর্ণ লাইন)
  let merchant = lines[0] || 'Unknown Merchant';
  if (merchant.toLowerCase().includes('cash receipt')) {
    merchant = 'Cash Receipt Store';
  }

  // ২. Total Amount বের করার Regex
  let total: number | null = null;
// Total Amount আরও নিখুঁতভাবে বের করার আপডেট
const totalRegex = /(?:total|amount|balance)[\s:$]*([0-9]+\.[0-9]{2})/i;
  
  for (const line of lines) {
    const match = line.match(totalRegex);
    if (match && match[1]) {
      total = parseFloat(match[1]);
      break;
    }
  }

  // ব্যাকআপ: যদি সরাসরি Total লেখা না মেলে, সবচেয়ে বড় সংখ্যাটি নেওয়া
  if (total === null) {
    const numbers = rawText.match(/\b\d+\.\d{1,2}\b/g);
    if (numbers) {
      const parsedNumbers = numbers.map(Number);
      total = Math.max(...parsedNumbers);
    }
  }

  // ৩. Date খোঁজা
  let purchasedAt: string | null = null;
  const dateMatch = rawText.match(/\b(\d{4}[-/.]\d{2}[-/.]\d{2}|\d{2}[-/.]\d{2}[-/.]\d{4})\b/);
  if (dateMatch) {
    purchasedAt = dateMatch[0].replace(/[/.]/g, '-');
  } else {
    // ডিফল্ট আজকের তারিখ (YYYY-MM-DD)
    purchasedAt = new Date().toISOString().split('T')[0];
  }

  return {
    merchant,
    purchasedAt,
    items: [],
    total: total || 0,
    currency: '$',
    rawText,
    confidence: ret.data.confidence || 0.8,
  };
}