import type { ReactNode } from "react";

export const threadCardHeight = (hasDetails: boolean) => (hasDetails ? 78 : 60);

export function ThreadCardContent({
  hasDetails = false,
  children,
}: {
  hasDetails?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`relative z-10 px-(--sidebar-row-content-inset) py-(--sidebar-content-inset) ${hasDetails ? "h-[4.875rem]" : "h-15"}`}
    >
      {children}
    </div>
  );
}
