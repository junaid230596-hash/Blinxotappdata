// India GST helpers: state codes, GSTIN validation (format + check character), tax split and amount in words.

export const STATES: Record<string, string> = {
  "01": "Jammu & Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand", "06": "Haryana", "07": "Delhi", "08": "Rajasthan",
  "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura", "17": "Meghalaya",
  "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat", "26": "Dadra & Nagar Haveli and Daman & Diu",
  "27": "Maharashtra", "29": "Karnataka", "30": "Goa", "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry", "35": "Andaman & Nicobar Islands",
  "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh",
};
export const STATE_CODES = Object.keys(STATES) as [string, ...string[]];
export const stateName = (code?: string | null) => (code ? STATES[code] ?? null : null);

const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** The 15th character of a GSTIN is a checksum over the first 14 (base-36, alternating weights 1 and 2). */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) { const p = CHARS.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2); sum += Math.floor(p / 36) + (p % 36); }
  return CHARS[(36 - (sum % 36)) % 36];
}
export function validGstin(g: string): boolean {
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g) && g[0] + g[1] in STATES && gstinCheckChar(g.slice(0, 14)) === g[14];
}

/** Splits a line's tax. Registered seller: same state -> CGST + SGST (half each, odd paisa to SGST); other state -> IGST. Unregistered: no split. */
export function splitTax(taxCents: number, mode: "intra" | "inter" | "none") {
  if (mode === "intra") { const cgst = Math.floor(taxCents / 2); return { cgst, sgst: taxCents - cgst, igst: 0 }; }
  if (mode === "inter") return { cgst: 0, sgst: 0, igst: taxCents };
  return { cgst: 0, sgst: 0, igst: 0 };
}

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
const below100 = (n: number) => (n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? " " + ONES[n % 10] : ""));
const below1000 = (n: number) => (n >= 100 ? ONES[Math.floor(n / 100)] + " Hundred" + (n % 100 ? " " + below100(n % 100) : "") : below100(n));
/** Indian numbering (lakh, crore): 123456.50 -> "Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Fifty Paise Only". */
export function amountInWords(amount: number): string {
  const cents = Math.round(amount * 100); let rupees = Math.floor(cents / 100); const paise = cents % 100;
  if (rupees === 0 && paise === 0) return "Rupees Zero Only";
  const parts: string[] = [];
  for (const [div, name] of [[10_000_000, "Crore"], [100_000, "Lakh"], [1000, "Thousand"]] as const) {
    const q = Math.floor(rupees / div); if (q) parts.push(below1000(q) + " " + name); rupees %= div;
  }
  if (rupees) parts.push(below1000(rupees));
  const r = parts.join(" ");
  return `Rupees ${r || "Zero"}${paise ? ` and ${below100(paise)} Paise` : ""} Only`;
}
