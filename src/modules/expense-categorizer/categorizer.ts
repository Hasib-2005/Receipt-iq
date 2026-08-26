import { Category } from '@/contracts/receipt';

export function categorizeExpense(merchant: string, rawText: string): Category {
  const text = `${merchant} ${rawText}`.toLowerCase();

  if (/(food|cafe|coffee|restaurant|pizza|burger|latte|bakery|lunch|dinner|shwapno)/.test(text)) {
    return 'food';
  }
  if (/(uber|pathao|transport|fuel|gas|taxi|ride|train|bus)/.test(text)) {
    return 'transport';
  }
  if (/(shop|store|amazon|cloth|mart|fashion|electronics)/.test(text)) {
    return 'shopping';
  }
  if (/(electric|bill|desco|water|gas|utility|internet|wifi)/.test(text)) {
    return 'utilities';
  }
  if (/(hospital|pharma|medicine|doctor|clinic)/.test(text)) {
    return 'health';
  }
  if (/(movie|cinema|netflix|game|ticket)/.test(text)) {
    return 'entertainment';
  }

  return 'other';
}