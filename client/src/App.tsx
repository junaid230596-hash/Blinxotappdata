import { lazy, Suspense, type ReactElement } from "react";
import { Link, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { AdminGuard } from "./components/AdminGuard";
import { Shell } from "./components/Shell";
import { InstallPrompt, OfflineBanner, UpdatePrompt } from "./components/InstallPrompt";
import { Card, Empty, Spinner } from "./components/ui";
import { useAuth } from "./lib/auth";
import { useBusiness } from "./lib/business";
import { Forgot, GuestOnly, Login, Register, Reset, VerifyEmail } from "./pages/auth";

// Pages are split into separate chunks so the first screen loads quickly on mobile networks.
const Dashboard = lazy(() => import("./pages/dashboard"));
const CreateBusinessPage = lazy(() => import("./pages/business"));
const Notifications = lazy(() => import("./pages/notifications"));
const lazyNamed = <K extends string>(load: () => Promise<Record<K, any>>, name: K) => lazy(() => load().then((m) => ({ default: m[name] })));
const Products = lazyNamed(() => import("./pages/products"), "Products"), ProductForm = lazyNamed(() => import("./pages/products"), "ProductForm"), Categories = lazyNamed(() => import("./pages/products"), "Categories");
const Inventory = lazyNamed(() => import("./pages/inventory"), "Inventory"), Movements = lazyNamed(() => import("./pages/inventory"), "Movements"), LowStock = lazyNamed(() => import("./pages/inventory"), "LowStock");
const Orders = lazyNamed(() => import("./pages/orders"), "Orders"), NewOrder = lazyNamed(() => import("./pages/orders"), "NewOrder"), OrderDetail = lazyNamed(() => import("./pages/orders"), "OrderDetail");
const Customers = lazyNamed(() => import("./pages/customers"), "Customers"), CustomerDetail = lazyNamed(() => import("./pages/customers"), "CustomerDetail");
const Employees = lazyNamed(() => import("./pages/team"), "Employees"), EmployeeForm = lazyNamed(() => import("./pages/team"), "EmployeeForm"), Attendance = lazyNamed(() => import("./pages/team"), "Attendance"), Tasks = lazyNamed(() => import("./pages/team"), "Tasks");
const Suppliers = lazyNamed(() => import("./pages/purchasing"), "Suppliers"), Purchases = lazyNamed(() => import("./pages/purchasing"), "Purchases"), NewPurchase = lazyNamed(() => import("./pages/purchasing"), "NewPurchase"), PurchaseDetail = lazyNamed(() => import("./pages/purchasing"), "PurchaseDetail"), Marketplace = lazyNamed(() => import("./pages/purchasing"), "Marketplace"), Returns = lazyNamed(() => import("./pages/purchasing"), "Returns");
const CrmOverview = lazyNamed(() => import("./pages/crm"), "CrmOverview"), Leads = lazyNamed(() => import("./pages/crm"), "Leads"), Contacts = lazyNamed(() => import("./pages/crm"), "Contacts"), Companies = lazyNamed(() => import("./pages/crm"), "Companies"), Pipeline = lazyNamed(() => import("./pages/crm"), "Pipeline"), FollowUps = lazyNamed(() => import("./pages/crm"), "FollowUps");
const Reports = lazy(() => import("./pages/reports"));
const Leave = lazyNamed(() => import("./pages/hr"), "Leave"), Performance = lazyNamed(() => import("./pages/hr"), "Performance"), Documents = lazyNamed(() => import("./pages/hr"), "Documents"), EmployeeDocuments = lazyNamed(() => import("./pages/hr"), "EmployeeDocuments");
const JobPostings = lazyNamed(() => import("./pages/tools"), "JobPostings"), Applicants = lazyNamed(() => import("./pages/tools"), "Applicants"), Advertisements = lazyNamed(() => import("./pages/tools"), "Advertisements"), Settings = lazyNamed(() => import("./pages/tools"), "Settings"), Subscription = lazyNamed(() => import("./pages/tools"), "Subscription"), Reputation = lazyNamed(() => import("./pages/tools"), "Reputation"), MyReviews = lazyNamed(() => import("./pages/tools"), "MyReviews");
const AdminUsers = lazyNamed(() => import("./pages/admin"), "AdminUsers"), AdminBusinesses = lazyNamed(() => import("./pages/admin"), "AdminBusinesses"), AdminEmployees = lazyNamed(() => import("./pages/admin"), "AdminEmployees"), AdminProducts = lazyNamed(() => import("./pages/admin"), "AdminProducts"), AdminOrders = lazyNamed(() => import("./pages/admin"), "AdminOrders"), AdminReviews = lazyNamed(() => import("./pages/admin"), "AdminReviews"), AdminAds = lazyNamed(() => import("./pages/admin"), "AdminAds"), AdminAudit = lazyNamed(() => import("./pages/admin"), "AdminAudit"), AdminCategories = lazyNamed(() => import("./pages/admin"), "AdminCategories"), AdminSettings = lazyNamed(() => import("./pages/admin"), "AdminSettings");
const PublicLayout = lazyNamed(() => import("./pages/public"), "PublicLayout"), Home = lazyNamed(() => import("./pages/public"), "Home"), Features = lazyNamed(() => import("./pages/public"), "Features"), Pricing = lazyNamed(() => import("./pages/public"), "Pricing"), About = lazyNamed(() => import("./pages/public"), "About"), Contact = lazyNamed(() => import("./pages/public"), "Contact");
const Discover = lazyNamed(() => import("./pages/public"), "Discover"), ProductDiscovery = lazyNamed(() => import("./pages/public"), "ProductDiscovery"), ProductDetail = lazyNamed(() => import("./pages/public"), "ProductDetail"), BusinessProfile = lazyNamed(() => import("./pages/public"), "BusinessProfile"), PersonProfile = lazyNamed(() => import("./pages/public"), "PersonProfile"), PublicJobs = lazyNamed(() => import("./pages/public"), "PublicJobs"), PublicJobDetail = lazyNamed(() => import("./pages/public"), "PublicJobDetail"), PublicNotFound = lazyNamed(() => import("./pages/public"), "PublicNotFound");
const Invoices = lazyNamed(() => import("./pages/invoices"), "Invoices"), InvoiceView = lazyNamed(() => import("./pages/invoices"), "InvoiceView"), MyInvoiceView = lazyNamed(() => import("./pages/invoices"), "MyInvoiceView");
const Shop = lazyNamed(() => import("./pages/shop"), "Shop"), CartPage = lazyNamed(() => import("./pages/shop"), "CartPage"), MyOrders = lazyNamed(() => import("./pages/shop"), "MyOrders"), MyOrderDetail = lazyNamed(() => import("./pages/shop"), "MyOrderDetail");
const Profile = lazyNamed(() => import("./pages/people"), "Profile"), Jobs = lazyNamed(() => import("./pages/people"), "Jobs"), Applications = lazyNamed(() => import("./pages/people"), "Applications");

function RequireAuth() {
  const { user, loading } = useAuth(); const loc = useLocation();
  if (loading) return <Spinner />;
  return user ? <Outlet /> : <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
}

/** Screens that belong to a business need one selected and the matching permission; otherwise show a clear message, never a broken page. */
function Guard({ perm, children }: { perm?: string[]; children: ReactElement }) {
  const biz = useBusiness(); const { user } = useAuth();
  if (biz.loading || (biz.current && !biz.permissionsReady)) return <Spinner />;     // never flash "no access" while permissions are still loading
  if (!biz.current) return <Card><Empty title="No business selected" action={user?.accountType === "business_owner" || user?.accountType === "supplier" ? <Link className="btn btn-primary" to="/app/business/new">Create your business</Link> : undefined}>This page needs a business. Create one or ask to be added to one.</Empty></Card>;
  if (perm && !biz.can(...perm)) return <Card><Empty title="You don't have access to this page">Ask a business admin if you need it.</Empty></Card>;
  return children;
}
/** Discovery and detail pages (businesses, products, profiles, jobs) look like the app when you are signed in (sidebar, top bar) and like the public site when you are not. */
function AdaptiveLayout() {
  const { user, loading } = useAuth();
  if (loading) return <Spinner />;
  return user ? <Shell /> : <PublicLayout />;
}
/** Shopping screens are for individual accounts (businesses buy through Purchasing). */
function IndividualOnly({ children }: { children: ReactElement }) {
  const { user } = useAuth();
  if (user?.accountType !== "individual") return <Card><Empty title="Shopping is for individual accounts">Businesses buy from other businesses under Purchasing → Marketplace.</Empty></Card>;
  return children;
}
const G = (perm: string[] | undefined, el: ReactElement) => <Guard perm={perm}>{el}</Guard>;
const AG = (el: ReactElement) => <AdminGuard>{el}</AdminGuard>;
const NotFoundCard = () => <Card><Empty title="Page not found" action={<Link className="btn btn-primary" to="/app">Back to dashboard</Link>}>We couldn't find what you were looking for.</Empty></Card>;

export default function App() {
  return (
    <>
    <OfflineBanner /><UpdatePrompt />
    <Suspense fallback={<Spinner />}>
      <Routes>
        <Route path="/login" element={<GuestOnly><Login /></GuestOnly>} />
        <Route path="/register" element={<GuestOnly><Register /></GuestOnly>} />
        <Route path="/forgot-password" element={<Forgot />} />
        <Route path="/reset-password" element={<Reset />} />
        <Route path="/verify-email" element={<VerifyEmail />} />
        <Route path="/app" element={<RequireAuth />}>
          <Route element={<Shell />}>
            <Route index element={<Dashboard />} />
            <Route path="business/new" element={<CreateBusinessPage />} />
            <Route path="notifications" element={<Notifications />} />
            <Route path="products" element={G(["products.view"], <Products />)} />
            <Route path="products/new" element={G(["products.manage"], <ProductForm />)} />
            <Route path="products/:id" element={G(["products.view"], <ProductForm />)} />
            <Route path="categories" element={G(["products.view"], <Categories />)} />
            <Route path="inventory" element={G(["inventory.view"], <Inventory />)} />
            <Route path="inventory/movements" element={G(["inventory.view"], <Movements />)} />
            <Route path="inventory/low" element={G(["inventory.view"], <LowStock />)} />
            <Route path="orders" element={G(["orders.view"], <Orders />)} />
            <Route path="orders/new" element={G(["orders.create"], <NewOrder />)} />
            <Route path="orders/:id" element={G(["orders.view"], <OrderDetail />)} />
            <Route path="invoices" element={G(["orders.view"], <Invoices />)} />
            <Route path="invoices/:id" element={G(["orders.view"], <InvoiceView />)} />
            <Route path="customers" element={G(["customers.view"], <Customers />)} />
            <Route path="customers/:id" element={G(["customers.view"], <CustomerDetail />)} />
            <Route path="employees" element={G(["employees.view"], <Employees />)} />
            <Route path="employees/new" element={G(["employees.create"], <EmployeeForm />)} />
            <Route path="attendance" element={G(undefined, <Attendance />)} />
            <Route path="tasks" element={G(["tasks.view"], <Tasks />)} />
            <Route path="returns" element={G(["orders.view"], <Returns />)} />
            <Route path="suppliers" element={G(["purchases.view"], <Suppliers />)} />
            <Route path="purchases" element={G(["purchases.view"], <Purchases />)} />
            <Route path="purchases/new" element={G(["purchases.manage"], <NewPurchase />)} />
            <Route path="purchases/:id" element={G(["purchases.view"], <PurchaseDetail />)} />
            <Route path="marketplace" element={G(["purchases.manage"], <Marketplace />)} />
            <Route path="crm" element={G(["crm.view"], <CrmOverview />)} />
            <Route path="crm/leads" element={G(["crm.view"], <Leads />)} />
            <Route path="crm/contacts" element={G(["crm.view"], <Contacts />)} />
            <Route path="crm/companies" element={G(["crm.view"], <Companies />)} />
            <Route path="crm/pipeline" element={G(["crm.view"], <Pipeline />)} />
            <Route path="crm/activities" element={G(["crm.view"], <FollowUps />)} />
            <Route path="reports" element={G(["reports.view"], <Reports />)} />
            <Route path="leave" element={G(undefined, <Leave />)} />
            <Route path="performance" element={G(undefined, <Performance />)} />
            <Route path="documents" element={G(undefined, <Documents />)} />
            <Route path="employees/:id/documents" element={G(["documents.view"], <EmployeeDocuments />)} />
            <Route path="jobs/manage" element={G(["jobs.manage"], <JobPostings />)} />
            <Route path="applicants" element={G(["jobs.manage"], <Applicants />)} />
            <Route path="ads" element={G(["ads.manage"], <Advertisements />)} />
            <Route path="settings" element={G(undefined, <Settings />)} />
            <Route path="subscription" element={G(undefined, <Subscription />)} />
            <Route path="reputation" element={G(["business.manage"], <Reputation />)} />
            <Route path="my-reviews" element={<MyReviews />} />
            <Route path="shop" element={<IndividualOnly><Shop /></IndividualOnly>} />
            <Route path="cart" element={<IndividualOnly><CartPage /></IndividualOnly>} />
            <Route path="my-orders" element={<IndividualOnly><MyOrders /></IndividualOnly>} />
            <Route path="my-orders/:id/invoice" element={<IndividualOnly><MyInvoiceView /></IndividualOnly>} />
            <Route path="my-orders/:id" element={<IndividualOnly><MyOrderDetail /></IndividualOnly>} />
            <Route path="admin/users" element={AG(<AdminUsers />)} />
            <Route path="admin/businesses" element={AG(<AdminBusinesses />)} />
            <Route path="admin/employees" element={AG(<AdminEmployees />)} />
            <Route path="admin/products" element={AG(<AdminProducts />)} />
            <Route path="admin/orders" element={AG(<AdminOrders />)} />
            <Route path="admin/reviews" element={AG(<AdminReviews />)} />
            <Route path="admin/ads" element={AG(<AdminAds />)} />
            <Route path="admin/audit" element={AG(<AdminAudit />)} />
            <Route path="admin/categories" element={AG(<AdminCategories />)} />
            <Route path="admin/settings" element={AG(<AdminSettings />)} />
            <Route path="profile" element={<Profile />} />
            <Route path="jobs" element={<Jobs />} />
            <Route path="applications" element={<Applications />} />
            <Route path="*" element={<NotFoundCard />} />
          </Route>
        </Route>
        <Route element={<PublicLayout />}>
          <Route path="/" element={<Home />} />
          <Route path="/features" element={<Features />} />
          <Route path="/pricing" element={<Pricing />} />
          <Route path="/about" element={<About />} />
          <Route path="/contact" element={<Contact />} />
          <Route path="*" element={<PublicNotFound />} />
        </Route>
        <Route element={<AdaptiveLayout />}>
          <Route path="/discover" element={<Discover />} />
          <Route path="/products" element={<ProductDiscovery />} />
          <Route path="/products/:id" element={<ProductDetail />} />
          <Route path="/b/:slug" element={<BusinessProfile />} />
          <Route path="/p/:slug" element={<PersonProfile />} />
          <Route path="/jobs" element={<PublicJobs />} />
          <Route path="/jobs/:id" element={<PublicJobDetail />} />
        </Route>
      </Routes>
    </Suspense>
    <InstallPrompt />
    </>
  );
}
