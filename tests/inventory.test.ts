import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, pool, resetDb } from "./helpers.js";
import { addEmployee, addProduct, setup, stockOf } from "./factory.js";

beforeAll(resetDb);
afterAll(() => pool.end());

async function assertLedgerConsistent(businessId: string) {
  // stock_qty must always equal the sum of movements, and balance_after must chain correctly.
  const { rows } = await pool.query(
    `SELECT p.id, p.stock_qty, COALESCE(sum(m.quantity_delta),0) AS s FROM products p
       LEFT JOIN inventory_movements m ON m.product_id=p.id WHERE p.business_id=$1 GROUP BY p.id`, [businessId]);
  for (const r of rows) expect(Number(r.stock_qty)).toBe(Number(r.s));
  const { rows: chain } = await pool.query(
    `SELECT balance_after, sum(quantity_delta) OVER (PARTITION BY product_id ORDER BY id) AS running FROM inventory_movements WHERE business_id=$1`, [businessId]);
  for (const r of chain) expect(Number(r.balance_after)).toBe(Number(r.running));
}

describe("products & categories", () => {
  it("creates with opening stock (traceable), rejects duplicate SKU/barcode and bad images", async () => {
    const c = await setup();
    const p = await addProduct(c, { sku: "ABC-1", barcode: "8901", openingStock: 25, unit: "kg" });
    expect(p).toMatchObject({ stockQty: 25, unit: "kg", costPrice: 60, lowStock: false });
    const m = await api().get(`${c.base}/inventory/movements?productId=${p.id}`).set(c.owner.auth).expect(200);
    expect(m.body.movements).toHaveLength(1);
    expect(m.body.movements[0]).toMatchObject({ type: "opening", quantityDelta: 25, balanceAfter: 25 });
    await api().post(`${c.base}/products`).set(c.owner.auth).send({ name: "Dup", sku: "ABC-1" }).expect(409);
    const dupBarcode = await api().post(`${c.base}/products`).set(c.owner.auth).send({ name: "Dup", sku: "ZZ", barcode: "8901" }).expect(409);
    expect(dupBarcode.body.error.message).toMatch(/barcode/);
    await api().post(`${c.base}/products`).set(c.owner.auth).send({ name: "Img", sku: "IMG", images: ["https://evil.example/a.png"] }).expect(400);
    await api().post(`${c.base}/products`).set(c.owner.auth).send({ name: "Neg", sku: "NEG", sellingPrice: -5 }).expect(400);
    // the same SKU is fine in another business
    const other = await setup();
    await api().post(`${other.base}/products`).set(other.owner.auth).send({ name: "Same", sku: "ABC-1" }).expect(201);
    await assertLedgerConsistent(c.id);
  });

  it("cannot change stock through PATCH; searches, filters, sorts and paginates", async () => {
    const c = await setup();
    const cat = (await api().post(`${c.base}/categories`).set(c.owner.auth).send({ name: "Drinks" }).expect(201)).body.category;
    await api().post(`${c.base}/categories`).set(c.owner.auth).send({ name: "drinks" }).expect(409); // case-insensitive unique
    const a = await addProduct(c, { name: "Cola", sku: "C1", categoryId: cat.id, sellingPrice: 30, openingStock: 3, minStock: 5 });
    const b = await addProduct(c, { name: "Water", sku: "W1", barcode: "BC-77", sellingPrice: 10, openingStock: 50 });
    await addProduct(c, { name: "Chips", sku: "H1", sellingPrice: 20 });
    await api().patch(`${c.base}/products/${a.id}`).set(c.owner.auth).send({ stockQty: 9999 }).expect(400); // unknown field stripped -> nothing to update
    expect(await stockOf(c, a.id)).toBe(3);
    expect((await api().get(`${c.base}/products?q=bc-77`).set(c.owner.auth)).body.products.map((x: any) => x.id)).toEqual([b.id]);
    expect((await api().get(`${c.base}/products?categoryId=${cat.id}`).set(c.owner.auth)).body.total).toBe(1);
    expect((await api().get(`${c.base}/products?lowStock=true`).set(c.owner.auth)).body.products.map((x: any) => x.name)).toContain("Cola");
    const sorted = await api().get(`${c.base}/products?sort=price&dir=desc&limit=2`).set(c.owner.auth).expect(200);
    expect(sorted.body.products.map((x: any) => x.name)).toEqual(["Cola", "Chips"]); expect(sorted.body.total).toBe(3);
    expect((await api().get(`${c.base}/products?q=%25`).set(c.owner.auth)).body.total).toBe(0); // % is literal, not a wildcard
    const upd = await api().patch(`${c.base}/products/${a.id}`).set(c.owner.auth).send({ sellingPrice: 35, isListed: true }).expect(200);
    expect(upd.body.product).toMatchObject({ sellingPrice: 35, isListed: true });
    const cats = (await api().get(`${c.base}/categories`).set(c.owner.auth)).body.categories;
    expect(cats[0]).toMatchObject({ name: "Drinks", productCount: 1 });
  });

  it("isolates tenants, protects cost data and enforces permissions", async () => {
    const a = await setup(); const b = await setup(); const emp = await addEmployee(a);
    const p = await addProduct(a, { openingStock: 5 });
    const cat = (await api().post(`${b.base}/categories`).set(b.owner.auth).send({ name: "Theirs" }).expect(201)).body.category;
    await api().get(`${b.base}/products/${p.id}`).set(b.owner.auth).expect(404);
    await api().patch(`${b.base}/products/${p.id}`).set(b.owner.auth).send({ name: "x" }).expect(404);
    await api().post(`${b.base}/inventory/stock-in`).set(b.owner.auth).send({ productId: p.id, quantity: 1 }).expect(404);
    await api().patch(`${a.base}/products/${p.id}`).set(a.owner.auth).send({ categoryId: cat.id }).expect(400); // foreign category
    const seen = await api().get(`${a.base}/products/${p.id}`).set(emp.auth).expect(200);
    expect(seen.body.product.costPrice).toBeUndefined(); expect(seen.body.product.sellingPrice).toBe(100);
    expect((await api().get(`${a.base}/products`).set(emp.auth)).body.products[0].costPrice).toBeUndefined();
    await api().post(`${a.base}/products`).set(emp.auth).send({ name: "N", sku: "N" }).expect(403);
    await api().post(`${a.base}/inventory/stock-in`).set(emp.auth).send({ productId: p.id, quantity: 1 }).expect(403);
    await api().get(`${a.base}/inventory/valuation`).set(emp.auth).expect(403);
    await api().get(`${a.base}/inventory/movements`).set(emp.auth).expect(200);
    await api().delete(`${a.base}/products/${p.id}`).set(a.owner.auth).expect(200);
    expect((await api().get(`${a.base}/products/${p.id}`).set(a.owner.auth)).body.product.status).toBe("inactive");
  });
});

