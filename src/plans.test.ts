import { describe, expect, it } from "vitest";
import { getSubscriptionPlan, SUBSCRIPTION_PLANS } from "./plans.js";

describe("Bakieva subscription plans", () => {
  it("keeps the legacy cohort at 5000 KZT for 30 days", () => {
    expect(SUBSCRIPTION_PLANS.legacy_monthly).toMatchObject({
      amount: 5000,
      durationDays: 30
    });
  });

  it("offers new clients 10000 KZT for 30 days", () => {
    expect(SUBSCRIPTION_PLANS.monthly).toMatchObject({
      amount: 10000,
      durationDays: 30
    });
  });

  it("offers 25000 KZT for five 30-day periods", () => {
    expect(SUBSCRIPTION_PLANS.five_months).toMatchObject({
      amount: 25000,
      durationDays: 150
    });
  });

  it("does not resolve arbitrary plan codes", () => {
    expect(getSubscriptionPlan("legacy_monthly")?.amount).toBe(5000);
    expect(getSubscriptionPlan("unknown")).toBeNull();
  });
});
