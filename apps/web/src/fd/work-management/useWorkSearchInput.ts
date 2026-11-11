import { useEffect, useEffectEvent, useState } from "react";

import type { WorkSearch } from "./WorkRouteView";

/** A route change replaces the draft; an acknowledgement of our own search keeps newer typing. */
export function useWorkSearchInput(
  search: WorkSearch,
  commit: (query: string | undefined) => void,
) {
  const commitLatest = useEffectEvent(commit);
  const value = search.q ?? "";
  const scope = JSON.stringify({ ...search, q: undefined });
  const [draft, setDraft] = useState({
    scope,
    value,
    text: value,
    submitted: null as string | null,
  });
  if (draft.scope !== scope || draft.value !== value) {
    const acknowledged = draft.scope === scope && draft.submitted === value;
    setDraft({ scope, value, text: acknowledged ? draft.text : value, submitted: null });
  }

  useEffect(() => {
    const next = draft.text.trim();
    if (
      draft.scope !== scope ||
      draft.value !== value ||
      next === value ||
      draft.submitted === next
    )
      return;
    const timer = window.setTimeout(() => {
      setDraft((current) => ({ ...current, submitted: next }));
      commitLatest(next || undefined);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [draft, scope, value]);

  return [
    draft.text,
    (text: string) => setDraft((current) => ({ ...current, scope, value, text })),
  ] as const;
}
