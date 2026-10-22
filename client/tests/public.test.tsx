import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../../server/src/db.js";
import { PASSWORD, renderApp, resetDb, seedAdmin, seedBusiness, seedUser, startServer, stopServer, tokenFor, uniqueEmail } from "./harness";

beforeAll(async () => { await startServer(); await resetDb(); });
afterAll(stopServer);

const meta = (sel: string) => document.head.querySelector(sel)?.getAttribute("content") ?? document.head.querySelector(sel)?.getAttribute("href") ?? null;
const ld = () => { const el = document.getElementById("bx-jsonld"); return el ? JSON.parse(el.textContent!) : null; };
async function audit(label: string) {
  const r = await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } }, resultTypes: ["violations"] });
  expect(r.violations, `${label}\n${r.violations.map((v) => `${v.id}: ${v.help} -> ${v.nodes[0]?.html.slice(0, 120)}`).join("\n")}`).toEqual([]);
}

describe("marketing pages", () => {
  it("home is indexable, branded, and offers sign-up to visitors", async () => {
    renderApp("/");
    expect(await screen.findByRole("heading", { level: 1, name: /Run your whole business/ })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Sign up free" }).length).toBeGreaterThan(0);
    await waitFor(() => expect(meta('meta[name="robots"]')).toBe("index, follow"));
    expect(document.title).toMatch(/^Blinxot/);
    expect(meta('link[rel="canonical"]')).toBe(`${window.location.origin}/`);
    expect(meta('meta[property="og:title"]')).toMatch(/Blinxot/);
    expect(meta('meta[property="og:image"]')).toMatch(/og-image\.png$/);
    expect(ld()["@graph"].map((x: any) => x["@type"])).toEqual(["Organization", "WebSite"]);
    expect(document.body.textContent).not.toMatch(/Univora|Fynlo|Inventra|\{\{|lorem ipsum/i);
    await audit("home");
  });

  it("shows 'Open app' instead of sign-up when already signed in", async () => {
    const { s, email } = await seedUser("individual"); void email;
    renderApp("/", s);
    expect((await screen.findAllByRole("link", { name: "Open app" })).length).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: "Sign up free" })).toBeNull();
  });

  it("collapses navigation into a menu on phones: toggle, aria state, Escape and navigation close it", async () => {
    const user = userEvent.setup(); renderApp("/features");
    await screen.findByRole("heading", { level: 1, name: "Features" });
    const burger = screen.getByRole("button", { name: "Open menu" });
    expect(burger).toHaveAttribute("aria-expanded", "false");
    await user.click(burger);
    expect(screen.getByRole("button", { name: "Close menu" })).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById("pub-nav")).toHaveClass("open");
    await user.keyboard("{Escape}");
    expect(document.getElementById("pub-nav")).not.toHaveClass("open");
    await user.click(screen.getByRole("button", { name: "Open menu" }));
    await user.click(within(document.getElementById("pub-nav")!).getByRole("link", { name: "Pricing" }));
    await screen.findByRole("heading", { level: 1, name: /pricing/i });
    await waitFor(() => expect(document.getElementById("pub-nav")).not.toHaveClass("open"));
  });

  it("pricing lists the real plans from the database, with honest calls to action", async () => {
    renderApp("/pricing");
    await screen.findByRole("heading", { level: 2, name: "Free" });
    for (const n of ["Free", "Starter", "Pro", "Enterprise"]) expect(screen.getByRole("heading", { level: 2, name: n })).toBeInTheDocument();
    expect(screen.getByText(/₹999\.00/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Get started free" })).toHaveAttribute("href", "/register");
    expect(screen.getAllByRole("link", { name: "Talk to us" })).toHaveLength(3);
    expect(screen.getByText(/Online checkout is not enabled yet/)).toBeInTheDocument();
    await audit("pricing");
  });

  it("contact shows the support email only once an admin has configured it", async () => {
    const { unmount } = renderApp("/contact"); await screen.findByText(/support address is being set up/); unmount();
    const admin = await seedAdmin();
    await admin.s.req("PUT", "/api/admin/settings/support_email", { value: "help@blinxot.example" });
    renderApp("/contact");
    expect(await screen.findByRole("link", { name: "help@blinxot.example" })).toHaveAttribute("href", "mailto:help@blinxot.example");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByText(/Validation failed/)).toBeInTheDocument();                  // server-side validation surfaces
    await user.type(screen.getByLabelText("Your name"), "Ravi"); await user.type(screen.getByLabelText("Email"), "ravi@example.com");
    await user.type(screen.getByLabelText("Message"), "Please tell me about the Pro plan.");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByText(/your message has been sent/)).toBeInTheDocument();
    await audit("contact");
  });

  it("auth pages are noindex and unknown URLs get a noindex not-found page", async () => {
    const a = renderApp("/login"); await screen.findByRole("heading", { level: 1, name: "Log in" });
    expect(meta('meta[name="robots"]')).toBe("noindex, nofollow"); expect(document.head.querySelector('link[rel="canonical"]')).toBeNull(); a.unmount();
    renderApp("/definitely/not/a/page");
    expect(await screen.findByText(/couldn't find that page/)).toBeInTheDocument();
    expect(meta('meta[name="robots"]')).toBe("noindex, nofollow");
  });
});

describe("discovery and public profiles", () => {
  it("discovers a business, searches, and opens its full public profile with hours, social links and structured data", async () => {
    const b = await seedBusiness("Sunrise Traders");
    await b.owner.s.req("PATCH", b.base, { description: "Wholesale groceries", category: "Retail", phone: "+91 98290 00000", email: "hello@sunrise.example", website: "https://sunrise.example",
      businessHours: { mon: { open: "09:00", close: "18:00" }, sun: { closed: true } }, socialLinks: { instagram: "https://instagram.com/sunrise" } });
    const p = (await b.owner.s.req("POST", `${b.base}/products`, { name: "Basmati Rice 5kg", sku: `R-${Date.now()}`, sellingPrice: 540, openingStock: 20, taxRate: 5 })).product;
    await pool.query("UPDATE products SET is_listed=true WHERE id=$1", [p.id]);
    await seedBusiness("Other Shop Co");

    const user = userEvent.setup(); const first = renderApp("/discover");
    expect(await screen.findByRole("link", { name: /Sunrise Traders/ })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Search"), "Sunrise");
    await waitFor(() => expect(screen.queryByRole("link", { name: /Other Shop Co/ })).toBeNull());
    await user.click(screen.getByRole("link", { name: /Sunrise Traders/ }));

    expect(await screen.findByRole("heading", { level: 1, name: "Sunrise Traders" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Basmati Rice 5kg" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "hello@sunrise.example" })).toHaveAttribute("href", "mailto:hello@sunrise.example");
    expect(screen.getByRole("link", { name: "Instagram" })).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(screen.getByRole("row", { name: /Monday 09:00 – 18:00/ })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Sunday Closed/ })).toBeInTheDocument();
    const slug = (await pool.query("SELECT slug FROM businesses WHERE id=$1", [b.biz.id])).rows[0].slug;
    await waitFor(() => expect(meta('link[rel="canonical"]')).toBe(`${window.location.origin}/b/${slug}`));
    expect(ld()).toMatchObject({ "@type": "LocalBusiness", name: "Sunrise Traders", telephone: "+91 98290 00000", sameAs: ["https://instagram.com/sunrise"] });
    expect(ld().openingHoursSpecification[0]).toMatchObject({ dayOfWeek: "Monday", opens: "09:00", closes: "18:00" });
    await audit("business profile"); first.unmount();
  });

  it("never renders a script URL as a link, even if bad data reached the database", async () => {
    const b = await seedBusiness("Sneaky Ltd");
    await pool.query(`UPDATE businesses SET website='javascript:alert(1)', social_links='{"x":"javascript:alert(2)","facebook":"https://facebook.com/ok"}' WHERE id=$1`, [b.biz.id]);
    const slug = (await pool.query("SELECT slug FROM businesses WHERE id=$1", [b.biz.id])).rows[0].slug;
    renderApp(`/b/${slug}`);
    await screen.findByRole("heading", { level: 1, name: "Sneaky Ltd" });
    expect(screen.getByRole("link", { name: "Facebook" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "X" })).toBeNull();
    expect([...document.querySelectorAll("a")].some((a) => /^javascript:/i.test(a.getAttribute("href") ?? ""))).toBe(false);
  });

  it("escapes structured data so a hostile name cannot close the script tag", async () => {
    const b = await seedBusiness("</script><img src=x onerror=alert(1)>");
    const slug = (await pool.query("SELECT slug FROM businesses WHERE id=$1", [b.biz.id])).rows[0].slug;
    renderApp(`/b/${slug}`);
    await screen.findByRole("heading", { level: 1 });
    await waitFor(() => expect(document.getElementById("bx-jsonld")).not.toBeNull());
    const el = document.getElementById("bx-jsonld")!;
    expect(el.textContent).not.toContain("</script>"); expect(ld().name).toBe("</script><img src=x onerror=alert(1)>");
    expect(document.querySelector("img[src='x']")).toBeNull();
  });

  it("hides private and suspended businesses behind a not-found page", async () => {
    const priv = await seedBusiness("Hidden Co"); await priv.owner.s.req("PATCH", priv.base, { isPublic: false });
    const slug = (await pool.query("SELECT slug FROM businesses WHERE id=$1", [priv.biz.id])).rows[0].slug;
    const r = renderApp(`/b/${slug}`); expect(await screen.findByText(/couldn't find that business/)).toBeInTheDocument();
    expect(meta('meta[name="robots"]')).toBe("noindex, nofollow"); r.unmount();
    renderApp("/discover"); await screen.findByRole("heading", { level: 1, name: "Discover businesses" });
    await waitFor(() => expect(screen.queryByRole("link", { name: /Hidden Co/ })).toBeNull());
  });

  it("shows a listed product with price, stock status and a login prompt for visitors", async () => {
    const b = await seedBusiness("Gadget House");
    const p = (await b.owner.s.req("POST", `${b.base}/products`, { name: "Desk Lamp", sku: `L-${Date.now()}`, sellingPrice: 799, openingStock: 3, description: "Warm LED lamp" })).product;
    await pool.query("UPDATE products SET is_listed=true WHERE id=$1", [p.id]);
    renderApp(`/products/${p.id}`);
    expect(await screen.findByRole("heading", { level: 1, name: "Desk Lamp" })).toBeInTheDocument();
    expect(screen.getByText(/₹799\.00/)).toBeInTheDocument(); expect(screen.getByText("In stock")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log in to buy" })).toBeInTheDocument();
    await waitFor(() => expect(ld()).not.toBeNull());
    expect(ld()).toMatchObject({ "@type": "Product", name: "Desk Lamp", offers: { price: 799, priceCurrency: "INR", availability: "https://schema.org/InStock" } });
    expect(JSON.stringify(ld())).not.toMatch(/costPrice|cost_price|stockQty/);
    await audit("product page");
  });

  it("browses and filters products", async () => {
    const user = userEvent.setup(); renderApp("/products");
    await screen.findByRole("heading", { level: 1, name: "Browse products" });
    expect(await screen.findByRole("link", { name: /Desk Lamp/ })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Search"), "zzzz-nothing");
    expect(await screen.findByText("No products found")).toBeInTheDocument();
    await audit("product discovery");
  });

  it("publishes a person's profile only when they chose to, and never their contact details", async () => {
    const { s, id } = await seedUser("individual", "Asha Verma");
    await s.req("PATCH", "/api/me/profile", { headline: "Electrician", bio: "10 years on site", city: "Udaipur", phone: "+91 90000 11111", isPublic: true });
    await s.req("PUT", "/api/me/skills", { skills: ["Wiring", "Solar"] });
    await s.req("POST", "/api/me/experience", { company: "Bright Works", role: "Lead electrician", startDate: "2018-01-01" });
    const slug = (await pool.query("SELECT slug FROM profiles WHERE user_id=$1", [id])).rows[0].slug;
    const a = renderApp(`/p/${slug}`);
    expect(await screen.findByRole("heading", { level: 1, name: "Asha Verma" })).toBeInTheDocument();
    expect(screen.getByText("Wiring")).toBeInTheDocument(); expect(screen.getByText(/Lead electrician/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/90000 11111|@example\.com/);
    await waitFor(() => expect(ld()).not.toBeNull());
    expect(ld()).toMatchObject({ "@type": "Person", name: "Asha Verma", jobTitle: "Electrician" }); await audit("person profile"); a.unmount();

    await s.req("PATCH", "/api/me/profile", { isPublic: false });
    renderApp(`/p/${slug}`); expect(await screen.findByText(/couldn't find that profile/)).toBeInTheDocument();
  });

  it("lists open jobs publicly and links to the detail page", async () => {
    const b = await seedBusiness("Hire Right Co");
    const job = (await b.owner.s.req("POST", `${b.base}/jobs`, { title: "Store Associate", description: "Help customers and manage shelves.", workType: "full_time", location: "Udaipur", skills: ["Retail"] })).job;
    await b.owner.s.req("PATCH", `${b.base}/jobs/${job.id}`, { status: "open" });
    const user = userEvent.setup(); const a = renderApp("/jobs");
    await user.click(await screen.findByRole("link", { name: /Store Associate/ }));
    expect(await screen.findByRole("heading", { level: 1, name: "Store Associate" })).toBeInTheDocument();
    await waitFor(() => expect(ld()).not.toBeNull());
    expect(ld()).toMatchObject({ "@type": "JobPosting", title: "Store Associate", hiringOrganization: { name: "Hire Right Co" } });
    expect(screen.getByRole("button", { name: "Log in to apply" })).toBeInTheDocument(); void job; a.unmount();
  });
});

describe("login redirect after public browsing", () => {
  it("returns a visitor to the app after logging in from a public page", async () => {
    const email = uniqueEmail("v"); const s = (await import("./harness")).Session; const sess = new s();
    await sess.req("POST", "/api/auth/register", { email, password: PASSWORD, fullName: "V", accountType: "individual" });
    await sess.req("POST", "/api/auth/verify-email", { token: tokenFor(email) });
    const user = userEvent.setup(); renderApp("/login", sess);
    await user.type(await screen.findByLabelText("Email"), email); await user.type(screen.getByLabelText("Password"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByRole("navigation", { name: "Main" })).toBeInTheDocument();      // the signed-in app shell
  });
});

describe("signed-in users keep the app around discovery pages", () => {
  it("shows the app sidebar (no public header/footer) for a signed-in individual, and the public layout for visitors", async () => {
    const b = await seedBusiness("Layout Co"); const buyer = await seedUser("individual", "Layla");
    const p = (await b.owner.s.req("POST", `${b.base}/products`, { name: "Layout Lamp", sellingPrice: 100, openingStock: 3 })).product;
    await pool.query("UPDATE products SET is_listed=true WHERE id=$1", [p.id]);
    const slug = (await pool.query("SELECT slug FROM businesses WHERE id=$1", [b.biz.id])).rows[0].slug;

    for (const path of [`/b/${slug}`, `/products/${p.id}`, "/discover", "/products", "/jobs"]) {
      const inApp = renderApp(path, buyer.s);
      expect(await screen.findByRole("complementary", { name: "Sidebar" }), path).toBeInTheDocument();
      expect(screen.queryByRole("contentinfo"), path).toBeNull();                              // the public footer
      expect(screen.queryByRole("link", { name: "Sign up free" }), path).toBeNull();           // the public header
      expect(within(screen.getByRole("complementary", { name: "Sidebar" })).getAllByRole("link", { name: "My orders" }).length).toBeGreaterThan(0);
      inApp.unmount();
    }
    const first = renderApp(`/b/${slug}`, buyer.s);
    expect(await screen.findByRole("heading", { level: 1, name: "Layout Co" })).toBeInTheDocument();       // the business details are still all there
    expect(await screen.findByRole("link", { name: "Layout Lamp" })).toBeInTheDocument(); first.unmount();

    const guest = renderApp(`/b/${slug}`);
    await screen.findByRole("heading", { level: 1, name: "Layout Co" });
    expect(screen.getByRole("contentinfo")).toBeInTheDocument(); expect(screen.queryByRole("complementary", { name: "Sidebar" })).toBeNull();
    expect(screen.getAllByRole("link", { name: "Sign up free" }).length).toBeGreaterThan(0); guest.unmount();
  });

  it("keeps marketing pages on the public layout even when signed in", async () => {
    const buyer = await seedUser("individual", "Marla");
    renderApp("/pricing", buyer.s);
    await screen.findByRole("heading", { level: 1, name: /pricing/i });
    expect(screen.getByRole("contentinfo")).toBeInTheDocument(); expect(screen.queryByRole("complementary", { name: "Sidebar" })).toBeNull();
  });
});
