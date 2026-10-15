import type { ReactElement } from "react";
import { useAuth } from "../lib/auth";
import { Card, Empty } from "./ui";

/** Platform administration is limited to Blinxot administrators; everyone else sees a clear message. */
export function AdminGuard({ children }: { children: ReactElement }) {
  const { user } = useAuth();
  return user?.accountType === "super_admin" ? children : <Card><Empty title="You don't have access to this page">Platform administration is limited to Blinxot administrators.</Empty></Card>;
}
