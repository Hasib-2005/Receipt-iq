import { Category, Expense, ExpenseAnalytics } from '@/contracts/receipt';

export function calculateAnalytics(expenses: Expense[]): ExpenseAnalytics {
  const totalSpend = expenses.reduce((sum, exp) => sum + (exp.total || 0), 0);
  const expenseCount = expenses.length;

  const categoryTotals: Record<Category, number> = {
    food: 0,
    transport: 0,
    shopping: 0,
    utilities: 0,
    health: 0,
    entertainment: 0,
    business: 0,
    other: 0,
  };

  expenses.forEach((exp) => {
    if (exp.category && categoryTotals[exp.category] !== undefined) {
      categoryTotals[exp.category] += exp.total || 0;
    } else {
      categoryTotals.other += exp.total || 0;
    }
  });

  let topCategory: Category | null = null;
  let maxAmount = -1;

  const categoryBreakdown = (Object.keys(categoryTotals) as Category[])
    .filter((cat) => categoryTotals[cat] > 0)
    .map((category) => {
      const total = categoryTotals[category];
      if (total > maxAmount) {
        maxAmount = total;
        topCategory = category;
      }
      return {
        category,
        total: Number(total.toFixed(2)),
        percentage: totalSpend > 0 ? Number(((total / totalSpend) * 100).toFixed(1)) : 0,
      };
    });

  return {
    totalSpend: Number(totalSpend.toFixed(2)),
    expenseCount,
    topCategory,
    categoryBreakdown,
  };
}