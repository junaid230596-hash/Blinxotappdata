import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PASSWORD, renderApp, resetDb, seedAdmin, seedBusiness, seedEmployee, seedUser, startServer, stopServer } from "./harness";

beforeAll(async () => { await startServer(); await resetDb(); });
afterAll(stopServer);

// Structural accessibility rules (names, labels, roles, landmarks, ARIA). Colour contrast needs a real browser, so it is checked there.
async function audit(label: string) {
  const r = await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } }, resultTypes: ["violations"] });
  const msg = r.violations.map((v) => `${v.id}: ${v.help} -> ${v.nodes.slice(0, 2).map((n) => n.html.slice(0, 120)).join(" | ")}`).join("\n");
  expect(r.violations, `${label}\n${msg}`).toEqual([]);
}
async function loginUi(email: string, route: string) {
  const user = userEvent.setup(); const { unmount } = renderApp(route);
  await user.type(await screen.findByLabelText("Email"), email); await user.type(screen.getByLabelText("Password"), PASSWORD);
  await user.click(screen.getByRole("button", { name: "Log in" })); return Object.assign(user, { unmount });
}
const menu = async (name: string) => within(await screen.findByRole("navigation", { name: "Main" })).findByRole("link", { name });

describe("accessibility (structural)", () => {
  it("public auth pages", async () => {
    for (const route of ["/login", "/register", "/forgot-password"]) { const { unmount } = renderApp(route); await screen.findByRole("heading", { level: 1 }); await audit(route); unmount(); }
  });

  it("business dashboard, products, product form, orders, inventory", async () => {
    const b = await seedBusiness();
    await b.owner.s.req("POST", `${b.base}/products`, { name: "A11y Item", sku: `A-${Date.now()}`, sellingPrice: 10, openingStock: 1, minStock: 5 });
    const user = await loginUi(b.owner.email, "/app");
    await screen.findByRole("heading", { name: /Welcome back/ }); await screen.findByText("Revenue, last 30 days"); await audit("dashboard");
    for (const [link, heading] of [["All products", "Products"], ["Add product", "Add product"], ["Orders", "Orders"], ["Inventory", "Inventory"], ["Customers", "Customers"], ["All employees", "Employees"], ["Tasks", "Tasks"]] as const) {
      await user.click(await menu(link)); await screen.findByRole("heading", { name: heading, level: 1 });
      await new Promise((r) => setTimeout(r, 500)); await audit(link);           // let the screen finish loading
    }
  });

  it("open dialogs, the mobile drawer, employee and individual screens", async () => {
    const b = await seedBusiness(); const e = await seedEmployee(b);
    const owner = await loginUi(b.owner.email, "/app/employees"); await owner.click(await screen.findByRole("button", { name: "Open menu" })); await audit("drawer open");
    await owner.keyboard("{Escape}"); await owner.click(await menu("Add employee")); await screen.findByLabelText("Full name"); await audit("employee form");
    owner.unmount();
    const emp = await loginUi(e.email, "/app/attendance"); await screen.findByRole("heading", { name: "Attendance", level: 1 }); await screen.findByRole("button", { name: "Punch in" }); await audit("attendance");
    emp.unmount();
    const { email } = await seedUser("individual"); await loginUi(email, "/app/profile"); await screen.findByRole("heading", { name: "My profile" }); await audit("profile");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Add work experience" })); await screen.findByRole("dialog"); await audit("profile dialog");
  });

  it("purchasing, CRM, reports, HR, hiring, settings and subscription screens", async () => {
    const b = await seedBusiness(); const e = await seedEmployee(b, "Audit Worker");
    await b.owner.s.req("POST", `${b.base}/suppliers`, { name: "Audit Supplier" });
    const seller = await seedBusiness();                                    // a marketplace hides your own products, so list one from another business
    await seller.owner.s.req("POST", `${seller.base}/products`, { name: "Audit Product", sku: `AP-${Date.now()}`, sellingPrice: 10, openingStock: 3, isListed: true });
    await b.owner.s.req("POST", `${b.base}/crm/leads`, { name: "Audit Lead" }); await b.owner.s.req("POST", `${b.base}/crm/deals`, { title: "Audit Deal", value: 100 });
    await b.owner.s.req("POST", `${b.base}/jobs`, { title: "Audit Job", description: "Do things", workType: "full_time" });
    await b.owner.s.req("POST", `${b.base}/ads`, { title: "Audit Ad", placements: ["discover"], startDate: "2030-01-01", endDate: "2030-02-01" });
    await b.owner.s.req("POST", `${b.base}/performance`, { employeeId: e.employeeId, periodStart: "2026-01-01", periodEnd: "2026-02-01", rating: 4 });
    const user = await loginUi(b.owner.email, "/app");
    await screen.findByRole("heading", { name: /Welcome back/ });
    const pages: [string, string, string][] = [["Suppliers", "Suppliers", "Audit Supplier"], ["Purchases", "Purchases", "No purchases yet"], ["New purchase", "New purchase", "Supplier"], ["Marketplace", "Marketplace", "Audit Product"],
      ["Overview", "CRM", "Open pipeline"], ["Leads", "Leads", "Audit Lead"], ["Pipeline", "Pipeline", "Audit Deal"], ["Follow-ups", "Follow-ups and tasks", "Nothing to follow up"],
      ["Reports", "Reports", "Sales report"], ["Leave", "Leave", "Team leave"], ["Performance", "Performance", "Audit Worker"], ["Documents", "Documents", "Expiring in the next 60 days"],
      ["Job postings", "Job postings", "Audit Job"], ["Applicants", "Applicants", "No applicants yet"], ["Advertisements", "Advertisements", "Audit Ad"], ["Subscription", "Subscription", "Your plan"], ["Settings", "Settings", "Business profile"], ["Reviews", "Reviews of your business", "No reviews yet"]];
    for (const [link, heading, ready] of pages) {
      await user.click(await menu(link)); await screen.findByRole("heading", { name: heading, level: 1 }); await screen.findAllByText(ready, { exact: false }); await new Promise((r) => setTimeout(r, 300)); await audit(link);
    }
    await user.click(await menu("Job postings")); await user.click(await screen.findByRole("button", { name: "Post a job" })); await screen.findByRole("dialog"); await audit("job form dialog"); await user.keyboard("{Escape}");
    await user.click(await menu("Advertisements")); await user.click(await screen.findByRole("button", { name: "Create ad" })); await screen.findByRole("dialog"); await audit("ad form (multi-select)");
  });

  it("the admin panel", async () => {
    const admin = await seedAdmin(); const user = await loginUi(admin.email, "/app");
    await screen.findByRole("heading", { name: "Platform overview" }); await audit("admin overview");
    for (const [link, heading] of [["Users", "Users"], ["Businesses", "Businesses"], ["Review moderation", "Review moderation"], ["Ad moderation", "Ad moderation"], ["Categories", "Categories"], ["Audit log", "Audit log"], ["Settings", "Platform settings"]] as const) {
      await user.click(await menu(link)); await screen.findByRole("heading", { name: heading, level: 1 }); await new Promise((r) => setTimeout(r, 400)); await audit(`admin ${link}`);
    }
  });
});

