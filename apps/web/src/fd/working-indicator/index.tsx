import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import { cn } from "~/lib/utils";

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Slow, quiet ring for a working thread: a faint track with a short rounded
 * arc orbiting it. Pauses offscreen, in hidden tabs, and under reduced motion.
 */
export function WorkingSpinner({ className }: { className?: string }) {
  return (
    <svg
      ref={observeVisibleAnimation}
      aria-hidden
      viewBox="0 0 16 16"
      fill="none"
      className={cn("motion-safe:visible-animate-spin", className)}
      style={{ animationDuration: "1.8s" }}
    >
      <circle cx="8" cy="8" r={RADIUS} stroke="currentColor" strokeOpacity={0.18} strokeWidth={2} />
      <circle
        cx="8"
        cy="8"
        r={RADIUS}
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray={`${CIRCUMFERENCE * 0.3} ${CIRCUMFERENCE}`}
      />
    </svg>
  );
}
