import { useState, type FormEvent } from "react";
import { ApiError, post } from "../lib/api";
import { useFetch } from "../lib/hooks";
import { useToast } from "../lib/toast";
import { Button, ErrorState, Modal, Spinner, TextArea } from "./ui";

/** Leave a rating. The server only allows it when you've genuinely dealt with the subject (worked, interviewed, or received an order). */
export function ReviewModal({ subjectType, subjectId, subjectName, onClose }: { subjectType: "business" | "individual"; subjectId: string; subjectName: string; onClose: () => void }) {
  const { toast } = useToast(); const check = useFetch<any>(`/api/reviews/can-review?subjectType=${subjectType}&subjectId=${subjectId}`);
  const [rating, setRating] = useState(0); const [body, setBody] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault(); if (!rating) return setError("Choose a star rating.");
    setBusy(true); setError("");
    try { await post("/api/reviews", { subjectType, subjectId, rating, ...(body.trim() ? { body: body.trim() } : {}) }); toast("Thanks, your review is published"); onClose(); }
    catch (err) { setError(err instanceof ApiError ? err.message : "Could not save your review"); } finally { setBusy(false); }
  };
  return (
    <Modal open title={`Review ${subjectName}`} onClose={onClose}>
      {check.error ? <ErrorState error={check.error} retry={check.reload} /> : check.loading && !check.data ? <Spinner /> : !check.data.eligible ? (
        <div className="stack"><p>{check.data.reason}</p><div className="actions"><Button onClick={onClose}>Close</Button></div></div>
      ) : check.data.existingReviewId ? (
        <div className="stack"><p>You have already reviewed {subjectName}. Thank you!</p><div className="actions"><Button onClick={onClose}>Close</Button></div></div>
      ) : (
        <form className="stack" onSubmit={submit} noValidate>
          {error && <div className="banner error" role="alert">{error}</div>}
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend style={{ fontWeight: 600, marginBottom: 6 }}>Your rating</legend>
            <div className="row" role="radiogroup" aria-label="Rating">
              {[1, 2, 3, 4, 5].map((n) => (
                <label key={n} className="btn" style={{ borderColor: rating >= n ? "var(--brand)" : undefined, background: rating >= n ? "var(--brand-soft)" : undefined }}>
                  <input type="radio" name="rating" value={n} checked={rating === n} onChange={() => setRating(n)} className="sr-only" />
                  <span aria-hidden="true">{rating >= n ? "★" : "☆"}</span><span className="sr-only">{n} star{n > 1 ? "s" : ""}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <TextArea label="Your experience (optional)" value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} hint="Links aren't allowed. Be honest and respectful." />
          <div className="actions"><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={busy}>Publish review</Button></div>
        </form>
      )}
    </Modal>
  );
}
