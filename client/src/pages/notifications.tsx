import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, Card, Empty, ErrorState, PageHeader, Spinner } from "../components/ui";
import { ApiError, get, post } from "../lib/api";
import { dateTime } from "../lib/format";
import { useTitle } from "../lib/hooks";

const target = (n: any): string | null => {
  const d = n.data ?? {};
  if (d.orderId) return `/app/orders/${d.orderId}`; if (d.productId) return `/app/products/${d.productId}`; if (d.taskId) return "/app/tasks";
  if (d.applicationId && !d.businessId) return "/app/applications"; if (d.jobId) return "/app/jobs"; return null;
};

export default function Notifications() {
  useTitle("Notifications");
  const [items, setItems] = useState<any[]>([]); const [unread, setUnread] = useState(0); const [total, setTotal] = useState<number | null>(null); const [error, setError] = useState<ApiError | null>(null); const [loading, setLoading] = useState(true); const [only, setOnly] = useState(false);
  const load = useCallback(async (offset = 0) => {
    setLoading(true);
    try {
      const r = await get<any>(`/api/notifications?limit=20&offset=${offset}${only ? "&unread=true" : ""}`);
      setItems((l) => (offset ? [...l, ...r.notifications] : r.notifications)); setUnread(r.unreadCount); setTotal(r.notifications.length < 20 ? offset + r.notifications.length : null); setError(null);
    } catch (e) { setError(e as ApiError); } finally { setLoading(false); }
  }, [only]);
  useEffect(() => { load(0); }, [load]);
  const read = async (n: any) => { if (n.readAt) return; await post(`/api/notifications/${n.id}/read`).catch(() => {}); setItems((l) => l.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x))); setUnread((u) => Math.max(0, u - 1)); };
  return (
    <div className="stack">
      <PageHeader title="Notifications" crumbs={[{ to: "/app", label: "Dashboard" }, { label: "Notifications" }]}>
        <Button onClick={() => setOnly((o) => !o)} aria-pressed={only}>{only ? "Showing unread" : "Unread only"}</Button>
        <Button disabled={!unread} onClick={async () => { await post("/api/notifications/read-all"); setItems((l) => l.map((x) => ({ ...x, readAt: x.readAt ?? new Date().toISOString() }))); setUnread(0); }}>Mark all read</Button>
      </PageHeader>
      {error ? <ErrorState error={error} retry={() => load(0)} /> : loading && !items.length ? <Spinner /> : (
        <Card>
          {items.length ? <ul className="list">{items.map((n) => {
            const to = target(n);
            return (
              <li key={n.id} style={{ background: n.readAt ? undefined : "var(--brand-soft)", paddingInline: ".5rem", borderRadius: 8 }}>
                <span><strong>{n.title}</strong> {!n.readAt && <Badge tone="brand">New</Badge>}{n.body && <><br /><span className="muted">{n.body}</span></>}<br /><span className="muted small">{dateTime(n.createdAt)}</span></span>
                <span className="actions">{to && <Link className="btn btn-sm" to={to} onClick={() => read(n)}>View</Link>}{!n.readAt && <Button small onClick={() => read(n)}>Mark read</Button>}</span>
              </li>
            );
          })}</ul> : <Empty title={only ? "No unread notifications" : "You're all caught up"}>New activity will show up here.</Empty>}
          {total === null && items.length > 0 && <div className="actions" style={{ marginTop: "1rem" }}><Button loading={loading} onClick={() => load(items.length)}>Load more</Button></div>}
        </Card>
      )}
    </div>
  );
}
