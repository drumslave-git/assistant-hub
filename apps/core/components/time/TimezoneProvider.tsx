"use client";

import { createContext, useContext } from "react";

/**
 * The operator timezone (Settings → Timezone), made available to every component
 * under the app shell. The root layout reads it from the database once per
 * request and seeds this provider, so server- and client-rendered timestamps
 * agree and no component has to thread the zone through props.
 */
const TimezoneContext = createContext<string>("UTC");

export function TimezoneProvider({
  timezone,
  children,
}: {
  timezone: string;
  children: React.ReactNode;
}) {
  return <TimezoneContext.Provider value={timezone}>{children}</TimezoneContext.Provider>;
}

/** The configured IANA timezone (`UTC` until settings say otherwise). */
export function useTimezone(): string {
  return useContext(TimezoneContext);
}
