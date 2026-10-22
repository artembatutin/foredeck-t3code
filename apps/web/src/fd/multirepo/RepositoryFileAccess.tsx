import type { RepositoryTarget } from "@t3tools/contracts";
import { createContext, useContext, type ReactNode } from "react";

const RepositoryFileAccess = createContext<RepositoryTarget | undefined>(undefined);

export function RepositoryFileAccessProvider({
  target,
  children,
}: {
  target: RepositoryTarget | undefined;
  children: ReactNode;
}) {
  return <RepositoryFileAccess value={target}>{children}</RepositoryFileAccess>;
}

export const useRepositoryFileAccess = () => useContext(RepositoryFileAccess);
