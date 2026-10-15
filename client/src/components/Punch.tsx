import { useEffect, useState } from "react";
import { post } from "../lib/api";
import { useBusiness } from "../lib/business";
import { hm, dateTime } from "../lib/format";
import { useFetch } from "../lib/hooks";
import { useToast } from "../lib/toast";
import { ApiError } from "../lib/api";
import { Button, Card, ErrorState, Spinner } from "./ui";

/** Punch in/out. Time comes from the server; the clock here only displays elapsed time. */
export function PunchCard({ onChange }: { onChange?: () => void }) {
  const { current } = useBusiness(); const { toast } = useToast();
  const { data, error, loading, reload } = useFetch<any>(current ? `/api/businesses/${current.id}/me/today` : null);
  const [busy, setBusy] = useState(false); const [, setNow] = useState(0);
  useEffect(() => { const t = setInterval(() => setNow((n) => n + 1), 30_000); return () => clearInterval(t); }, []);
  if (!current) return null;
  if (loading && !data) return <Card><Spinner /></Card>;
  if (error) return <Card><ErrorState error={error} retry={reload} /></Card>;

  const act = async (what: "punch-in" | "punch-out") => {
    setBusy(true);
    try { await post(`/api/businesses/${current.id}/me/${what}`); toast(what === "punch-in" ? "Punched in. Have a good shift!" : "Punched out. See you next time!"); reload(); onChange?.(); }
    catch (e) { toast(e instanceof ApiError ? e.message : "Could not record your punch", "error"); reload(); } finally { setBusy(false); }
  };
  const open = data.openSession;
  const live = open ? Math.max(0, Math.floor((Date.now() - new Date(open.punchIn).getTime()) / 60000)) : 0;
  const minutes = data.sessions.reduce((n: number, s: any) => n + (s.minutesWorked ?? 0), 0) + live;
  return (
    <Card className="punch" title="Today">
      <div className="time" aria-live="polite">{hm(minutes)}</div>
      <p className="muted">{open ? `On the clock since ${dateTime(open.punchIn)}` : data.sessions.length ? "You are punched out" : "You haven't punched in today"}</p>
      <Button variant={open ? "danger" : "primary"} loading={busy} onClick={() => act(open ? "punch-out" : "punch-in")}>{open ? "Punch out" : "Punch in"}</Button>
      {data.sessions.some((s: any) => s.isLate) && <p className="small" style={{ marginTop: ".75rem" }}><span className="badge badge-warn">Late arrival recorded</span></p>}
    </Card>
  );
}
