import { parseWorkLabelFilter } from "@t3tools/client-runtime/fd/work-management";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { InputGroup, InputGroupInput } from "../../components/ui/input-group";

/** Accepts labels not present on the currently loaded page. */
export function WorkLabelFilter({
  labels,
  onApply,
}: {
  labels: ReadonlyArray<string>;
  onApply: (labels: ReadonlyArray<string>) => void;
}) {
  const [text, setText] = useState(labels.join(", "));
  return (
    <form
      className="flex min-w-40 items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onApply(parseWorkLabelFilter(text));
      }}
    >
      <InputGroup>
        <InputGroupInput
          aria-label="Filter by labels"
          placeholder="Labels, comma-separated"
          size="sm"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </InputGroup>
      <Button type="submit" size="sm" variant="outline">
        Apply labels
      </Button>
    </form>
  );
}
