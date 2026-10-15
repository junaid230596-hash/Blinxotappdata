export const money = (n: number | string | null | undefined, currency = "INR") =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 2 }).format(Number(n ?? 0));
export const num = (n: number | string | null | undefined) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 }).format(Number(n ?? 0));
export const date = (d: string | Date | null | undefined) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—");
export const dateTime = (d: string | Date | null | undefined) =>
  d ? new Date(d).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
export const hm = (minutes: number) => `${Math.floor(minutes / 60)}h ${String(Math.round(minutes % 60)).padStart(2, "0")}m`;
export const label = (s: string) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
export const pct = (cur: number, prev: number) => (prev ? Math.round(((cur - prev) / prev) * 100) : null);
