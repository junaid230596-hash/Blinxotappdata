import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api as _api, pool, registerUser, resetDb } from "./helpers.js";
import { addEmployee, addProduct, setup } from "./factory.js";

const api = _api;
beforeAll(resetDb);
afterAll(() => pool.end());

const find = (u: any, q: string, extra = "") => api().get(`/api/search?q=${encodeURIComponent(q)}${extra}`).set(u.auth);

describe("global search", () => {
  it("validates input and requires sign-in", async () => {
    const u = await registerUser("individual");
    await api().get("/api/search?q=abc").expect(401);
    await find(u, "a").expect(400);
    await find(u, "abc", "&types=nonsense").expect(400);
    await find(u, "abc", "&limit=99").expect(400);
    await find(u, "abc", "&businessId=nope").expect(400);
  });

  it("searches business data by permission and never leaks across tenants", async () => {
    const tag = `zx${Date.now()}`;
    const a = await setup(`Alpha ${tag}`); const b = await setup(`Beta ${tag}`); const emp = await addEmployee(a, `Worker ${tag}`);
    const prod = await addProduct(a, { name: `Widget ${tag}`, sku: `SKU-${tag}`, openingStock: 5 });
    await api().post(`${a.base}/customers`).set(a.owner.auth).send({ name: `Customer ${tag}`, email: `c-${tag}@example.com` }).expect(201);
    await api().post(`${a.base}/suppliers`).set(a.owner.auth).send({ name: `Supplier ${tag}` }).expect(201);
    const cust = (await api().get(`${a.base}/customers?q=${tag}`).set(a.owner.auth)).body.customers[0];
    const ord = (await api().post(`${a.base}/orders`).set(a.owner.auth).send({ customerId: cust.id, items: [{ productId: prod.id, quantity: 1 }] }).expect(201)).body.order;
    await addProduct(b, { name: `Widget ${tag} (Beta's)`, sku: `BETA-${tag}` });

    const owner = (await find(a.owner, tag, `&businessId=${a.id}`).expect(200)).body;
    expect(Object.keys(owner.results).sort()).toEqual(["business", "customer", "employee", "order", "product", "supplier"]);   // the order matches via its customer's name
    expect(owner.results.product.map((x: any) => x.id)).toEqual([prod.id]);                         // Beta's identically named product is invisible
    expect(owner.results.employee[0]).toMatchObject({ id: emp.employeeId });
    const byOrder = (await find(a.owner, ord.orderNumber, `&businessId=${a.id}&types=order`).expect(200)).body;
    expect(byOrder.results.order[0]).toMatchObject({ id: ord.id, title: ord.orderNumber, subtitle: cust.name });
    expect((await find(a.owner, `Customer ${tag}`, `&businessId=${a.id}&types=order`)).body.results.order[0].id).toBe(ord.id);   // matches by customer name too

    const staff = (await find(emp, tag, `&businessId=${a.id}`).expect(200)).body;                  // Employee role: products.view only
    expect(Object.keys(staff.results).sort()).toEqual(["business", "product"]);
    expect(staff.results.product).toHaveLength(1);

    await find(b.owner, tag, `&businessId=${a.id}`).expect(404);                                   // not a member: learns nothing
    const bOnly = (await find(b.owner, tag, `&businessId=${b.id}`).expect(200)).body;
    expect(JSON.stringify(bOnly)).not.toContain(prod.id); expect(JSON.stringify(bOnly)).not.toContain(`SKU-${tag}`);
    const noBiz = (await find(a.owner, tag).expect(200)).body;
    expect(Object.keys(noBiz.results)).toEqual(["business"]);                                      // scoped types need a businessId
    expect((await find(a.owner, tag, `&businessId=${a.id}&types=customer,employee&limit=1`)).body.total).toBe(2);
  });

  it("only exposes public, opt-in, live records in the public types", async () => {
    const tag = `pub${Date.now()}`;
    const biz = await setup(`Open ${tag}`); const priv = await setup(`Closed ${tag}`);
    await api().patch(`${priv.base}`).set(priv.owner.auth).send({ isPublic: false }).expect(200);
    await addProduct(biz, { name: `Listed ${tag}`, isListed: true }); await addProduct(biz, { name: `Unlisted ${tag}` });
    const job = (await api().post(`${biz.base}/jobs`).set(biz.owner.auth).send({ title: `Job ${tag}`, description: "d", workType: "full_time" }).expect(201)).body.job;
    const person = await registerUser("individual");
    await api().patch("/api/me/profile").set(person.auth).send({ headline: `Plumber ${tag}`, isPublic: true }).expect(200);
    const hidden = await registerUser("individual");
    await api().patch("/api/me/profile").set(hidden.auth).send({ headline: `Secret ${tag}` }).expect(200);
    const viewer = await registerUser("individual");

    let r = (await find(viewer, tag).expect(200)).body.results;
    expect(r.business.map((x: any) => x.title)).toEqual([`Open ${tag}`]);                          // private business excluded
    expect(r.marketplace_product.map((x: any) => x.title)).toEqual([`Listed ${tag}`]);            // unlisted product excluded
    expect(r.individual.map((x: any) => x.subtitle)).toEqual([`Plumber ${tag}`]);                 // non-public profile excluded
    expect(r.job).toBeUndefined();                                                                 // drafts are not searchable
    await api().patch(`${biz.base}/jobs/${job.id}`).set(biz.owner.auth).send({ status: "open" }).expect(200);
    r = (await find(viewer, tag, "&types=job").expect(200)).body.results;
    expect(r.job[0]).toMatchObject({ id: job.id, subtitle: `Open ${tag}` });
    expect(JSON.stringify((await find(viewer, tag).expect(200)).body)).not.toContain(person.email);   // no contact details
    await api().put("/api/me/skills").set(person.auth).send({ skills: [`Plumbing${tag}`] }).expect(200);
    expect((await find(viewer, `Plumbing${tag}`, "&types=individual").expect(200)).body.total).toBe(1);   // matches by skill
  });

  it("treats LIKE wildcards literally", async () => {
    const u = await registerUser("individual");
    expect((await find(u, "%%").expect(200)).body.total).toBe(0);
    expect((await find(u, "__").expect(200)).body.total).toBe(0);
  });
});
