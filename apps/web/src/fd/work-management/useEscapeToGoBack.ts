import { useCanGoBack, useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent } from "react";

import { registerCommands } from "../../shortcuts/dispatcher";

/**
 * Page-level Escape: runs `onEscape`, or returns to the previous app page (home without
 * app history). Observes after every other shortcut scope, so controls consume Escape first.
 */
export function useEscapeToGoBack(onEscape?: () => void) {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const handleEscape = useEffectEvent(() => {
    if (onEscape) return onEscape();
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds a page-level Escape observer in the shortcut dispatcher until unmount
  useEffect(
    () =>
      registerCommands(
        {},
        {
          observe: (event, consumed) => {
            if (consumed || event.repeat || event.isComposing || event.key !== "Escape") return;
            event.preventDefault();
            const activeElement = document.activeElement;
            if (activeElement instanceof HTMLElement) activeElement.blur();
            handleEscape();
          },
        },
      ),
    [],
  );
}
