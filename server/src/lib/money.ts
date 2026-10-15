// Order math in integer cents so totals never drift.
export const toCents = (n: number | string) => Math.round(Number(n) * 100);
export const fromCents = (c: number) => c / 100;

export function lineTotals(qty: number, unitPrice: number, taxRate: number) {
  const sub = Math.round(qty * toCents(unitPrice));
  const tax = Math.round((sub * taxRate) / 100);
  return { subtotal: sub, tax, total: sub + tax };
}
