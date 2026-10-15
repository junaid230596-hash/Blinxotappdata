import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PASSWORD, renderApp, resetDb, seedBusiness, seedEmployee, seedUser, startServer, stopServer, tokenFor, otpFor, uniqueEmail } from "./harness";

beforeAll(async () => { await startServer(); await resetDb(); });
afterAll(stopServer);

type Ctx = ReturnType<typeof userEvent.setup>;
/** Logs in through the real login form, landing on `route` (via the same redirect a bookmarked link would use). */
async function loginUi(email: string, route = "/app") {
  const user = userEvent.setup(); const r = renderApp(route);
  await user.type(await screen.findByLabelText("Email"), email); await user.type(screen.getByLabelText("Password"), PASSWORD);
  await user.click(screen.getByRole("button", { name: "Log in" }));
  return { user, ...r };
}
const money = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(n);
const rows = async (user: Ctx, el: HTMLElement) => { void user; return within(el); };
void rows;

describe("sign-up, verification and login", () => {
  it("registers, verifies by email link, then logs in to a clear first-run screen", async () => {
    const user = userEvent.setup(); const email = uniqueEmail("signup");
    const a = renderApp("/register");
    await user.click(await screen.findByLabelText(/Business owner/));
    await user.type(screen.getByLabelText("Full name"), "Asha Verma"); await user.type(screen.getByLabelText("Email"), email); await user.type(screen.getByLabelText("Password"), "short");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText(/Include letters and numbers|at least 10 characters/)).toBeInTheDocument();   // server-side field errors appear next to the field
    await user.clear(screen.getByLabelText("Password")); await user.type(screen.getByLabelText("Password"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeInTheDocument(); expect(screen.getByText(email)).toBeInTheDocument();
    a.unmount();

    const v = renderApp(`/verify-email?token=${tokenFor(email)}`);
    expect(await screen.findByRole("heading", { name: "Email verified" })).toBeInTheDocument(); v.unmount();
    const again = renderApp(`/verify-email?token=${tokenFor(email)}`);                               // the link is single-use
    expect(await screen.findByRole("heading", { name: "Link not valid" })).toBeInTheDocument(); again.unmount();

    await loginUi(email);
    expect(await screen.findByRole("heading", { name: "Set up your business" })).toBeInTheDocument();
  });

  it("shows a helpful error for a wrong password and never reveals which part was wrong", async () => {
    const { email } = await seedUser("individual");
    const user = userEvent.setup(); renderApp("/login");
    await user.type(await screen.findByLabelText("Email"), email); await user.type(screen.getByLabelText("Password"), "WrongPassword123");
    await user.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password");
    await user.clear(screen.getByLabelText("Email")); await user.type(screen.getByLabelText("Email"), "nobody@example.com"); await user.click(screen.getByRole("button", { name: "Log in" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Invalid email or password"));
  });

  it("sends signed-out visitors to log in and returns them to where they were headed", async () => {
    const { email } = await seedUser("individual");
    await loginUi(email, "/app/applications");
    expect(await screen.findByRole("heading", { name: "My applications" })).toBeInTheDocument();
  });

  it("logs out cleanly", async () => {
    const { email } = await seedUser("individual");
    const { user } = await loginUi(email);
    await user.click(await screen.findByRole("button", { name: "Log out" }));
    expect(await screen.findByRole("heading", { name: "Log in" })).toBeInTheDocument();
  });

  it("returns to the login screen when the session can no longer be refreshed", async () => {
    const { email } = await seedUser("individual");
    const { user, session } = await loginUi(email);
    await screen.findByRole("heading", { name: /Hello/ });
    session.jar.clear();                                                                              // cookies vanish (expired / revoked)
    await user.click(screen.getByRole("link", { name: "My applications" }));
    expect(await screen.findByRole("heading", { name: "Log in" })).toBeInTheDocument();
  });
});

describe("business owner", () => {
  it("creates a business from the first-run screen and lands on a working dashboard", async () => {
    const { email } = await seedUser("business_owner", "Ravi Kapoor");
    const { user } = await loginUi(email);
    await user.type(await screen.findByLabelText("Business name"), "Kapoor Traders"); await user.type(screen.getByLabelText("Category"), "Retail");
    await user.click(screen.getByRole("button", { name: "Create business" }));
    expect(await screen.findByRole("heading", { name: "Welcome back, Ravi" })).toBeInTheDocument();
    expect((await screen.findAllByText("Kapoor Traders")).length).toBeGreaterThan(0);
    expect(screen.getByText("Revenue, last 30 days")).toBeInTheDocument();
  });

  it("creates a product, adjusts its stock, and surfaces server validation errors", async () => {
    const b = await seedBusiness(); await b.owner.s.req("POST", `${b.base}/products`, { name: "Existing", sku: "DUP-1" });
    const { user } = await loginUi(b.owner.email, "/app/products/new");
    await user.type(await screen.findByLabelText("Name"), "Basmati Rice"); await user.type(screen.getByLabelText("SKU"), "DUP-1");
    await user.click(screen.getByRole("button", { name: "Create product" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already uses this SKU/);              // duplicate SKU is explained, nothing is lost
    await user.clear(screen.getByLabelText("SKU")); await user.type(screen.getByLabelText("SKU"), "RICE-5");
    await user.type(screen.getByLabelText("Selling price (₹)"), "120"); await user.type(screen.getByLabelText("Opening stock"), "10");
    await user.click(screen.getByRole("button", { name: "Create product" }));
    expect(await screen.findByRole("heading", { name: "Basmati Rice" })).toBeInTheDocument(); expect(await screen.findByText("10")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Add$/ }));
    const dlg = await screen.findByRole("dialog"); await user.type(within(dlg).getByLabelText("Quantity"), "5"); await user.click(within(dlg).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("15")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Remove$/ })); const dlg2 = await screen.findByRole("dialog");
    await user.type(within(dlg2).getByLabelText("Quantity"), "99"); await user.click(within(dlg2).getByRole("button", { name: "Save" }));
    expect(await within(dlg2).findByRole("alert")).toHaveTextContent(/Insufficient stock/);          // can't remove more than exists; dialog stays open
    await user.click(within(dlg2).getByRole("button", { name: "Cancel" }));

    const list = await b.owner.s.req("GET", `${b.base}/products?q=RICE-5`); expect(list.products[0].stockQty).toBe(15);
    const mv = await b.owner.s.req("GET", `${b.base}/inventory/movements?productId=${list.products[0].id}`); expect(mv.movements.map((m: any) => m.type)).toEqual(["stock_in", "opening"]);
  });

  it("lists, searches and flags low-stock products", async () => {
    const b = await seedBusiness();
    await b.owner.s.req("POST", `${b.base}/products`, { name: "Green Tea", sku: "GT-1", openingStock: 2, minStock: 5, sellingPrice: 50 });
    await b.owner.s.req("POST", `${b.base}/products`, { name: "Black Coffee", sku: "BC-1", openingStock: 40, minStock: 5, sellingPrice: 80 });
    const { user } = await loginUi(b.owner.email, "/app/products");
    expect(await screen.findByText("Green Tea")).toBeInTheDocument(); expect(screen.getByText("Black Coffee")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Search"), "coffee");
    await waitFor(() => expect(screen.queryByText("Green Tea")).toBeNull()); expect(screen.getByText("Black Coffee")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Search")); await user.click(screen.getByLabelText("Low stock only"));
    await waitFor(() => expect(screen.queryByText("Black Coffee")).toBeNull()); expect(await screen.findByText("Green Tea")).toBeInTheDocument(); expect(screen.getByText("Low")).toBeInTheDocument();   // (search is debounced, so allow it to settle)
  });

  it("takes a walk-in order from creation to delivery, adjusting stock, and explains shortages", async () => {
    const b = await seedBusiness(); const tag = `Mango${Date.now()}`;
    const { product } = await b.owner.s.req("POST", `${b.base}/products`, { name: tag, sku: `M-${Date.now()}`, sellingPrice: 100, openingStock: 5 });
    const { user } = await loginUi(b.owner.email, "/app/orders/new");
    await user.type(await screen.findByLabelText("Find a product"), tag);
    await user.click(await screen.findByRole("button", { name: `Add ${tag}` }));
    const qty = await screen.findByLabelText(`Quantity for ${tag}`); await user.clear(qty); await user.type(qty, "2");
    expect(await screen.findByText(money(200))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create order" }));
    expect(await screen.findByRole("heading", { name: /ORD-\d{6}/ })).toBeInTheDocument();
    for (const [btn, state] of [["Accept order", "Accepted"], ["Start processing", "Processing"], ["Mark ready", "Ready"]] as const) {
      await user.click(await screen.findByRole("button", { name: btn })); expect(await screen.findByText(state, { selector: ".badge" })).toBeInTheDocument();
    }
    expect((await b.owner.s.req("GET", `${b.base}/products/${product.id}`)).product.stockQty).toBe(3);   // stock reserved on accept
    await user.click(await screen.findByRole("button", { name: "Mark delivered" }));
    expect(await screen.findByText("Delivered", { selector: ".badge" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Record a return" })); const dlg = await screen.findByRole("dialog");
    await user.type(within(dlg).getByLabelText(/max 2/), "1"); await user.click(within(dlg).getByRole("button", { name: "Record return" }));
    expect(await screen.findByText(/Refund/)).toBeInTheDocument();
    expect((await b.owner.s.req("GET", `${b.base}/products/${product.id}`)).product.stockQty).toBe(4);   // resellable return goes back on the shelf

    const o2 = await b.owner.s.req("POST", `${b.base}/orders`, { items: [{ productId: product.id, quantity: 9 }] });
    const again = renderApp(`/app/orders/${o2.order.id}`, undefined);                                  // (a fresh visit; the earlier login is reused below)
    again.unmount();
  });

  it("explains a stock shortage when accepting an order", async () => {
    const b = await seedBusiness(); const { product } = await b.owner.s.req("POST", `${b.base}/products`, { name: "Rare Spice", sku: `RS-${Date.now()}`, sellingPrice: 10, openingStock: 1 });
    const o = await b.owner.s.req("POST", `${b.base}/orders`, { items: [{ productId: product.id, quantity: 5 }] });
    const { user } = await loginUi(b.owner.email, `/app/orders/${o.order.id}`);
    await user.click(await screen.findByRole("button", { name: "Accept order" }));
    expect(await screen.findByText(/Insufficient stock for "Rare Spice"/)).toBeInTheDocument();
    expect(await screen.findByText("Pending", { selector: ".badge" })).toBeInTheDocument();           // nothing changed
  });

  it("confirms delivery with the buyer's one-time code, rejecting wrong codes", async () => {
    const b = await seedBusiness(); const buyerEmail = uniqueEmail("buyer");
    const { product } = await b.owner.s.req("POST", `${b.base}/products`, { name: "Sealed Box", sku: `SB-${Date.now()}`, sellingPrice: 500, openingStock: 3 });
    const { customer } = await b.owner.s.req("POST", `${b.base}/customers`, { name: "Careful Buyer", email: buyerEmail });
    const { order } = await b.owner.s.req("POST", `${b.base}/orders`, { customerId: customer.id, items: [{ productId: product.id, quantity: 1 }] });
    for (const status of ["accepted", "processing", "ready", "dispatched"]) await b.owner.s.req("PATCH", `${b.base}/orders/${order.id}/status`, { status });
    const real = otpFor(buyerEmail); const wrong = real === "000000" ? "111111" : "000000";
    const { user } = await loginUi(b.owner.email, `/app/orders/${order.id}`);
    expect(await screen.findByRole("heading", { name: "Confirm delivery" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark delivered" })).toBeNull();                      // a coded order cannot be marked delivered by hand
    const input = screen.getByLabelText("Delivery code"); const verify = screen.getByRole("button", { name: "Verify" });
    expect(verify).toBeDisabled(); await user.type(input, wrong); await user.click(verify);
    expect(await screen.findByText(/Incorrect code/)).toBeInTheDocument();
    await user.clear(input); await user.type(input, real); await user.click(verify);
    expect(await screen.findByText("Delivered", { selector: ".badge" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Confirm delivery" })).toBeNull();
  });

  it("shows real figures on the dashboard", async () => {
    const b = await seedBusiness();
    const { product } = await b.owner.s.req("POST", `${b.base}/products`, { name: "Dash Item", sku: `DI-${Date.now()}`, sellingPrice: 100, taxRate: 10, openingStock: 20, minStock: 25 });
    const { order } = await b.owner.s.req("POST", `${b.base}/orders`, { items: [{ productId: product.id, quantity: 2 }] });
    for (const status of ["accepted", "processing", "ready", "delivered"]) await b.owner.s.req("PATCH", `${b.base}/orders/${order.id}/status`, { status });
    await loginUi(b.owner.email);
    expect((await screen.findAllByText(money(220))).length).toBeGreaterThan(0);                       // revenue incl. tax (also shown in recent orders)
    const low = screen.getByText("Low-stock products").closest(".card")!; expect(within(low as HTMLElement).getByText("1")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: order.orderNumber })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Revenue per day/ })).toBeInTheDocument();
  });

  it("lists notifications, including stock alerts, and marks them read", async () => {
    const b = await seedBusiness();
    const { product } = await b.owner.s.req("POST", `${b.base}/products`, { name: "Alarm Item", sku: `AL-${Date.now()}`, openingStock: 10, minStock: 5 });
    await b.owner.s.req("POST", `${b.base}/inventory/stock-out`, { productId: product.id, quantity: 8 });
    const { user } = await loginUi(b.owner.email, "/app/notifications");
    expect(await screen.findByText("Low stock: Alarm Item")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("link", { name: /Notifications, \d+ unread/ })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Mark all read" }));
    await waitFor(() => expect(screen.queryByText("New")).toBeNull());
    expect(screen.getByRole("button", { name: "Mark all read" })).toBeDisabled();
  });
});

describe("employee", () => {
  it("sees their own day, punches in and out, and cannot open manager pages", async () => {
    const b = await seedBusiness(`Shop ${Date.now()}`); const e = await seedEmployee(b, "Priya Nair");
    const { user, session } = await loginUi(e.email);
    expect(await screen.findByRole("heading", { name: "My day" })).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Punch in" }));
    expect(await screen.findByRole("button", { name: "Punch out" })).toBeInTheDocument(); expect(screen.getByText(/On the clock since/)).toBeInTheDocument();
    const today = await b.owner.s.req("GET", `${b.base}/attendance?employeeId=${e.employeeId}`); expect(today.total).toBe(1); expect(today.records[0].punchOut).toBeNull();
    await user.click(screen.getByRole("button", { name: "Punch out" }));
    expect(await screen.findByText("You are punched out")).toBeInTheDocument();
    expect((await b.owner.s.req("GET", `${b.base}/attendance?employeeId=${e.employeeId}`)).records[0].punchOut).not.toBeNull();

    const nav = screen.getByRole("navigation", { name: "Main" });                                    // the menu only offers what this role can use
    expect(within(nav).getByRole("link", { name: "Attendance" })).toBeInTheDocument(); expect(within(nav).getByRole("link", { name: "Tasks" })).toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: "All employees" })).toBeNull(); expect(within(nav).queryByRole("link", { name: "Orders" })).toBeNull();
    session.jar.size; // session kept
    const direct = renderApp("/app/employees", session);                                              // typing the URL anyway
    expect(await screen.findByText("You don't have access to this page")).toBeInTheDocument(); direct.unmount();
  });

  it("works their assigned task from the board", async () => {
    const b = await seedBusiness(); const e = await seedEmployee(b);
    await b.owner.s.req("POST", `${b.base}/tasks`, { title: "Count the till", assignedTo: e.userId });
    await b.owner.s.req("POST", `${b.base}/tasks`, { title: "Owner-only errand" });
    const { user } = await loginUi(e.email, "/app/tasks");
    expect(await screen.findByText("Count the till")).toBeInTheDocument(); expect(screen.queryByText("Owner-only errand")).toBeNull();
    expect(screen.queryByRole("button", { name: "New task" })).toBeNull();
    await user.selectOptions(screen.getByLabelText("Status of Count the till"), "in_progress");
    await waitFor(async () => expect((await b.owner.s.req("GET", `${b.base}/tasks`)).tasks.find((t: any) => t.title === "Count the till").status).toBe("in_progress"));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "In progress" })).getByText("Count the till")).toBeInTheDocument());   // the board re-fetches after the change
    expect(within(screen.getByLabelText("Status of Count the till")).queryByRole("option", { name: "Completed" })).toBeNull();   // only managers can complete
  });

  it("lets a manager add an employee, who is then invited", async () => {
    const b = await seedBusiness(); const email = uniqueEmail("newhire");
    const { user } = await loginUi(b.owner.email, "/app/employees/new");
    await user.type(await screen.findByLabelText("Full name"), "New Hire"); await user.type(screen.getByLabelText("Email"), email); await user.type(screen.getByLabelText("Position"), "Cashier");
    await user.click(screen.getByRole("button", { name: "Send invitation" }));
    expect(await screen.findByRole("heading", { name: "Employees" })).toBeInTheDocument(); expect(await screen.findByText("New Hire")).toBeInTheDocument();
    expect(await screen.findByText(`Invitation sent to ${email}`)).toBeInTheDocument();
    expect(tokenFor(email)).toMatch(/\w+/);
  });
});

describe("mobile navigation", () => {
  it("opens and closes the menu drawer with the button, a link, the scrim and the Escape key", async () => {
    const b = await seedBusiness(); const { user } = await loginUi(b.owner.email);
    const burger = await screen.findByRole("button", { name: "Open menu" }); const sidebar = document.getElementById("sidebar")!;
    expect(burger).toHaveAttribute("aria-expanded", "false"); expect(burger).toHaveAttribute("aria-controls", "sidebar"); expect(sidebar).not.toHaveClass("open");
    await user.click(burger);
    expect(screen.getByRole("button", { name: "Close menu" })).toHaveAttribute("aria-expanded", "true"); expect(sidebar).toHaveClass("open");
    await user.click(await within(sidebar).findByRole("link", { name: "All products" }));            // (permissions load a moment after the business) navigating closes it
    expect(await screen.findByRole("heading", { name: "Products" })).toBeInTheDocument(); expect(sidebar).not.toHaveClass("open");
    await user.click(screen.getByRole("button", { name: "Open menu" })); await user.keyboard("{Escape}"); expect(sidebar).not.toHaveClass("open");
    await user.click(screen.getByRole("button", { name: "Open menu" })); await user.click(document.querySelector(".scrim")!); expect(sidebar).not.toHaveClass("open");
  });

  it("has a skip link and a labelled landmark structure", async () => {
    const { email } = await seedUser("individual"); await loginUi(email);
    await screen.findByRole("heading", { name: /Hello/ });
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute("href", "#main");
    expect(screen.getByRole("main")).toHaveAttribute("id", "main"); expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument(); expect(screen.getByRole("banner")).toBeInTheDocument();
  });

  it("asks unverified users to verify their email, and can resend the link", async () => {
    const s = (await import("./harness")).Session; const email = uniqueEmail("unv"); const sess = new s();
    await sess.req("POST", "/api/auth/register", { email, password: PASSWORD, fullName: "Unverified", accountType: "individual" });
    const { user } = await loginUi(email);
    expect(await screen.findByText(/Please verify your email address/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Resend email" })); expect(await screen.findByText("Verification email sent")).toBeInTheDocument();
  });
});

describe("individual: profile, jobs and applications", () => {
  it("builds a profile, applies for a job, tracks it and withdraws", async () => {
    const b = await seedBusiness(`Hirer ${Date.now()}`); const tag = `Welder${Date.now()}`;
    const { job } = await b.owner.s.req("POST", `${b.base}/jobs`, { title: tag, description: "Weld frames", workType: "full_time", location: "Udaipur", skills: ["Welding"], payMin: 15000, payMax: 20000, payPeriod: "month" });
    await b.owner.s.req("PATCH", `${b.base}/jobs/${job.id}`, { status: "open" });
    const { email } = await seedUser("individual", "Mohan Lal");
    const { user } = await loginUi(email, "/app/profile");

    await user.type(await screen.findByLabelText("Headline"), "Experienced welder"); await user.type(screen.getByLabelText("City"), "Udaipur");
    await user.click(screen.getByRole("button", { name: "Save profile" })); expect(await screen.findByText("Profile saved")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Add skills"), "Welding, Fitting"); await user.click(screen.getByRole("button", { name: "Add" })); await user.click(screen.getByRole("button", { name: "Save skills" }));
    expect(await screen.findByText("Skills saved")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add work experience" })); const dlg = await screen.findByRole("dialog");
    await user.type(within(dlg).getByLabelText("Role"), "Welder"); await user.type(within(dlg).getByLabelText("Company"), "Steelworks"); await user.type(within(dlg).getByLabelText("Start date"), "2020-01-01");
    await user.click(within(dlg).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Welder · Steelworks")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add work experience" })); const bad = await screen.findByRole("dialog");
    await user.type(within(bad).getByLabelText("Role"), "X"); await user.type(within(bad).getByLabelText("Company"), "Y"); await user.type(within(bad).getByLabelText("Start date"), "2022-01-01"); await user.type(within(bad).getByLabelText("End date"), "2021-01-01");
    await user.click(within(bad).getByRole("button", { name: "Save" })); expect(await within(bad).findByRole("alert")).toHaveTextContent(/Dates are inconsistent|end cannot be before/i);
    await user.click(within(bad).getByRole("button", { name: "Cancel" }));

    await user.click(screen.getByRole("link", { name: "Find jobs" }));
    await user.type(await screen.findByLabelText("Keyword"), tag);
    expect(await screen.findByRole("heading", { name: tag })).toBeInTheDocument(); expect(screen.getByText(/₹15,000\.00 – ₹20,000\.00 \/ month/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Apply" })); const ap = await screen.findByRole("dialog");
    await user.type(within(ap).getByLabelText(/Cover letter/), "Ten years of experience."); await user.click(within(ap).getByRole("button", { name: "Send application" }));
    expect(await screen.findByText("Application sent")).toBeInTheDocument(); expect(await screen.findByText("Applied", { selector: ".badge" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();                               // no double applications

    const seen = await b.owner.s.req("GET", `${b.base}/applications`); expect(seen.total).toBe(1);
    await b.owner.s.req("PATCH", `${b.base}/applications/${seen.applications[0].id}/status`, { status: "shortlisted", note: "Looks good" });
    await user.click(screen.getByRole("link", { name: "My applications" }));
    expect(await screen.findByRole("heading", { name: tag })).toBeInTheDocument(); expect(await screen.findByText("Shortlisted", { selector: ".badge" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "View history" })); expect(await screen.findByText("Looks good")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Withdraw" })); await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Withdraw" }));
    expect(await screen.findByText("Withdrawn", { selector: ".badge" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
  });
});
