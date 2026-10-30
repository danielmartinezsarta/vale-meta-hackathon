// @vitest-environment node
import { describe, expect, it } from "vitest";
import { quotePrice, workableMinutesPerMonth, type PricingConfig } from "./quote";

// Invented pricing block from the seed: 2500 USD goal, Mon-Fri 9-17,
// 30% margin, 800 + 150 + 70 + 80 monthly fixed.
const PRICING: PricingConfig = {
  goalMonthlyUsd: 2500,
  workDaysPerWeek: 5,
  workHoursPerDay: 8,
  marginPct: 30,
  fixedMonthlyUsd: 1100,
};

describe("workable month", () => {
  it("derives 10400 minutes from the schedule", () => {
    expect(workableMinutesPerMonth(PRICING)).toBe(10400);
  });
});

describe("quote math", () => {
  it("prices the semipermanente recipe at 40 USD", () => {
    const result = quotePrice(PRICING, 60, [
      { qty: 1, pricePerProductUsd: 1, contentPerProduct: 1 },
      { qty: 1, pricePerProductUsd: 1, contentPerProduct: 1 },
      { qty: 6, pricePerProductUsd: 30, contentPerProduct: 100 },
      { qty: 1, pricePerProductUsd: 15, contentPerProduct: 9 },
      { qty: 0.3, pricePerProductUsd: 15, contentPerProduct: 9 },
      { qty: 0.5, pricePerProductUsd: 20, contentPerProduct: 15 },
      { qty: 1, pricePerProductUsd: 15, contentPerProduct: 15 },
      { qty: 0.5, pricePerProductUsd: 20, contentPerProduct: 15 },
      { qty: 0.3, pricePerProductUsd: 9, contentPerProduct: 10 },
      { qty: 1, pricePerProductUsd: 15, contentPerProduct: 100 },
    ]);
    expect(result.suppliesCost).toBeCloseTo(8.72, 2);
    expect(result.timeCost).toBeCloseTo(14.42, 1);
    expect(result.fixedShare).toBeCloseTo(6.35, 1);
    expect(result.marginPct).toBe(30);
    expect(result.finalPrice).toBe(40);
    expect(result.marginEarned).toBeCloseTo(10.51, 1);
  });

  it("rounds the final price up to the tens", () => {
    const result = quotePrice(PRICING, 30, [{ qty: 1, pricePerProductUsd: 1, contentPerProduct: 1 }]);
    expect(result.finalPrice % 10).toBe(0);
    expect(result.finalPrice).toBeGreaterThanOrEqual(result.withMargin);
    expect(result.marginEarned).toBeCloseTo(result.finalPrice - result.subtotal, 5);
  });

  it("charges no supply cost when a product has no content data", () => {
    const result = quotePrice(PRICING, 30, [{ qty: 2, pricePerProductUsd: 10, contentPerProduct: 0 }]);
    expect(result.suppliesCost).toBe(0);
  });
});
