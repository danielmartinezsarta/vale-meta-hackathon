// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  quotePrice,
  weekdayCountOfMonth,
  workableMinutesPerMonth,
  type PricingConfig,
} from "./quote";

// Invented pricing block from the seed: 2500 USD goal, Mon-Fri 9-17,
// 30% margin, 800 + 150 + 80 + 70 monthly fixed.
const PRICING: PricingConfig = {
  goalMonthlyUsd: 2500,
  workDaysPerWeek: 5,
  workHoursPerDay: 8,
  marginPct: 30,
  fixedMonthlyUsd: 1100,
};

// Hand-computed reference: October 2026 holds 22 weekday days,
// so the workable month is 22 x 8 x 60 = 10560 minutes.
const OCTOBER = new Date(2026, 9, 15);

describe("workable month", () => {
  it("counts 22 weekday days in October 2026", () => {
    expect(weekdayCountOfMonth(OCTOBER)).toBe(22);
    expect(workableMinutesPerMonth(PRICING, OCTOBER)).toBe(10560);
  });
});

describe("quote math", () => {
  it("prices the semipermanente recipe at 40 USD", () => {
    const result = quotePrice(
      PRICING,
      60,
      [
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
      ],
      OCTOBER,
    );
    expect(result.suppliesCost).toBeCloseTo(8.72, 2);
    expect(result.timeCost).toBeCloseTo(14.2, 1);
    expect(result.fixedShare).toBeCloseTo(6.25, 2);
    expect(result.marginPct).toBe(30);
    expect(result.finalPrice).toBe(40);
    expect(result.marginEarned).toBeCloseTo(10.83, 1);
  });

  it("matches four more hand-computed full recipes", () => {
    const cases: [number, { qty: number; pricePerProductUsd: number; contentPerProduct: number }[], number, number][] = [
      // Gel refill, 75 minutes: supplies 8.99 + time 17.76 + fixed 7.81 = 34.55 x 1.3 -> 50.
      [
        75,
        [
          { qty: 1, pricePerProductUsd: 1, contentPerProduct: 1 },
          { qty: 1, pricePerProductUsd: 1, contentPerProduct: 1 },
          { qty: 6, pricePerProductUsd: 30, contentPerProduct: 100 },
          { qty: 1, pricePerProductUsd: 15, contentPerProduct: 9 },
          { qty: 0.3, pricePerProductUsd: 15, contentPerProduct: 9 },
          { qty: 0.7, pricePerProductUsd: 20, contentPerProduct: 15 },
          { qty: 1, pricePerProductUsd: 15, contentPerProduct: 15 },
          { qty: 0.5, pricePerProductUsd: 20, contentPerProduct: 15 },
          { qty: 0.3, pricePerProductUsd: 9, contentPerProduct: 10 },
          { qty: 1, pricePerProductUsd: 15, contentPerProduct: 100 },
        ],
        50,
        15.45,
      ],
      // Acrylic full set, 120 minutes: 16.07 + 28.41 + 12.50 = 56.98 x 1.3 -> 80.
      [
        120,
        [
          { qty: 2, pricePerProductUsd: 1, contentPerProduct: 1 },
          { qty: 1, pricePerProductUsd: 1, contentPerProduct: 1 },
          { qty: 10, pricePerProductUsd: 35, contentPerProduct: 100 },
          { qty: 8, pricePerProductUsd: 30, contentPerProduct: 100 },
          { qty: 1.5, pricePerProductUsd: 15, contentPerProduct: 9 },
          { qty: 0.5, pricePerProductUsd: 15, contentPerProduct: 9 },
          { qty: 6, pricePerProductUsd: 30, contentPerProduct: 120 },
          { qty: 5, pricePerProductUsd: 40, contentPerProduct: 250 },
          { qty: 0.7, pricePerProductUsd: 20, contentPerProduct: 15 },
          { qty: 0.5, pricePerProductUsd: 9, contentPerProduct: 10 },
          { qty: 1, pricePerProductUsd: 15, contentPerProduct: 100 },
        ],
        80,
        23.02,
      ],
      // Nail art, 30 minutes: 8.38 + 7.10 + 3.13 = 18.61 x 1.3 -> 30.
      [
        30,
        [
          { qty: 0.4, pricePerProductUsd: 25, contentPerProduct: 9 },
          { qty: 10, pricePerProductUsd: 60, contentPerProduct: 100 },
          { qty: 0.5, pricePerProductUsd: 20, contentPerProduct: 15 },
          { qty: 2, pricePerProductUsd: 30, contentPerProduct: 100 },
        ],
        30,
        11.39,
      ],
      // Spa pedicure, 60 minutes: 11.55 + 14.20 + 6.25 = 32.00 x 1.3 -> 50.
      [
        60,
        [
          { qty: 20, pricePerProductUsd: 45, contentPerProduct: 250 },
          { qty: 3, pricePerProductUsd: 25, contentPerProduct: 250 },
          { qty: 15, pricePerProductUsd: 45, contentPerProduct: 250 },
          { qty: 8, pricePerProductUsd: 25, contentPerProduct: 250 },
          { qty: 1, pricePerProductUsd: 1, contentPerProduct: 1 },
          { qty: 1, pricePerProductUsd: 1, contentPerProduct: 1 },
          { qty: 1, pricePerProductUsd: 12, contentPerProduct: 15 },
          { qty: 6, pricePerProductUsd: 20, contentPerProduct: 100 },
          { qty: 1, pricePerProductUsd: 15, contentPerProduct: 100 },
        ],
        50,
        18.0,
      ],
    ];
    for (const [minutes, supplies, final, earned] of cases) {
      const result = quotePrice(PRICING, minutes, supplies, OCTOBER);
      expect(result.finalPrice).toBe(final);
      expect(result.marginEarned).toBeCloseTo(earned, 1);
    }
  });

  it("rounds the final price up to the tens", () => {
    const result = quotePrice(PRICING, 30, [{ qty: 1, pricePerProductUsd: 1, contentPerProduct: 1 }], OCTOBER);
    expect(result.finalPrice % 10).toBe(0);
    expect(result.finalPrice).toBeGreaterThanOrEqual(result.withMargin);
    expect(result.marginEarned).toBeCloseTo(result.finalPrice - result.subtotal, 5);
  });

  it("charges no supply cost when a product has no content data", () => {
    const result = quotePrice(PRICING, 30, [{ qty: 2, pricePerProductUsd: 10, contentPerProduct: 0 }], OCTOBER);
    expect(result.suppliesCost).toBe(0);
  });
});
