import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../server/src/db.js";
import { clearCart } from "../src/lib/cart";
import { renderApp, resetDb, seedBusiness, seedUser, startServer, stopServer } from "./harness";

beforeAll(async () => { await startServer(); await resetDb(); });
afterAll(stopServer);
beforeEach(() => { clearCart(); localStorage.clear(); });

async function seller(name: string, product = "Copper Kettle", price = 500) {
  const b = await seedBusiness(name);
  const p = (await b.owner.s.req("POST", `${b.base}/products`, { name: product, sku: `K-${Date.now()}-${Math.random()}`, sellingPrice: price, taxRate: 18, openingStock: 5 })).product;
  await pool.query("UPDATE products SET is_listed=true WHERE id=$1", [p.id]);
  return { b, p };
}
async function audit(label: string) {
  const r = await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } }, resultTypes: ["violations"] });
  expect(r.violations, `${label}\n${r.violations.map((v) => `${v.id}: ${v.help} -> ${v.nodes[0]?.html.slice(0, 120)}`).join("\n")}`).toEqual([]);
}

describe("individual shopping", () => {
  it("browses the shop, builds a cart, places an order, sees it, and cancels while pending", async () => {
    const { b, p } = await seller("Kettle House"); const buyer = await seedUser("individual", "Meera Shah");
    const user = userEvent.setup(); const a = renderApp("/app/shop", buyer.s);
    expect(await screen.findByRole("heading", { level: 1, name: "Shop" })).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Add to cart" }));
    await user.click(screen.getByRole("link", { name: /Cart \(1\)/ }));
    expect(await screen.findByRole("heading", { level: 1, name: "Cart" })).toBeInTheDocument();
    expect(screen.getByText("Items from Kettle House")).toBeInTheDocument();
    expect(screen.getByText(/₹590\.00/)).toBeInTheDocument();                              // 500 + 18% tax estimate
    const qty = screen.getByLabelText("Quantity of Copper Kettle"); await user.clear(qty); await user.type(qty, "2");
    expect(await screen.findByText(/₹1,180\.00/)).toBeInTheDocument();
    await audit("cart");

    await user.click(screen.getByRole("button", { name: "Place order" }));
    expect(await screen.findByText(/Validation failed|address/i)).toBeInTheDocument();       // server validation shown, nothing created
    await user.type(screen.getByLabelText(/Delivery address/), "12 Lake Road, Udaipur 313001");
    await user.type(screen.getByLabelText("Phone number"), "+91 98290 12345");
    await user.click(screen.getByRole("button", { name: "Place order" }));

    expect(await screen.findByRole("heading", { level: 1, name: /ORD-/ })).toBeInTheDocument();
    expect(screen.getByText("Pending", { selector: ".badge" })).toBeInTheDocument();
    expect(screen.getByText("12 Lake Road, Udaipur 313001")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("bx_cart_v1") ?? "{\"lines\":[]}").lines).toEqual([]);                                  // cart emptied after ordering
    await audit("my order");

    const order = (await b.owner.s.req("GET", `${b.base}/orders`)).orders[0];
    expect(order).toMatchObject({ buyerName: "Meera Shah", buyerType: "individual", total: 1180 });
    await user.click(screen.getByRole("button", { name: "Cancel order" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel order" }));
    expect(await screen.findByText(/This order was cancelled/)).toBeInTheDocument();
    a.unmount(); renderApp("/app/my-orders", buyer.s);
    expect(await screen.findByRole("link", { name: /ORD-/ })).toBeInTheDocument();
    void p;
  });

  it("keeps one seller per cart and asks before replacing it", async () => {
    await seller("Alpha Store", "Alpha Item"); await seller("Beta Store", "Beta Item"); const buyer = await seedUser("individual", "Tara");
    const user = userEvent.setup(); renderApp("/app/shop", buyer.s);
    const card = (name: string) => screen.findByText(name).then((el) => el.closest(".card") as HTMLElement);
    await user.click(within(await card("Alpha Item")).getByRole("button", { name: "Add to cart" }));
    await user.click(within(await card("Beta Item")).getByRole("button", { name: "Add to cart" }));
    const dlg = await screen.findByRole("dialog"); expect(dlg).toHaveTextContent(/Alpha Store/);
    await user.click(within(dlg).getByRole("button", { name: "Replace cart" }));
    await user.click(screen.getByRole("link", { name: /Cart \(1\)/ }));
    expect(await screen.findByText("Items from Beta Store")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove Beta Item" }));
    expect(await screen.findByText("Your cart is empty")).toBeInTheDocument();
  });

  it("adds to cart from a public product page, and sends visitors to log in", async () => {
    const { p } = await seller("Public Wares", "Brass Bell"); const buyer = await seedUser("individual", "Ishan");
    const user = userEvent.setup(); const guest = renderApp(`/products/${p.id}`);
    expect(await screen.findByRole("button", { name: "Log in to buy" })).toBeInTheDocument(); guest.unmount();
    renderApp(`/products/${p.id}`, buyer.s);
    await user.click(await screen.findByRole("button", { name: "Add to cart" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Cart" })).toBeInTheDocument();
    expect(screen.getByText("Brass Bell")).toBeInTheDocument();
  });

  it("is for individuals only: businesses see their own purchasing path, the menu shows Shopping only to individuals", async () => {
    const owner = await seedBusiness("Not A Shopper");
    const a = renderApp("/app/shop", owner.owner.s);
    expect(await screen.findByText("Shopping is for individual accounts")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "My orders" })).toBeNull(); a.unmount();
    const buyer = await seedUser("individual", "Nina");
    renderApp("/app", buyer.s);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    for (const l of ["Shop", "Cart", "My orders"]) expect(within(nav).getAllByRole("link", { name: l }).length).toBeGreaterThan(0);
  });

  it("shows sellers who bought: the seller's order screen names the individual and their phone", async () => {
    const { b, p } = await seller("Seller View Co"); const buyer = await seedUser("individual", "Karan Mehta");
    await buyer.s.req("POST", "/api/me/orders", { businessId: b.biz.id, items: [{ productId: p.id, quantity: 1 }], deliveryAddress: "5 Fateh Sagar Road, Udaipur", phone: "+91 90000 22222" });
    const order = (await b.owner.s.req("GET", `${b.base}/orders`)).orders[0];
    renderApp(`/app/orders/${order.id}`, b.owner.s);
    expect((await screen.findAllByText("Karan Mehta")).length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "+91 90000 22222" })).toBeInTheDocument();
    expect(screen.getByText("Individual")).toBeInTheDocument();
  });
});