describe("inventory movements", () => {
  it("stock in/out/damaged/adjust update stock and leave a complete trail", async () => {
    const c = await setup(); const p = await addProduct(c, { costPrice: 10, openingStock: 10 });
    await api().post(`${c.base}/inventory/stock-in`).set(c.owner.auth).send({ productId: p.id, quantity: 10, unitCost: 20, note: "Top-up" }).expect(201);
    expect((await api().get(`${c.base}/products/${p.id}`).set(c.owner.auth)).body.product).toMatchObject({ stockQty: 20, costPrice: 15 }); // weighted average
    await api().post(`${c.base}/inventory/stock-out`).set(c.owner.auth).send({ productId: p.id, quantity: 5, note: "Sample" }).expect(201);
    await api().post(`${c.base}/inventory/damaged`).set(c.owner.auth).send({ productId: p.id, quantity: 2, note: "Dropped" }).expect(201);
    await api().post(`${c.base}/inventory/adjust`).set(c.owner.auth).send({ productId: p.id, newQuantity: 10, reason: "Cycle count" }).expect(200);
    expect(await stockOf(c, p.id)).toBe(10);
    const same = await api().post(`${c.base}/inventory/adjust`).set(c.owner.auth).send({ productId: p.id, newQuantity: 10, reason: "Recount" }).expect(200);
    expect(same.body.result.unchanged).toBe(true);
    await api().post(`${c.base}/inventory/adjust`).set(c.owner.auth).send({ productId: p.id, newQuantity: 10, reason: "x" }).expect(400); // reason required
    const m = (await api().get(`${c.base}/inventory/movements?productId=${p.id}`).set(c.owner.auth)).body;
    expect(m.movements.map((x: any) => [x.type, x.quantityDelta])).toEqual([["adjustment", -3], ["damaged", -2], ["stock_out", -5], ["stock_in", 10], ["opening", 10]]);
    expect(m.movements[0]).toMatchObject({ note: "Cycle count", actorName: "Test User", balanceAfter: 10 });
    expect((await api().get(`${c.base}/inventory/movements?type=damaged`).set(c.owner.auth)).body.total).toBe(1);
    await assertLedgerConsistent(c.id);
  });

  it("never lets stock go negative, even under concurrent withdrawals", async () => {
    const c = await setup(); const p = await addProduct(c, { openingStock: 5 });
    await api().post(`${c.base}/inventory/stock-out`).set(c.owner.auth).send({ productId: p.id, quantity: 6 }).expect(409);
    expect(await stockOf(c, p.id)).toBe(5);
    const rs = await Promise.all(Array.from({ length: 10 }, () => api().post(`${c.base}/inventory/stock-out`).set(c.owner.auth).send({ productId: p.id, quantity: 1 })));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(5);
    expect(rs.filter((r) => r.status === 409).every((r) => r.body.error.code === "INSUFFICIENT_STOCK")).toBe(true);
    expect(await stockOf(c, p.id)).toBe(0);
    await assertLedgerConsistent(c.id);
  });

  it("keeps fractional quantities exact", async () => {
    const c = await setup(); const p = await addProduct(c, { unit: "kg" });
    for (let i = 0; i < 3; i++) await api().post(`${c.base}/inventory/stock-in`).set(c.owner.auth).send({ productId: p.id, quantity: 0.1 }).expect(201);
    expect(await stockOf(c, p.id)).toBe(0.3);
    await api().post(`${c.base}/inventory/stock-out`).set(c.owner.auth).send({ productId: p.id, quantity: 0.3 }).expect(201);
    expect(await stockOf(c, p.id)).toBe(0);
  });

  it("alerts stock managers once per downward crossing; lists low stock; values inventory", async () => {
    const c = await setup(); const emp = await addEmployee(c);
    const p = await addProduct(c, { name: "Alert Me", openingStock: 10, minStock: 5, costPrice: 4, sellingPrice: 9 });
    const out = (q: number) => api().post(`${c.base}/inventory/stock-out`).set(c.owner.auth).send({ productId: p.id, quantity: q }).expect(201);
    const alerts = async (auth: any) => (await api().get("/api/notifications").set(auth)).body.notifications.filter((n: any) => n.type === "inventory.low_stock");
    await out(4);                                          // 6 left: above minimum
    expect(await alerts(c.owner.auth)).toHaveLength(0);
    await out(2);                                          // 4 left: crossed
    expect(await alerts(c.owner.auth)).toHaveLength(1);
    await out(1);                                          // still low: no second alert
    expect(await alerts(c.owner.auth)).toHaveLength(1);
    expect(await alerts(emp.auth)).toHaveLength(0);        // employees lack inventory.manage
    await api().post(`${c.base}/inventory/stock-in`).set(c.owner.auth).send({ productId: p.id, quantity: 20 }).expect(201);
    await out(18);                                         // crosses again after recovery
    expect(await alerts(c.owner.auth)).toHaveLength(2);
    const low = (await api().get(`${c.base}/inventory/low-stock`).set(c.owner.auth)).body.products;
    expect(low.map((x: any) => x.name)).toContain("Alert Me");
    const val = (await api().get(`${c.base}/inventory/valuation`).set(c.owner.auth)).body;
    expect(val.totalCostValue).toBe(5 * 4); expect(val.totalRetailValue).toBe(5 * 9); // 10-4-2-1+20-18 = 5 units left
  });
});
