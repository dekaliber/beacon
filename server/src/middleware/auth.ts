import { getAuth } from "@clerk/express";
import type { Request } from "express";

/**
 * Returns the authenticated user's Clerk userId from the request.
 * Only call this inside routes protected by requireAuth() — userId is
 * guaranteed to be non-null there.
 */
export function getUserId(req: Request): string {
  const { userId } = getAuth(req);
  if (!userId) throw new Error("Unauthenticated");
  return userId;
}
