import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PASSWORD, Session, otpForBuyer, renderApp, resetDb, seedAdmin, seedBusiness, seedEmployee, seedUser, startServer, stopServer, uniqueEmail } from "./harness";

beforeAll(async () => { await startServer(); await resetDb(); });
afterAll(stopServer);

async function loginUi(email: string, route = "/app") {
  const user = userEvent.setup(); const r = renderApp(route);
  await user.type(await screen.findByLabelText("Email"), email); await user.type(screen.getByLabelText("Password"), PASSWORD);
  await user.click(screen.getByRole("button", { name: "Log in" })); return { user, ...r };
}
const nav = () => screen.findByRole("navigation", { name: "Main" }).then((n) => within(n));
const main = () => screen.findByRole("main").then((m) => within(m));
const dialog = async () => within(await screen.findByRole("dialog"));
const money = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(n);
const future = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
const pdf = () => new File(["%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n"], "contract.pdf", { type: "application/pdf" });
const sku = () => `S-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

describe("purchasing and the marketplace", () => {
  it("orders from another business, follows it through delivery with the code, receives stock and reviews the supplier", async () => {
    const tag = `Flour${Date.now()}`; const seller = await seedBusiness(`Mill ${tag}`); const buyer = await seedBusiness(`Bakery ${tag}`);
    await seller.owner.s.req("POST", `${seller.base}/products`, { name: tag, sku: sku(), sellingPrice: 40, taxRate: 5, openingStock: 20, isListed: true });
    const { product: mine } = await buyer.owner.s.req("POST", `${buyer.base}/products`, { name: "Our Flour", sku: sku() });
    const { user } = await loginUi(buyer.owner.email, "/app/marketplace");

    await user.type(await screen.findByLabelText("Search"), tag);
    await user.click(await screen.findByRole("button", { name: `Order ${tag}` }));
    expect(await screen.findByRole("heading", { name: "New purchase", level: 1 })).toBeInTheDocument();
    const qty = await screen.findByLabelText(`Quantity for ${tag}`); await user.clear(qty); await user.type(qty, "10");
    await user.click(screen.getByRole("button", { name: "Save and send" }));
    expect(await screen.findByRole("heading", { name: /PO-\d{6}/ })).toBeInTheDocument(); expect(await screen.findByText("Sent", { selector: ".badge" })).toBeInTheDocument();

    const { orders } = await seller.owner.s.req("GET", `${seller.base}/orders`); expect(orders).toHaveLength(1); expect(orders[0].buyerBusinessName).toContain("Bakery");
    for (const status of ["accepted", "processing", "ready", "dispatched"]) await seller.owner.s.req("PATCH", `${seller.base}/orders/${orders[0].id}/status`, { status });
    await seller.owner.s.req("POST", `${seller.base}/orders/${orders[0].id}/otp/verify`, { otp: await otpForBuyer(buyer.owner) });

    await user.click(await (await nav()).findByRole("link", { name: "Purchases" }));
    await user.click(await screen.findByRole("link", { name: /PO-\d{6}/ }));
    await user.click(await screen.findByRole("button", { name: "Receive stock" }));
    let d = await dialog(); await d.findByRole("option", { name: "Our Flour" }); await user.selectOptions(d.getByLabelText("Add to your product"), mine.id); await user.click(d.getByRole("button", { name: "Receive" }));
    expect(await screen.findByText("Received", { selector: ".badge" })).toBeInTheDocument();
    expect((await buyer.owner.s.req("GET", `${buyer.base}/products/${mine.id}`)).product).toMatchObject({ stockQty: 10, costPrice: 40 });

    await user.click(await screen.findByRole("button", { name: "Review supplier" }));
    d = await dialog(); await user.click(await d.findByLabelText(/5 stars/)); await user.type(d.getByLabelText(/Your experience/), "Reliable and on time."); await user.click(d.getByRole("button", { name: "Publish review" }));
    expect(await screen.findByText(/your review is published/i)).toBeInTheDocument();
    const pub = await new Session().req("GET", `/api/public/businesses/${seller.biz.slug}/reviews`); expect(pub.summary).toMatchObject({ average: 5, count: 1 }); expect(pub.reviews[0].badge).toBe("Verified buyer");
  });

  it("buys from an external supplier: add supplier, draft a purchase with your own product, send, accept, receive", async () => {
    const b = await seedBusiness(); const { product } = await b.owner.s.req("POST", `${b.base}/products`, { name: `Sugar${Date.now()}`, sku: sku(), costPrice: 15 });
    const { user } = await loginUi(b.owner.email, "/app/suppliers");
    await user.click(await screen.findByRole("button", { name: "Add supplier" })); let d = await dialog();
    await user.type(d.getByLabelText("Supplier name"), "Local Mill"); await user.type(d.getByLabelText("Phone"), "98980"); await user.click(d.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Local Mill")).toBeInTheDocument();
    await user.click(await (await main()).findByRole("link", { name: "New purchase" }));
    await user.type(await screen.findByLabelText("Find one of your products"), product.name);
    await user.click(await screen.findByRole("button", { name: `Add ${product.name}` }));
    const q = await screen.findByLabelText(`Quantity for ${product.name}`); await user.clear(q); await user.type(q, "5");
    const c = screen.getByLabelText(`Unit cost for ${product.name}`); await user.clear(c); await user.type(c, "20");
    expect(await screen.findByText(money(100))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save and send" }));
    await user.click(await screen.findByRole("button", { name: "Mark accepted by supplier" }));
    await user.click(await screen.findByRole("button", { name: "Receive stock" })); d = await dialog(); await user.click(d.getByRole("button", { name: "Receive" }));
    expect(await screen.findByText("Received", { selector: ".badge" })).toBeInTheDocument();
    expect((await b.owner.s.req("GET", `${b.base}/products/${product.id}`)).product).toMatchObject({ stockQty: 5, costPrice: 20 });
  });
});

describe("CRM", () => {
  it("adds a lead, converts it to a deal, moves it through the pipeline and logs a follow-up", async () => {
    const b = await seedBusiness(); const { user } = await loginUi(b.owner.email, "/app/crm/leads");
    await user.click(await screen.findByRole("button", { name: "Add lead" })); let d = await dialog();
    await user.type(d.getByLabelText("Name"), "Dev Patel"); await user.type(d.getByLabelText("Company"), "Patel Industries"); await user.click(d.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Dev Patel")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Convert" }));
    expect(await screen.findByText(/Created deal/)).toBeInTheDocument();
    await user.click(await (await nav()).findByRole("link", { name: "Pipeline" }));
    const stageSel = await screen.findByLabelText("Stage of Patel Industries deal"); expect(within(screen.getByRole("region", { name: "Lead" })).getByText("Patel Industries deal")).toBeInTheDocument();

    await user.click(within(stageSel.closest("article")!).getByRole("button", { name: "Activity" })); d = await dialog();
    await user.click(await d.findByRole("button", { name: "Add note, call or follow-up" })); const f = await screen.findAllByRole("dialog"); const form = within(f[f.length - 1]);
    await user.selectOptions(form.getByLabelText("Type"), "follow_up"); await user.type(form.getByLabelText("Subject"), "Send quote"); await user.type(form.getByLabelText(/^Due/), "2031-01-15T10:00"); await user.click(form.getByRole("button", { name: "Save" }));
    expect(await d.findByText("Send quote")).toBeInTheDocument();
    await user.click(d.getByRole("button", { name: "Close dialog" }));

    await user.selectOptions(await screen.findByLabelText("Stage of Patel Industries deal"), "Won");
    await waitFor(async () => expect((await b.owner.s.req("GET", `${b.base}/crm/deals`)).deals[0].status).toBe("won"));
    expect(await within(await screen.findByRole("region", { name: "Won" })).findByText("Patel Industries deal")).toBeInTheDocument();

    await user.click(await (await nav()).findByRole("link", { name: "Follow-ups" }));
    expect(await screen.findByText("Send quote")).toBeInTheDocument(); expect(screen.getByText("Patel Industries deal")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Mark done" })); await waitFor(() => expect(screen.queryByText("Send quote")).toBeNull());   // the default view shows open items only
  });
});

describe("reports", () => {
  it("shows a report, switches report, and downloads CSV and PDF", async () => {
    const b = await seedBusiness(); const { product } = await b.owner.s.req("POST", `${b.base}/products`, { name: "Report Item", sku: sku(), sellingPrice: 100, taxRate: 10, openingStock: 9, costPrice: 50 });
    const { order } = await b.owner.s.req("POST", `${b.base}/orders`, { items: [{ productId: product.id, quantity: 2 }] });
    for (const status of ["accepted", "processing", "ready", "delivered"]) await b.owner.s.req("PATCH", `${b.base}/orders/${order.id}/status`, { status });
    const { user } = await loginUi(b.owner.email, "/app/reports");
    expect(await screen.findByRole("heading", { name: /Sales report/ })).toBeInTheDocument();
    expect((await screen.findAllByText(money(220))).length).toBeGreaterThan(0); expect(screen.getByText(order.orderNumber)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Download CSV" })); await waitFor(() => expect(window.__downloads).toHaveLength(1));
    expect(window.__downloads[0].name).toMatch(/^sales_.*\.csv$/); expect(window.__downloads[0].type).toContain("text/csv");
    await user.click(screen.getByRole("button", { name: "Download PDF" })); await waitFor(() => expect(window.__downloads).toHaveLength(2)); expect(window.__downloads[1].type).toBe("application/pdf");
    await user.selectOptions(screen.getByLabelText("Report"), "inventory");
    expect(await screen.findByRole("heading", { name: /Inventory report/ })).toBeInTheDocument(); expect(await screen.findByText("Report Item")).toBeInTheDocument(); expect(screen.getByText(/dates don't apply/)).toBeInTheDocument();
    expect(screen.getByLabelText("From")).toBeDisabled();
  });

  it("rejects an impossible date range before asking the server", async () => {
    const b = await seedBusiness(); const { user } = await loginUi(b.owner.email, "/app/reports");
    const from = await screen.findByLabelText("From"); fireEvent.change(from, { target: { value: "2030-01-01" } }); void user;
    expect(await screen.findByRole("alert")).toHaveTextContent(/start date must be on or before/);
  });
});

describe("sessions on a shared browser", () => {
  it("loads the right permissions when someone logs in after another person used the same browser", async () => {
    const b = await seedBusiness(); const e = await seedEmployee(b);
    const first = await loginUi(e.email); await screen.findByRole("heading", { name: "My day" }); first.unmount();     // the browser now remembers this business
    await loginUi(b.owner.email, "/app/leave");                                                                         // ...and the owner logs in next
    expect(await screen.findByRole("heading", { name: "Team leave" })).toBeInTheDocument();
    expect(await (await nav()).findByRole("link", { name: "All employees" })).toBeInTheDocument();                      // owner-only menu items are present
    expect(screen.queryByText("You don't have access to this page")).toBeNull();
  });
});

describe("HR: leave, performance, documents and reviews", () => {
  it("runs the leave cycle between an employee and their manager", async () => {
    const b = await seedBusiness(); const e = await seedEmployee(b, "Lea Ve");
    const a = await loginUi(e.email, "/app/leave"); await a.user.click(await screen.findByRole("button", { name: "Request leave" })); let d = await dialog();
    await a.user.type(d.getByLabelText("First day"), future(10)); await a.user.type(d.getByLabelText("Last day"), future(12)); await a.user.type(d.getByLabelText(/Reason/), "Family event"); await a.user.click(d.getByRole("button", { name: "Send request" }));
    expect(await screen.findByText("Pending", { selector: ".badge" })).toBeInTheDocument(); a.unmount();

    const m = await loginUi(b.owner.email, "/app/leave");
    expect(await screen.findByText("Lea Ve")).toBeInTheDocument(); await m.user.click(screen.getByRole("button", { name: "Approve" })); d = await dialog();
    await m.user.type(d.getByLabelText(/Note/), "Enjoy"); await m.user.click(d.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.queryByText("Lea Ve")).toBeNull()); m.unmount();                      // no longer pending

    await loginUi(e.email, "/app/leave"); expect(await screen.findByText("Approved", { selector: ".badge" })).toBeInTheDocument(); expect(screen.getByText("Enjoy")).toBeInTheDocument();
  });

  it("writes, shares and acknowledges a performance review", async () => {
    const b = await seedBusiness(); const e = await seedEmployee(b, "Per Former");
    const m = await loginUi(b.owner.email, "/app/performance"); await m.user.click(await screen.findByRole("button", { name: "Write a review" })); let d = await dialog();
    await d.findByRole("option", { name: "Per Former" }); await m.user.selectOptions(d.getByLabelText("Employee"), e.employeeId); await m.user.type(d.getByLabelText("Period start"), "2026-01-01"); await m.user.type(d.getByLabelText("Period end"), "2026-06-30");
    await m.user.type(d.getByLabelText("Strengths"), "Reliable and calm."); await m.user.click(d.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Draft", { selector: ".badge" })).toBeInTheDocument();
    await m.user.click(screen.getByRole("button", { name: "Share" })); expect(await screen.findByText("Shared", { selector: ".badge" })).toBeInTheDocument(); expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();   // shared reviews are locked
    m.unmount();

    const emp = await loginUi(e.email, "/app/performance"); await emp.user.click(await screen.findByRole("button", { name: "View" })); d = await dialog(); expect(await d.findByText("Reliable and calm.")).toBeInTheDocument(); await emp.user.click(d.getByRole("button", { name: "Close" }));
    await emp.user.click(screen.getByRole("button", { name: "Acknowledge" })); await waitFor(() => expect(screen.queryByRole("button", { name: "Acknowledge" })).toBeNull());
    expect((await b.owner.s.req("GET", `${b.base}/performance?employeeId=${e.employeeId}`)).reviews[0].acknowledgedAt).not.toBeNull();
  });

  it("uploads a private document, shares it, and lets only that employee download it", async () => {
    const b = await seedBusiness(); const e = await seedEmployee(b, "Doc Holder");
    const m = await loginUi(b.owner.email, "/app/employees"); await m.user.click(await (await main()).findByRole("link", { name: "Documents" }));
    await m.user.click(await screen.findByRole("button", { name: "Upload document" })); let d = await dialog();
    await m.user.type(d.getByLabelText("Document name"), "Employment contract"); await m.user.upload(d.getByLabelText("File"), pdf()); await m.user.click(d.getByRole("button", { name: "Upload" }));
    expect(await screen.findByText("Employment contract")).toBeInTheDocument(); expect(screen.getByText("Private", { selector: ".badge" })).toBeInTheDocument();
    await m.user.click(screen.getByRole("button", { name: "Download" })); await waitFor(() => expect(window.__downloads.length).toBe(1)); expect(window.__downloads[0]).toMatchObject({ name: "Employment contract.pdf", type: "application/pdf" });
    m.unmount();

    const emp = await loginUi(e.email, "/app/documents"); expect(await screen.findByText("Nothing shared with you yet")).toBeInTheDocument(); emp.unmount();   // private by default
    await b.owner.s.req("PATCH", `${b.base}/employees/${e.employeeId}/documents/${(await b.owner.s.req("GET", `${b.base}/employees/${e.employeeId}/documents`)).documents[0].id}`, { visibleToEmployee: true });
    const again = await loginUi(e.email, "/app/documents"); expect(await screen.findByText("Employment contract")).toBeInTheDocument();
    await again.user.click(screen.getByRole("button", { name: "Download" })); await waitFor(() => expect(window.__downloads.length).toBe(2));
  });

  it("lets an employee review their employer and the business see (and report) it", async () => {
    const b = await seedBusiness(`Fair Co ${Date.now()}`); const e = await seedEmployee(b);
    const emp = await loginUi(e.email); await emp.user.click(await screen.findByRole("button", { name: new RegExp(`Review ${b.biz.name}`) })); const d = await dialog();
    await emp.user.click(await d.findByLabelText(/4 stars/)); await emp.user.type(d.getByLabelText(/Your experience/), "Good team and fair pay."); await emp.user.click(d.getByRole("button", { name: "Publish review" }));
    expect(await screen.findByText(/your review is published/i)).toBeInTheDocument(); emp.unmount();
    const owner = await loginUi(b.owner.email, "/app/reputation");
    expect(await screen.findByText("Good team and fair pay.")).toBeInTheDocument(); expect(screen.getByText("Former or current employee")).toBeInTheDocument(); expect(screen.getByText("4")).toBeInTheDocument();
    await owner.user.click(screen.getByRole("button", { name: "Report" })); const r = await dialog(); await owner.user.type(r.getByLabelText(/What's wrong/), "This looks inaccurate."); await owner.user.click(r.getByRole("button", { name: "Send report" }));
    expect(await screen.findByText(/moderators will take a look/)).toBeInTheDocument();
  });
});

describe("hiring, advertising, settings and subscription", () => {
  it("posts a job, then reviews an applicant through shortlist and interview", async () => {
    const b = await seedBusiness(`Hiring ${Date.now()}`); const tag = `Barista${Date.now()}`;
    const { user } = await loginUi(b.owner.email, "/app/jobs/manage");
    await user.click(await screen.findByRole("button", { name: "Post a job" })); let d = await dialog();
    await user.type(d.getByLabelText("Job title"), tag); await user.type(d.getByLabelText("Description"), "Make coffee."); await user.click(d.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(tag)).toBeInTheDocument(); expect(screen.getByText("Draft", { selector: ".badge" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Publish" })); expect(await screen.findByText("Open", { selector: ".badge" })).toBeInTheDocument();

    const applicant = await seedUser("individual", "Anita Rao"); const job = (await b.owner.s.req("GET", `${b.base}/jobs`)).jobs[0];
    await applicant.s.req("PUT", "/api/me/skills", { skills: ["Espresso"] }); await applicant.s.req("POST", `/api/jobs/${job.id}/apply`, { coverLetter: "Love coffee" });

    await user.click(await (await nav()).findByRole("link", { name: "Applicants" })); expect(await screen.findByText("Anita Rao")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "View Anita Rao" })); d = await dialog(); expect(await d.findByText("Love coffee")).toBeInTheDocument(); expect(d.getByRole("link", { name: applicant.email })).toBeInTheDocument();
    await user.click(d.getByRole("button", { name: "Shortlist" })); let s = within((await screen.findAllByRole("dialog")).at(-1)!); await user.type(s.getByLabelText(/Note/), "Strong CV"); await user.click(s.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(d.getAllByText("Shortlisted", { selector: ".badge" }).length).toBeGreaterThan(0));
    await user.click(await d.findByRole("button", { name: "Invite to interview" })); s = within((await screen.findAllByRole("dialog")).at(-1)!); await user.type(s.getByLabelText(/Interview date/), "2031-03-01T10:30"); await user.click(s.getByRole("button", { name: "Confirm" }));
    expect(await d.findByText(/Interview:/)).toBeInTheDocument();
    const mine = (await applicant.s.req("GET", "/api/me/applications")).applications[0]; expect(mine).toMatchObject({ status: "interview" }); expect(mine.interviewAt).not.toBeNull();
  });

  it("creates an ad, takes it live, and pauses it", async () => {
    const b = await seedBusiness(); const { user } = await loginUi(b.owner.email, "/app/ads");
    await user.click(await screen.findByRole("button", { name: "Create ad" })); const d = await dialog(); await user.type(d.getByLabelText("Headline"), "Diwali Sale"); await user.click(d.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Diwali Sale")).toBeInTheDocument();
    const serving = async () => (await new Session().req("GET", `/api/public/ads?placement=discover&businessId=${b.biz.id}`)).ads.length;
    expect(await serving()).toBe(0);                                                                     // drafts are never shown
    await user.click(screen.getByRole("button", { name: "Go live" })); expect(await screen.findByText("Live", { selector: ".badge" })).toBeInTheDocument(); expect(await serving()).toBe(1);
    await user.click(screen.getByRole("button", { name: "Pause" })); await waitFor(async () => expect(await serving()).toBe(0));
  });

  it("edits business settings and shows the plan with usage", async () => {
    const b = await seedBusiness(); const { user } = await loginUi(b.owner.email, "/app/settings");
    const name = await screen.findByLabelText("Business name"); await user.clear(name); await user.type(name, "Renamed Traders"); await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Business saved")).toBeInTheDocument(); expect((await b.owner.s.req("GET", b.base)).business.name).toBe("Renamed Traders");
    await user.click(screen.getByRole("button", { name: "Work hours" })); const grace = await screen.findByLabelText("Grace period (minutes)"); await user.clear(grace); await user.type(grace, "15"); await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Work hours saved")).toBeInTheDocument(); expect((await b.owner.s.req("GET", `${b.base}/attendance-settings`)).settings.lateGraceMinutes).toBe(15);
    await user.click(screen.getByRole("button", { name: "Team and roles" })); expect(await screen.findByText("Business Owner")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Activity log" })); expect(await screen.findByText(/Business create/i)).toBeInTheDocument();
    await user.click(await (await nav()).findByRole("link", { name: "Subscription" }));
    expect(await screen.findByText("Your plan")).toBeInTheDocument(); expect(screen.getAllByText("Free").length).toBeGreaterThan(0); expect(screen.getByRole("progressbar", { name: "Team members" })).toBeInTheDocument();
    expect(screen.getAllByText(/Upgrades are arranged with our team/).length).toBeGreaterThan(0);
  });
});

describe("admin panel", () => {
  it("suspends and reactivates a user, and changes a business plan", async () => {
    const admin = await seedAdmin(); const target = await seedUser("individual", "Troublesome Tom"); const b = await seedBusiness(`Plan Co ${Date.now()}`);
    const { user } = await loginUi(admin.email, "/app");
    await user.click(await (await nav()).findByRole("link", { name: "Users" })); await user.type(await screen.findByLabelText("Search by name or email"), target.email);
    expect(await screen.findByText("Troublesome Tom")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Suspend" })); let d = await dialog(); await user.type(d.getByLabelText(/Reason/), "Fraud report"); await user.click(d.getByRole("button", { name: "Suspend" }));
    expect(await screen.findByText("User suspended")).toBeInTheDocument(); expect(await screen.findByText("Suspended", { selector: ".badge" })).toBeInTheDocument();
    await expect(new Session().req("POST", "/api/auth/login", { email: target.email, password: PASSWORD })).rejects.toThrow(/403/);
    await user.click(await screen.findByRole("button", { name: "Reactivate" })); d = await dialog(); await user.click(d.getByRole("button", { name: "Reactivate" }));
    expect(await screen.findByText("User reactivated")).toBeInTheDocument(); await new Session().req("POST", "/api/auth/login", { email: target.email, password: PASSWORD });

    await user.click(await (await nav()).findByRole("link", { name: "Businesses" })); await user.type(await screen.findByLabelText("Search by name"), b.biz.name);
    await user.click(await screen.findByRole("button", { name: "Plan" })); d = await dialog(); await user.selectOptions(d.getByLabelText("Plan"), "pro"); await user.click(d.getByRole("button", { name: "Change plan" }));
    expect(await screen.findByText("Plan updated")).toBeInTheDocument(); expect((await b.owner.s.req("GET", `${b.base}/subscription`)).subscription.plan.key).toBe("pro");
  });

  it("manages platform categories and shows the audit log, but only to administrators", async () => {
    const admin = await seedAdmin(); const { user } = await loginUi(admin.email, "/app/admin/categories");
    await user.click(await screen.findByRole("button", { name: "Add category" })); const d = await dialog(); await user.type(d.getByLabelText("Name"), `Grocery${Date.now()}`); await user.click(d.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Grocery\d+/)).toBeInTheDocument();
    await user.click(await (await nav()).findByRole("link", { name: "Audit log" })); expect(await screen.findByText("admin.category_create")).toBeInTheDocument();
    const owner = await seedUser("business_owner"); renderApp("/app/admin/users", new Session());   // a visitor who isn't signed in is sent to log in
    expect(await screen.findAllByRole("heading", { name: "Log in" })).not.toHaveLength(0); void owner;
  });

  it("keeps the admin screens away from ordinary users", async () => {
    const b = await seedBusiness(); await loginUi(b.owner.email, "/app/admin/users");
    expect(await screen.findByText("You don't have access to this page")).toBeInTheDocument();
    expect((await nav()).queryByRole("link", { name: "Users" })).toBeNull();
  });
});
void uniqueEmail;
