import { describe, expect, it } from "vitest";
import { getSubscriptionPlan, SUBSCRIPTION_PLANS } from "./plans.js";

describe("Bakieva public subscription catalogue", () => {
  it("contains exactly two saleable plans for everyone", () => {
    expect(Object.keys(SUBSCRIPTION_PLANS).sort()).toEqual(["monthly", "six_months"]);
  });

  it("charges 5000 KZT for one 30-day period", () => {
    expect(SUBSCRIPTION_PLANS.monthly).toEqual({
      code: "monthly", amount: 5000, durationDays: 30
    });
  });

  it("charges 25000 KZT for six 30-day periods", () => {
    expect(SUBSCRIPTION_PLANS.six_months).toEqual({
      code: "six_months", amount: 25000, durationDays: 180
    });
  });

  it("retired legacy, five-month, and arbitrary codes cannot be purchased", () => {
    expect(getSubscriptionPlan("legacy_monthly")).toBeNull();
    expect(getSubscriptionPlan("five_months")).toBeNull();
    expect(getSubscriptionPlan("unknown")).toBeNull();
  });
});
