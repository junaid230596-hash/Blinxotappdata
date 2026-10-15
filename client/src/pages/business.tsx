import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, post } from "../lib/api";
import { useBusiness } from "../lib/business";
import { useTitle } from "../lib/hooks";
import { useToast } from "../lib/toast";
import { Button, Card, PageHeader, TextArea, TextField } from "../components/ui";

export function CreateBusinessPrompt() {
  return <Card><div className="stack"><h2>Set up your business</h2><p>Create your business profile to start managing products, orders, people and customers.</p><CreateBusinessForm /></div></Card>;
}

export function CreateBusinessForm() {
  const biz = useBusiness(); const nav = useNavigate(); const { toast } = useToast();
  const [f, setF] = useState({ name: "", category: "", description: "", phone: "", email: "", address: "", website: "" });
  const [errors, setErrors] = useState<Record<string, string>>({}); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(""); setErrors({});
    const body = Object.fromEntries(Object.entries(f).filter(([, v]) => v.trim() !== ""));
    try {
      const r = await post<{ business: { id: string } }>("/api/businesses", body);
      localStorage.setItem("bx_biz", r.business.id); await biz.reload(); toast("Business created"); nav("/app");
    } catch (err) {
      if (err instanceof ApiError) { setErrors(err.details && typeof err.details === "object" && err.code === "BAD_REQUEST" ? err.details : {}); setError(err.message); } else setError("Something went wrong. Please try again.");
    } finally { setBusy(false); }
  };
  return (
    <form className="stack" onSubmit={submit} noValidate>
      {error && <div className="banner error" role="alert">{error}</div>}
      <div className="form-grid">
        <TextField label="Business name" required value={f.name} onChange={set("name")} error={errors.name} />
        <TextField label="Category" value={f.category} onChange={set("category")} hint="For example: Retail, Restaurant, Services" error={errors.category} />
        <TextField label="Phone" type="tel" inputMode="tel" value={f.phone} onChange={set("phone")} error={errors.phone} />
        <TextField label="Business email" type="email" value={f.email} onChange={set("email")} error={errors.email} />
        <TextField label="Website" type="url" inputMode="url" value={f.website} onChange={set("website")} error={errors.website} hint="Include https://" />
        <TextField label="Address" value={f.address} onChange={set("address")} error={errors.address} />
      </div>
      <TextArea label="Description" value={f.description} onChange={set("description")} error={errors.description} />
      <div className="actions"><Button type="submit" variant="primary" loading={busy}>Create business</Button></div>
    </form>
  );
}

export default function CreateBusinessPage() {
  useTitle("Create business");
  return <div className="stack"><PageHeader title="Create a business" crumbs={[{ to: "/app", label: "Dashboard" }, { label: "New business" }]} /><Card><CreateBusinessForm /></Card></div>;
}
