// Shopping cart for individuals. One seller per cart (an order is placed with a single business).
// Stored in this browser only; prices shown here are estimates, the server re-prices every order from the seller's catalogue.
import { useSyncExternalStore } from "react";

export interface CartLine { productId: string; name: string; price: number; taxRate: number; unit: string; image: string | null; qty: number }
export interface Cart { businessId: string | null; businessName: string; businessSlug: string; lines: CartLine[] }

const KEY = "bx_cart_v1";
const EMPTY: Cart = { businessId: null, businessName: "", businessSlug: "", lines: [] };

function read(): Cart {
  try {
    const c = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (c && typeof c === "object" && Array.isArray(c.lines) && c.lines.every((l: any) => typeof l?.productId === "string" && Number.isFinite(l.qty) && l.qty > 0)) return c;
  } catch { /* corrupt or unavailable storage: start empty */ }
  return EMPTY;
}
let cart: Cart = read();
const listeners = new Set<() => void>();
function save(next: Cart) {
  cart = next.lines.length ? next : EMPTY;
  try { localStorage.setItem(KEY, JSON.stringify(cart)); } catch { /* private mode: the cart still works for this tab */ }
  listeners.forEach((l) => l());
}
if (typeof window !== "undefined") window.addEventListener("storage", (e) => { if (e.key === KEY) { cart = read(); listeners.forEach((l) => l()); } });

export const useCart = () => useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => cart, () => cart);
export const cartCount = (c: Cart) => c.lines.length;
export const cartTotals = (c: Cart) => {
  const sub = c.lines.reduce((s, l) => s + Math.round(l.price * 100) * l.qty, 0) / 100;
  const tax = c.lines.reduce((s, l) => s + Math.round(l.price * 100 * l.qty * l.taxRate / 100), 0) / 100;
  return { subtotal: sub, tax, total: sub + tax };
};

export type AddResult = "added" | "other-seller";
/** Adds a product. If the cart holds another seller's items nothing changes and "other-seller" is returned so the UI can ask. */
export function addToCart(biz: { id: string; name: string; slug: string }, p: Omit<CartLine, "qty">, qty = 1, replace = false): AddResult {
  const base = replace || cart.businessId === null || cart.businessId === biz.id ? (replace ? EMPTY : cart) : null;
  if (!base) return "other-seller";
  const lines = [...base.lines]; const i = lines.findIndex((l) => l.productId === p.productId);
  if (i >= 0) lines[i] = { ...lines[i], ...p, qty: Math.min(10_000, lines[i].qty + qty) }; else lines.push({ ...p, qty });
  save({ businessId: biz.id, businessName: biz.name, businessSlug: biz.slug, lines });
  return "added";
}
export const setQty = (productId: string, qty: number) => save({ ...cart, lines: cart.lines.map((l) => (l.productId === productId ? { ...l, qty: Math.max(0.001, Math.min(10_000, qty)) } : l)) });
export const removeLine = (productId: string) => save({ ...cart, lines: cart.lines.filter((l) => l.productId !== productId) });
export const clearCart = () => save(EMPTY);
