/** Only two saleable plans. Historical payment meta may still contain retired plan codes. */
export type PlanCode = "monthly" | "six_months";

export type SubscriptionPlan = {
  code: PlanCode;
  amount: number;
  durationDays: number;
};

export const SUBSCRIPTION_PLANS: Record<PlanCode, SubscriptionPlan> = {
  monthly: {
    code: "monthly",
    amount: 5_000,
    durationDays: 30
  },
  six_months: {
    code: "six_months",
    amount: 25_000,
    durationDays: 180
  }
};

export function getSubscriptionPlan(code: string): SubscriptionPlan | null {
  if (code === "monthly" || code === "six_months") {
    return SUBSCRIPTION_PLANS[code];
  }
  return null;
}
