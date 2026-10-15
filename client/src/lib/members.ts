import { useBusiness } from "./business";
import { useFetch } from "./hooks";

/** People in the current business, as <select> options. Empty (and no request) when the user can't list members. */
export function useMembers(): { options: [string, string][]; byId: Record<string, string> } {
  const { current, can } = useBusiness();
  const { data } = useFetch<any>(current && can("members.view") ? `/api/businesses/${current.id}/members` : null);
  const list: any[] = data?.members ?? [];
  return { options: list.map((m) => [m.userId, m.fullName] as [string, string]), byId: Object.fromEntries(list.map((m) => [m.userId, m.fullName])) };
}
