export type Category =
  | 'food'
  | 'transport'
  | 'shopping'
  | 'utilities'
  | 'health'
  | 'entertainment'
  | 'business'
  | 'other';

export interface ReceiptItem {
  name: string;
  quantity: number;
  amount: number;
}

export interface ParsedReceipt {
  merchant: string | null;
  purchasedAt: string | null;
  items: ReceiptItem[];
  total: number | null;
  currency: string | null;
  rawText: string;
  confidence: number;
}

export interface ExpenseDraft extends ParsedReceipt {
  category: Category;
}

export interface Expense extends ExpenseDraft {
  id: string;
  createdAt: string;
}

export interface ExpenseAnalytics {
  totalSpend: number;
  expenseCount: number;
  topCategory: Category | null;
  categoryBreakdown: Array<{
    category: Category;
    total: number;
    percentage: number;
  }>;
}