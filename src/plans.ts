export type PlanCode = "legacy_monthly" | "monthly" | "five_months";

export type SubscriptionPlan = {
  code: PlanCode;
  amount: number;
  durationDays: number;
};

export const SUBSCRIPTION_PLANS: Record<PlanCode, SubscriptionPlan> = {
  legacy_monthly: {
    code: "legacy_monthly",
    amount: 5_000,
    durationDays: 30
  },
  monthly: {
    code: "monthly",
    amount: 10_000,
    durationDays: 30
  },
  five_months: {
    code: "five_months",
    amount: 25_000,
    durationDays: 150
  }
};

export function getSubscriptionPlan(code: string): SubscriptionPlan | null {
  if (code === "legacy_monthly" || code === "monthly" || code === "five_months") {
    return SUBSCRIPTION_PLANS[code];
  }
  return null;
}
