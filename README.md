# ReceiptIQ — Autonomous Receipt Expense Tracker

ReceiptIQ eliminates manual expense tracking by converting raw receipt photos into structured, categorized expenses with built-in human verification.

## Core Features (MVP)
- **Receipt Upload & Preview:** Supports PNG/JPG format validation and instant UI preview.
- **Client-Side OCR Extraction:** Extracts merchant name, purchase date, line items, and total amount using `Tesseract.js`.
- **Automatic Expense Categorization:** Rule-based keyword engine maps expenses into standard buckets (Food, Transport, Shopping, Utilities, etc.).
- **Human-in-the-Loop Review:** Fully editable extracted fields before saving to prevent OCR errors.
- **Analytics & Persistence:** Real-time spending breakdown with interactive Donut Charts (`Recharts`) and LocalStorage persistence.

## Tech Stack
- **Framework:** Next.js (App Router, TypeScript)
- **Styling:** Tailwind CSS, Lucide Icons
- **OCR Engine:** Tesseract.js
- **Visualization:** Recharts
- **State/Storage:** Client-side LocalStorage

## Getting Started

1. Clone repository:
   ```bash
   git clone <REPO_URL>
   cd receipt-iq