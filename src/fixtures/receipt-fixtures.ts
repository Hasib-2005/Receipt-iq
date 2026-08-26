import { Expense, ParsedReceipt } from '@/contracts/receipt';

export const MOCK_PARSED_RECEIPT: ParsedReceipt = {
  merchant: 'Starbucks Coffee',
  purchasedAt: '2026-08-26',
  items: [
    { name: 'Caffe Latte', quantity: 1, amount: 5.50 },
    { name: 'Croissant', quantity: 1, amount: 4.20 }
  ],
  total: 9.70,
  currency: 'USD',
  rawText: 'STARBUCKS COFFEE\n2026-08-26\nCaffe Latte $5.50\nCroissant $4.20\nTOTAL: $9.70',
  confidence: 0.95
};

export const INITIAL_EXPENSES: Expense[] = [
  {
    id: 'exp-1',
    merchant: 'Starbucks Coffee',
    purchasedAt: '2026-08-25',
    category: 'food',
    total: 9.70,
    currency: 'USD',
    items: [{ name: 'Caffe Latte', quantity: 1, amount: 5.50 }, { name: 'Croissant', quantity: 1, amount: 4.20 }],
    rawText: '',
    confidence: 1,
    createdAt: new Date('2026-08-25').toISOString()
  },
  {
    id: 'exp-2',
    merchant: 'Uber Ride',
    purchasedAt: '2026-08-24',
    category: 'transport',
    total: 24.50,
    currency: 'USD',
    items: [{ name: 'City Trip', quantity: 1, amount: 24.50 }],
    rawText: '',
    confidence: 1,
    createdAt: new Date('2026-08-24').toISOString()
  },
  {
    id: 'exp-3',
    merchant: 'Amazon Basics',
    purchasedAt: '2026-08-23',
    category: 'shopping',
    total: 45.00,
    currency: 'USD',
    items: [{ name: 'USB-C Cable', quantity: 2, amount: 45.00 }],
    rawText: '',
    confidence: 1,
    createdAt: new Date('2026-08-23').toISOString()
  }
];