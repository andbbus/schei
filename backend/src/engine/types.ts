// Plain data shapes the engine operates on. Decoupled from Prisma so the math
// is pure and unit-testable (and runnable against raw TSV in the oracle check).

export type Cleared = 'uncleared' | 'cleared' | 'reconciled';

export interface EngineSub {
  amount: number;
  categoryId: string | null;
  transferAccountId?: string | null;
}

export interface EngineTxn {
  id: string;
  date: string; // "YYYY-MM-DD"
  amount: number; // milliunits, + inflow / - outflow
  accountId: string;
  categoryId: string | null;
  cleared: Cleared;
  transferAccountId?: string | null;
  deleted?: boolean;
  subtransactions?: EngineSub[];
}

export interface EngineAccount {
  id: string;
  onBudget: boolean;
  type: string;
}

export interface EngineCategory {
  id: string;
  isInflow: boolean;
  paymentAccountId?: string | null; // set on a credit-card payment category
}

export interface EngineAssigned {
  month: string; // "YYYY-MM-01"
  categoryId: string;
  amount: number; // milliunits
}

export interface MonthCategoryResult {
  month: string;
  categoryId: string;
  assigned: number;
  activity: number;
  available: number;
  overspendType?: 'cash' | 'credit' | 'mixed'; // only when available < 0
}

export interface AccountBalance {
  accountId: string;
  cleared: number;
  uncleared: number;
  working: number; // cleared + uncleared, up to and including asOf
  upcoming: number; // sum of future-dated (after asOf) transactions
}

export interface BudgetComputation {
  monthCategories: MonthCategoryResult[];
  rtaByMonth: Record<string, number>;
  incomeByMonth: Record<string, number>;
  assignedByMonth: Record<string, number>;
  activityByMonth: Record<string, number>;
  cashOverspendByMonth: Record<string, number>;
  creditOverspendByMonth: Record<string, number>; // informational — does NOT feed RTA
}
