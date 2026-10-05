import { createContext, useContext } from "react";
import type { SharedOptionsData } from "@/api";

/**
 * Present only on the public read-only share page (/share/options/:token).
 * Options components read it to swap their data source to the share feed and
 * to drop every control that would change something. null = the normal,
 * authenticated page.
 */
export interface SharedOptions {
  token: string;
  data: SharedOptionsData;
}

const SharedOptionsContext = createContext<SharedOptions | null>(null);

export const SharedOptionsProvider = SharedOptionsContext.Provider;

export function useSharedOptions() {
  return useContext(SharedOptionsContext);
}
