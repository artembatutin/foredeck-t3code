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
  WorkItemPatch,
  WorkPriority,
} from "@t3tools/contracts/fd/work-management";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { useEnvironmentQuery } from "../../state/query";
import { Action, Chip } from "./shared";
import { workEnvironment } from "./state";

type FieldPatch = Omit<WorkItemPatch, "ref">;
type Update = (patch: FieldPatch) => Promise<WorkWriteOutcome<unknown>>;

const INPUT_CLASS = "rounded-xl bg-card px-3 py-2 text-base text-foreground";

const PRIORITIES: ReadonlyArray<{ readonly value: WorkPriority | "none"; readonly label: string }> =
  [
    { value: "high", label: "High" },
    { value: "medium", label: "Medium" },
    { value: "low", label: "Low" },
    { value: "none", label: "No priority" },
  ];

/** The item's priority as a menu, for sources that can write it. */
export function PriorityControl({ item, update }: { item: WorkItemDetail; update: Update }) {
  const current = item.priority ?? "none";
  return (
    <ControlPillMenu
      accessibilityLabel="Change priority"
      actions={PRIORITIES.map((entry) => ({
        id: entry.value,
        title: entry.label,
        state: entry.value === current ? ("on" as const) : ("off" as const),
      }))}
      onPressAction={({ nativeEvent }) => {
        const next = PRIORITIES.find((entry) => entry.value === nativeEvent.event)?.value;
        if (next === undefined || next === current) return;
        void update({ priority: next === "none" ? null : next });
      }}
    >
      <Chip label={item.priority === null ? "No priority" : `${item.priority} priority`} />
    </ControlPillMenu>
  );
}

/**
 * Picks the assignee. Sources that know their people are searched as the owner types (only
 * while the picker is open, once per settled search); Markdown takes free text.
 */
export function AssigneeEditor({
  environmentId,
  item,
  update,
  onClose,
}: {
  environmentId: EnvironmentId;
  item: WorkItemDetail;
  update: Update;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setTerm(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const people = useEnvironmentQuery(
    item.capabilities.people
      ? workEnvironment.people({
          environmentId,
          input: { sourceId: item.ref.sourceId, query: term, itemId: item.ref.itemId },
        })
      : null,
  );
  const choose = async (assignee: string | null) => {
    const outcome = await update({ assignee });
    if (outcome._tag === "success") onClose();
  };
  const freeText = search.trim();
  return (
    <View className="gap-2 rounded-xl bg-subtle p-3">
      <AppTextInput
        accessibilityLabel="Find a person"
        className={INPUT_CLASS}
        placeholder={item.capabilities.people ? "Find a person" : "Assignee"}
        value={search}
        autoFocus
        onChangeText={setSearch}
      />
      {item.capabilities.people ? (
        (people.data?.people ?? []).map((person) => (
          <Pressable
            key={person.id}
            accessibilityRole="button"
            className="py-2 active:opacity-70"
            onPress={() => void choose(person.id)}
          >
            <Text className="text-base text-foreground" numberOfLines={1}>
              {person.label}
            </Text>
          </Pressable>
        ))
      ) : freeText.length > 0 ? (
        <Action label={`Assign to ${freeText}`} onPress={() => void choose(freeText)} />
      ) : null}
      {item.capabilities.people && people.error ? (
        <Text className="text-xs text-destructive">{people.error}</Text>
      ) : null}
      <View className="flex-row gap-2">
        {item.assignee !== null ? (
          <Action label="Unassign" onPress={() => void choose(null)} />
        ) : null}
        <Action label="Close" onPress={onClose} />
      </View>
    </View>
  );
}

/**
 * Parent and blocked-by editors. The draft keeps the revision it was opened at, so a save from
 * an older view fails as stale instead of replacing a blocker set someone changed meanwhile.
 */
export function RelationshipEditor({
  item,
  field,
  update,
}: {
  item: WorkItemDetail;
  field: WorkRelationshipField;
  update: Update;
}) {
  const [draft, setDraft] = useState<WorkRelationshipDraft | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const label = field === "parent" ? "Parent" : "Blocked by";
  const current = workRelationshipText(item, field);
  const close = () => {
    setDraft(null);
    setConflict(false);
    setInvalid(null);
  };
  const save = async () => {
    if (draft === null || conflict) return;
    const planned = workRelationshipPatch(draft);
    if ("invalid" in planned) return setInvalid(planned.invalid);
    setInvalid(null);
    const outcome = await update(planned.patch);
    if (outcome._tag === "success") close();
    if (outcome._tag === "stale") setConflict(true);
  };
  if (draft === null) {
    return (
      <View className="flex-row items-center gap-2">
        <Text className="flex-1 text-sm text-foreground">
          {label}: {current.length === 0 ? "none" : current}
        </Text>
        <Action label="Edit" onPress={() => setDraft(beginWorkRelationshipDraft(item, field))} />
      </View>
    );
  }
  const newer = item.revision !== draft.baseRevision;
  return (
    <View className="gap-2">
      <AppTextInput
        accessibilityLabel={label}
        className={INPUT_CLASS}
        placeholder={field === "parent" ? "Item id" : "Item ids, comma-separated"}
        value={draft.value}
        autoFocus
        onChangeText={(value) => setDraft({ ...draft, value })}
      />
      {invalid ? <Text className="text-xs text-destructive">{invalid}</Text> : null}
      {conflict ? (
        <View className="gap-1 rounded-xl bg-card p-3">
          <Text className="text-sm text-foreground">
            {item.key} changed while you were editing.{" "}
            {newer ? `Now: ${current.length === 0 ? "none" : current}` : "Loading it…"}
          </Text>
          <View className="flex-row gap-2">
            <Action
              label="Reapply my edit"
              disabled={!newer}
              onPress={() => {
                setDraft({ ...draft, baseRevision: item.revision });
                setConflict(false);
              }}
            />
            <Action label="Discard my edit" onPress={close} />
          </View>
        </View>
      ) : null}
      <View className="flex-row gap-2">
        <Action label="Save" disabled={conflict} onPress={() => void save()} />
        <Action label="Cancel" onPress={close} />
      </View>
    </View>
  );
}
