import {
  beginWorkRelationshipDraft,
  type WorkRelationshipDraft,
  type WorkRelationshipField,
  workRelationshipPatch,
  workRelationshipText,
  type WorkWriteOutcome,
} from "@t3tools/client-runtime/fd/work-management";
import type { EnvironmentId } from "@t3tools/contracts";
import type {
  WorkItemDetail,
  WorkItemField,
  WorkItemPatch,
  WorkPriority,
} from "@t3tools/contracts/fd/work-management";
import { useEffect, useState } from "react";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../../components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../../components/ui/popover";
import { useEnvironmentQuery } from "../../state/query";
import { workEnvironment } from "./state";

const PRIORITIES: ReadonlyArray<{ readonly value: WorkPriority | "none"; readonly label: string }> =
  [
    { value: "high", label: "High" },
    { value: "medium", label: "Medium" },
    { value: "low", label: "Low" },
    { value: "none", label: "No priority" },
  ];

type FieldPatch = Omit<WorkItemPatch, "ref">;

/** Priority and assignee controls, each shown only where the source can write that field. */
export function WorkItemFieldControls({
  environmentId,
  item,
  can,
  update,
}: {
  environmentId: EnvironmentId;
  item: WorkItemDetail;
  can: (field: WorkItemField) => boolean;
  update: (patch: FieldPatch) => Promise<WorkWriteOutcome<unknown>>;
}) {
  return (
    <>
      {can("priority") ? (
        <Menu>
          <MenuTrigger render={<Button size="sm" variant="outline" />}>
            {item.priority === null ? "No priority" : `${item.priority} priority`}
          </MenuTrigger>
          <MenuPopup align="start">
            <MenuRadioGroup
              value={item.priority ?? "none"}
              onValueChange={(value) => {
                const next = PRIORITIES.find((entry) => entry.value === value)?.value;
                if (next === undefined || next === (item.priority ?? "none")) return;
                void update({ priority: next === "none" ? null : next });
              }}
            >
              {PRIORITIES.map((entry) => (
                <MenuRadioItem key={entry.value} value={entry.value}>
                  {entry.label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuPopup>
        </Menu>
      ) : null}
      {can("assignee") ? (
        <AssigneePicker environmentId={environmentId} item={item} update={update} />
      ) : null}
    </>
  );
}

function AssigneePicker({
  environmentId,
  item,
  update,
}: {
  environmentId: EnvironmentId;
  item: WorkItemDetail;
  update: (patch: FieldPatch) => Promise<WorkWriteOutcome<unknown>>;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  // People are only asked for while the picker is open, once per settled search.
  const people = useEnvironmentQuery(
    open && item.capabilities.people
      ? workEnvironment.people({
          environmentId,
          input: { sourceId: item.ref.sourceId, query: debounced, itemId: item.ref.itemId },
        })
      : null,
  );
  const choose = (assignee: string | null) => {
    setOpen(false);
    setSearch("");
    void update({ assignee });
  };
  const freeText = search.trim();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button size="sm" variant="outline" />}>
        {item.assignee?.label ?? "Unassigned"}
      </PopoverTrigger>
      <PopoverPopup width="sm" align="start" padding="compact">
        <div className="space-y-2">
          <Input
            aria-label="Find a person"
            placeholder={item.capabilities.people ? "Find a person" : "Assignee"}
            value={search}
            size="sm"
            autoFocus
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !item.capabilities.people && freeText.length > 0) {
                choose(freeText);
              }
            }}
          />
          <div className="max-h-56 overflow-y-auto">
            {item.capabilities.people ? (
              (people.data?.people ?? []).map((person) => (
                <PersonRow
                  key={person.id}
                  label={person.label}
                  onSelect={() => choose(person.id)}
                />
              ))
            ) : freeText.length > 0 ? (
              <PersonRow label={`Assign to ${freeText}`} onSelect={() => choose(freeText)} />
            ) : null}
            {item.capabilities.people && people.error ? (
              <p className="px-2 text-destructive text-xs">{people.error}</p>
            ) : null}
          </div>
          {item.assignee !== null ? (
            <Button size="sm" variant="outline" onClick={() => choose(null)}>
              Unassign
            </Button>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function PersonRow({ label, onSelect }: { label: string; onSelect: () => void }) {
  return (
    <button
      type="button"
      className="w-full truncate rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
      onClick={onSelect}
    >
      {label}
    </button>
  );
}

/**
 * Parent and blocked-by editors. The draft keeps the revision it was opened at, so a save from
 * an older view fails as stale instead of replacing a blocker set someone changed meanwhile.
 * On stale the text is kept; once the newer item shows, the owner reapplies it or discards it.
 */
export function WorkRelationshipEditor({
  item,
  field,
  update,
}: {
  item: WorkItemDetail;
  field: WorkRelationshipField;
  update: (patch: FieldPatch) => Promise<WorkWriteOutcome<unknown>>;
}) {
  const [draft, setDraft] = useState<WorkRelationshipDraft | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const label = field === "parent" ? "Parent" : "Blocked by";
  const current = workRelationshipText(item, field);
  const save = async () => {
    if (draft === null || conflict) return;
    const planned = workRelationshipPatch(draft);
    if ("invalid" in planned) return setInvalid(planned.invalid);
    setInvalid(null);
    const outcome = await update(planned.patch);
    if (outcome._tag === "success") setDraft(null);
    if (outcome._tag === "stale") setConflict(true);
  };
  const close = () => {
    setDraft(null);
    setConflict(false);
    setInvalid(null);
  };
  if (draft === null) {
    return (
      <div className="flex items-center gap-2">
        <span>
          {label}:{" "}
          {current.length === 0 ? <span className="text-muted-foreground">none</span> : current}
        </span>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => setDraft(beginWorkRelationshipDraft(item, field))}
        >
          Edit
        </Button>
      </div>
    );
  }
  const newer = item.revision !== draft.baseRevision;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Input
          aria-label={label}
          placeholder={field === "parent" ? "Item id" : "Item ids, comma-separated"}
          value={draft.value}
          size="sm"
          autoFocus
          onChange={(event) => setDraft({ ...draft, value: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Enter") void save();
            if (event.key === "Escape") close();
          }}
        />
        <Button size="xs" disabled={conflict} onClick={() => void save()}>
          Save
        </Button>
        <Button size="xs" variant="ghost" onClick={close}>
          Cancel
        </Button>
      </div>
      {invalid ? <p className="text-destructive text-xs">{invalid}</p> : null}
      {conflict ? (
        <div className="space-y-1 text-xs" role="alert">
          <p>
            {item.key} changed while you were editing.{" "}
            {newer ? `Now: ${current.length === 0 ? "none" : current}` : "Loading it..."}
          </p>
          <div className="flex gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={!newer}
              onClick={() => {
                setDraft({ ...draft, baseRevision: item.revision });
                setConflict(false);
              }}
            >
              Reapply my edit
            </Button>
            <Button size="xs" variant="ghost" onClick={close}>
              Discard my edit
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
