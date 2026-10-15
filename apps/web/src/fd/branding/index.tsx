import { FOREDECK_ANCHOR_CONTENT, FOREDECK_WORDMARK } from "@t3tools/shared/fd/branding";
import type { SVGProps } from "react";

export function ForedeckAnchor(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      {...props}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      dangerouslySetInnerHTML={{ __html: FOREDECK_ANCHOR_CONTENT }}
    />
  );
}

export function ForedeckWordmark() {
  return (
    <span className="text-fd-wordmark font-bold tracking-fd-wordmark">
      {FOREDECK_WORDMARK.slice(0, -1)}
      <span className="text-(--fd-brand-period)">.</span>
    </span>
  );
}
