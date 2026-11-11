import {
  normalizeWorkLabels,
  parseWorkLabelFilter,
} from "@t3tools/client-runtime/fd/work-management";
import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { InputGroup, InputGroupInput } from "../../components/ui/input-group";

/**
 * The label filter: each applied label is a chip that removes itself, and the box only adds. What
 * is typed is therefore never mistaken for what is applied. It accepts labels the loaded page does
 * not carry, since the filter is the server's.
 */
export function WorkLabelFilter({
  labels,
  onApply,
}: {
  labels: ReadonlyArray<string>;
  onApply: (labels: ReadonlyArray<string>) => void;
}) {
  const [text, setText] = useState("");
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const added = parseWorkLabelFilter(text);
        if (added.length === 0) return;
        setText("");
        onApply(normalizeWorkLabels([...labels, ...added]));
      }}
    >
      {labels.length > 0 ? (
        <ul className="flex flex-wrap items-center gap-1" aria-label="Label filters">
          {labels.map((label) => (
            <li key={label}>
              <Badge
                variant="secondary"
                size="control"
                render={
                  <button
                    type="button"
                    aria-label={`Remove label filter ${label}`}
                    onClick={() => onApply(labels.filter((other) => other !== label))}
                  />
                }
              >
                {label}
                <XIcon aria-hidden />
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="w-40">
        <InputGroup>
          <InputGroupInput
            aria-label="Filter by labels"
            placeholder={labels.length > 0 ? "Add another label" : "Filter by label"}
            size="sm"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </InputGroup>
      </div>
      <Button type="submit" size="sm" variant="outline" disabled={text.trim() === ""}>
        <PlusIcon />
        Add label
      </Button>
    </form>
  );
}
