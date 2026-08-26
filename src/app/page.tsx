'use client';

import React, { useState, useEffect } from 'react';
import { INITIAL_EXPENSES } from '@/fixtures/receipt-fixtures';
import { calculateAnalytics } from '@/modules/analytics';
import { Expense, Category, ParsedReceipt } from '@/contracts/receipt';
import { extractReceiptFromImage } from '@/modules/receipt-parser/extractor';
import { categorizeExpense } from '@/modules/expense-categorizer/categorizer';
import { supabase } from '@/modules/supabase';
import { 
  UploadCloud, 
  CheckCircle2, 
  DollarSign, 
  TrendingUp, 
  ShoppingBag, 
  Receipt, 
  AlertCircle, 
  RefreshCw,
  Trash2
} from 'lucide-react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';

const COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#64748b'];

export default function DashboardPage() {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [reviewData, setReviewData] = useState<ParsedReceipt & { category: Category } | null>(null);

  // ক্লাউড Supabase থেকে ডেটা ফেচ
  const loadExpenses = async () => {
    try {
      const { data, error } = await supabase
        .from('expenses')
        .select('*')
        .order('created_at', { ascending: false });

      if (data && data.length > 0) {
        const formatted: Expense[] = data.map((d: any) => ({
          id: d.id,
          merchant: d.merchant,
          purchasedAt: d.purchased_at,
          category: d.category as Category,
          total: parseFloat(d.total),
          currency: d.currency || '$',
          items: d.items || [],
          rawText: d.raw_text || '',
          confidence: d.confidence || 1,
          createdAt: d.created_at,
        }));
        setExpenses(formatted);
      } else {
        setExpenses(INITIAL_EXPENSES);
      }
    } catch {
      setExpenses(INITIAL_EXPENSES);
    } finally {
      setIsLoaded(true);
    }
  };

  useEffect(() => {
    loadExpenses();
  }, []);

  const analytics = calculateAnalytics(expenses);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setSelectedFile(file);
      setPreviewUrl(URL.createObjectURL(file));
      setReviewData(null);
    }
  };

  const handleProcessReceipt = async () => {
    if (!selectedFile) return;
    setIsProcessing(true);

    try {
      const parsed = await extractReceiptFromImage(selectedFile);
      const suggestedCategory = categorizeExpense(parsed.merchant || '', parsed.rawText);

      setReviewData({
        ...parsed,
        category: suggestedCategory,
      });
    } catch (err) {
      console.error('OCR Error:', err);
      alert('Failed to read receipt. Please enter details manually.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleSaveExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reviewData) return;

    const newExpense: Expense = {
      ...reviewData,
      id: `exp-${Date.now()}`,
      createdAt: new Date().toISOString(),
    };

    // ক্লাউড টেবিলে ইনসার্ট
    await supabase.from('expenses').insert({
      id: newExpense.id,
      merchant: newExpense.merchant,
      purchased_at: newExpense.purchasedAt,
      category: newExpense.category,
      total: newExpense.total,
      currency: newExpense.currency,
      items: newExpense.items,
      raw_text: newExpense.rawText,
      confidence: newExpense.confidence,
    });

    setExpenses([newExpense, ...expenses]);
    setReviewData(null);
    setSelectedFile(null);
    setPreviewUrl(null);
  };

  const handleDeleteExpense = async (id: string) => {
    await supabase.from('expenses').delete().eq('id', id);
    setExpenses(expenses.filter((e) => e.id !== id));
  };

  if (!isLoaded) return null;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 p-4 md:p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        
        {/* Header */}
        <header className="flex justify-between items-center bg-white p-6 rounded-xl border border-slate-200 shadow-xs">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Receipt className="w-7 h-7 text-indigo-600" />
              ReceiptIQ
            </h1>
            <p className="text-sm text-slate-500">Autonomous Receipt Expense Tracker</p>
          </div>
          <span className="bg-emerald-100 text-emerald-800 text-xs px-3 py-1.5 rounded-full font-medium flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
            Cloud Synced
          </span>
        </header>

        {/* Analytics Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-xs flex items-center gap-4">
            <div className="p-3 bg-indigo-50 text-indigo-600 rounded-lg">
              <DollarSign className="w-6 h-6" />
            </div>
            <div>
              <p className="text-sm font-medium text-slate-500">Total Spending</p>
              <h3 className="text-2xl font-bold">${analytics.totalSpend}</h3>
            </div>
          </div>

          <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-xs flex items-center gap-4">
            <div className="p-3 bg-emerald-50 text-emerald-600 rounded-lg">
              <ShoppingBag className="w-6 h-6" />
            </div>
            <div>
              <p className="text-sm font-medium text-slate-500">Total Receipts</p>
              <h3 className="text-2xl font-bold">{analytics.expenseCount}</h3>
            </div>
          </div>

          <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-xs flex items-center gap-4">
            <div className="p-3 bg-amber-50 text-amber-600 rounded-lg">
              <TrendingUp className="w-6 h-6" />
            </div>
            <div>
              <p className="text-sm font-medium text-slate-500">Top Category</p>
              <h3 className="text-2xl font-bold capitalize">{analytics.topCategory || 'N/A'}</h3>
            </div>
          </div>
        </div>

        {/* Upload & Review Form */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          
          {/* Upload Card */}
          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-xs">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <UploadCloud className="w-5 h-5 text-indigo-600" />
              Upload Receipt
            </h2>

            <div className="border-2 border-dashed border-slate-200 rounded-xl p-6 text-center hover:border-indigo-400 transition-colors bg-slate-50">
              <input
                type="file"
                accept="image/png, image/jpeg, image/jpg"
                onChange={handleFileChange}
                className="hidden"
                id="receipt-upload"
              />
              <label htmlFor="receipt-upload" className="cursor-pointer flex flex-col items-center">
                <UploadCloud className="w-10 h-10 text-slate-400 mb-2" />
                <span className="text-sm font-semibold text-indigo-600">Click to upload receipt</span>
                <span className="text-xs text-slate-400 mt-1">PNG, JPG up to 5MB</span>
              </label>
            </div>

            {previewUrl && (
              <div className="mt-4 space-y-3">
                <div className="flex items-center justify-between bg-slate-100 p-2 rounded-lg text-sm">
                  <span className="truncate max-w-[200px] font-medium">{selectedFile?.name}</span>
                  <button
                    onClick={handleProcessReceipt}
                    disabled={isProcessing}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-1.5 rounded-md font-medium text-sm transition-all flex items-center gap-1.5 disabled:opacity-50"
                  >
                    {isProcessing ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        Reading Receipt...
                      </>
                    ) : (
                      'Extract Data'
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Review & Edit Form */}
          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-xs">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-emerald-600" />
              Review Extracted Details
            </h2>

            {reviewData ? (
              <form onSubmit={handleSaveExpense} className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-semibold text-slate-500 uppercase">Merchant</label>
                    <input
                      type="text"
                      required
                      value={reviewData.merchant || ''}
                      onChange={(e) => setReviewData({ ...reviewData, merchant: e.target.value })}
                      className="w-full mt-1 px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-slate-500 uppercase">Date</label>
                    <input
                      type="date"
                      required
                      value={reviewData.purchasedAt || ''}
                      onChange={(e) => setReviewData({ ...reviewData, purchasedAt: e.target.value })}
                      className="w-full mt-1 px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-semibold text-slate-500 uppercase">Total Amount ($)</label>
                    <input
                      type="number"
                      step="0.01"
                      required
                      value={reviewData.total || ''}
                      onChange={(e) => setReviewData({ ...reviewData, total: parseFloat(e.target.value) || 0 })}
                      className="w-full mt-1 px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-slate-500 uppercase">Category</label>
                    <select
                      value={reviewData.category}
                      onChange={(e) => setReviewData({ ...reviewData, category: e.target.value as Category })}
                      className="w-full mt-1 px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none capitalize"
                    >
                      {['food', 'transport', 'shopping', 'utilities', 'health', 'entertainment', 'business', 'other'].map((cat) => (
                        <option key={cat} value={cat}>
                          {cat}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {reviewData.items && reviewData.items.length > 0 && (
                  <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                    <p className="text-xs font-semibold text-slate-500 uppercase mb-2">Detected Line Items</p>
                    <div className="space-y-1 max-h-28 overflow-y-auto">
                      {reviewData.items.map((item, idx) => (
                        <div key={idx} className="flex justify-between text-xs text-slate-700">
                          <span>{item.name}</span>
                          <span className="font-semibold">${item.amount.toFixed(2)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <button
                  type="submit"
                  className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-medium py-2 rounded-lg transition-colors text-sm"
                >
                  Confirm & Save Expense
                </button>
              </form>
            ) : (
              <div className="h-44 flex flex-col items-center justify-center text-slate-400 border border-dashed rounded-lg">
                <AlertCircle className="w-8 h-8 mb-1 text-slate-300" />
                <p className="text-sm">Upload a receipt and click "Extract Data" to review.</p>
              </div>
            )}
          </div>
        </div>

        {/* Expenses List & Category Visualizer */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          
          {/* Table */}
          <div className="lg:col-span-2 bg-white p-6 rounded-xl border border-slate-200 shadow-xs">
            <h2 className="text-lg font-semibold mb-4">Recent Expenses</h2>
            {expenses.length === 0 ? (
              <p className="text-slate-400 text-sm py-4">No expenses saved yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="border-b text-slate-400 text-xs uppercase">
                      <th className="py-2.5">Merchant</th>
                      <th className="py-2.5">Date</th>
                      <th className="py-2.5">Category</th>
                      <th className="py-2.5 text-right">Total</th>
                      <th className="py-2.5 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {expenses.map((exp) => (
                      <tr key={exp.id} className="hover:bg-slate-50">
                        <td className="py-3 font-medium">
                          {exp.merchant}
                          {exp.items && exp.items.length > 0 && (
                            <p className="text-xs text-slate-400 font-normal truncate max-w-[200px]">
                              {exp.items.map((i) => `${i.name} ($${i.amount.toFixed(2)})`).join(', ')}
                            </p>
                          )}
                        </td>
                        <td className="py-3 text-slate-500">{exp.purchasedAt}</td>
                        <td className="py-3">
                          <span className="capitalize px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-700">
                            {exp.category}
                          </span>
                        </td>
                        <td className="py-3 text-right font-semibold">${exp.total?.toFixed(2)}</td>
                        <td className="py-3 text-right">
                          <button
                            onClick={() => handleDeleteExpense(exp.id)}
                            className="text-slate-400 hover:text-red-500 transition-colors p-1"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Recharts Analytics Donut */}
          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-xs flex flex-col justify-between">
            <h2 className="text-lg font-semibold mb-2">Spending Breakdown</h2>
            
            <div className="h-44 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={analytics.categoryBreakdown}
                    dataKey="total"
                    nameKey="category"
                    cx="50%"
                    cy="50%"
                    innerRadius={45}
                    outerRadius={70}
                    paddingAngle={3}
                  >
                    {analytics.categoryBreakdown.map((_, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value: any) => [`$${value}`, 'Amount']} />
                </PieChart>
              </ResponsiveContainer>
            </div>

            <div className="space-y-2 mt-2">
              {analytics.categoryBreakdown.map((item, index) => (
                <div key={item.category} className="flex justify-between items-center text-xs">
                  <div className="flex items-center gap-1.5">
                    <span
                      className="w-2.5 h-2.5 rounded-full"
                      style={{ backgroundColor: COLORS[index % COLORS.length] }}
                    ></span>
                    <span className="capitalize text-slate-600">{item.category}</span>
                  </div>
                  <span className="text-slate-900 font-semibold">${item.total}</span>
                </div>
              ))}
            </div>
          </div>

        </div>

      </div>
    </div>
  );
}