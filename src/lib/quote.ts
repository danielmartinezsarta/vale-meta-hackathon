// HACK-003: pure price math. Reads nothing, touches no database.
// All money is USD. Inputs come from the invented seed; see seed-data.json.
export interface PricingConfig {
  goalMonthlyUsd: number;
  workDaysPerWeek: number;
  workHoursPerDay: number;
  marginPct: number;
  fixedMonthlyUsd: number;
}

/** Workable minutes in a month, derived from the schedule: nothing is hardcoded. */
export function workableMinutesPerMonth(pricing: PricingConfig): number {
  const weeksPerYear = 52;
  const monthsPerYear = 12;
  return (pricing.workDaysPerWeek * pricing.workHoursPerDay * 60 * weeksPerYear) / monthsPerYear;
}

export interface QuoteSupply {
  qty: number;
  pricePerProductUsd: number;
  contentPerProduct: number;
}

export interface QuoteBreakdown {
  suppliesCost: number;
  timeCost: number;
  fixedShare: number;
  subtotal: number;
  marginPct: number;
  withMargin: number;
  finalPrice: number;
  marginEarned: number;
}

/**
 * total = supplies + minutes x rate + fixed share; then margin.
 * The rate and the fixed share are proportional to the workable
 * minutes of the month. The final price rounds up to the tens and
 * the rounding difference adds to the goal (margin_earned).
 */
export function quotePrice(
  pricing: PricingConfig,
  minutes: number,
  supplies: QuoteSupply[],
): QuoteBreakdown {
  const workable = workableMinutesPerMonth(pricing);
  const ratePerMinute = pricing.goalMonthlyUsd / workable;
  const timeCost = minutes * ratePerMinute;
  const fixedShare = (pricing.fixedMonthlyUsd * minutes) / workable;
  let suppliesCost = 0;
  for (const supply of supplies) {
    if (supply.contentPerProduct > 0) {
      suppliesCost += (supply.qty * supply.pricePerProductUsd) / supply.contentPerProduct;
    }
  }
  const subtotal = suppliesCost + timeCost + fixedShare;
  const withMargin = subtotal * (1 + pricing.marginPct / 100);
  const finalPrice = Math.ceil(withMargin / 10) * 10;
  return {
    suppliesCost,
    timeCost,
    fixedShare,
    subtotal,
    marginPct: pricing.marginPct,
    withMargin,
    finalPrice,
    marginEarned: finalPrice - subtotal,
  };
}

/** Two decimals for the parts, no decimals for the rounded final price. */
export function money(value: number): string {
  return value.toFixed(2);
}
