import { describe, expect, it } from "vitest";
import { getSubscriptionPlan, SUBSCRIPTION_PLANS } from "./plans.js";

describe("two active Bakieva Chat tariffs",()=>{
  it("contains exactly two public tariffs",()=>{
    expect(Object.keys(SUBSCRIPTION_PLANS).sort()).toEqual(["monthly","six_months"]);
  });
  it("offers one month for 5 000 KZT",()=>{
    expect(SUBSCRIPTION_PLANS.monthly).toMatchObject({ amount:5000,durationDays:30 });
  });
  it("offers six months for 25 000 KZT",()=>{
    expect(SUBSCRIPTION_PLANS.six_months).toMatchObject({ amount:25000,durationDays:180 });
  });
  it("rejects all retired or unknown tariff codes",()=>{
    for(const code of ["legacy_monthly","five_months","unknown"])
      expect(getSubscriptionPlan(code)).toBeNull();
  });
});
