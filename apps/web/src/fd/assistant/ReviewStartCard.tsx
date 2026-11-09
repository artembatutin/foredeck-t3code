import type {
  AssistantReviewKind,
  AssistantReviewSnapshot,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import type { WorkSourceId } from "@t3tools/contracts/fd/work-management";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { randomUUID } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";
import { readReview, reviseReview, startReview } from "./commands";
import {
  reviewEditable,
  reviewEdited,
  type ReviewEditing,
  reviewEditingAfter,
  reviewEditingOf,
  reviewEditOvertaken,
  reviewFailureText,
  reviewFreezeNote,
  reviewLimitLines,
  reviewOverrideLine,
  reviewRoleLine,
  reviewSaveInput,
  reviewStartAvailability,
} from "./reviewCard";

export interface ReviewTarget {
  readonly projectId: ProjectId;
  readonly ideaId: string;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/** One box per entry, since an entry can hold several lines of its own. */
function Entries({
  label,
  entries,
  disabled,
  onChange,
}: {
  label: string;
  entries: ReadonlyArray<string>;
  disabled: boolean;
  onChange: (entries: ReadonlyArray<string>) => void;
}) {
  return (
    <div className="space-y-1">
      {entries.map((entry, index) => (
        <Textarea
          // The list only grows at its end, and an emptied box stays until it is saved away.
          key={index}
          aria-label={`${label} ${index + 1}`}
          value={entry}
          disabled={disabled}
          onChange={(event) =>
            onChange(entries.map((other, at) => (at === index ? event.target.value : other)))
          }
        />
      ))}
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={disabled}
        onClick={() => onChange([...entries, ""])}
      >
        Add
      </Button>
    </div>
  );
}

function Lines({ items }: { items: ReadonlyArray<string> }) {
  return (
    <>
      {items.map((line) => (
        <p key={line} className="break-words text-xs">
          {line}
        </p>
      ))}
    </>
  );
}

/**
 * What an idea would capture and run, for its owner to edit and start. Everything here is read when
 * it opens and again after each save; only the server's own comparison decides what a start does.
 */
export function ReviewStartCard({
  environmentId,
  managerThreadId,
  target,
  onClose,
  onStarted,
}: {
  environmentId: EnvironmentId;
  managerThreadId: ThreadId;
  target: ReviewTarget;
  onClose: () => void;
  onStarted: () => void;
}) {
  const read = useAtomCommand(readReview, { reportFailure: false });
  const revise = useAtomCommand(reviseReview, { reportFailure: false });
  const start = useAtomCommand(startReview, { reportFailure: false });
  const permitted = useAtomValue(startReview.permissionAtom(environmentId));
  const mayEdit = useAtomValue(reviseReview.permissionAtom(environmentId));
  const [kind, setKind] = useState<AssistantReviewKind>("single");
  const [sourceId, setSourceId] = useState<WorkSourceId | undefined>(undefined);
  const [snapshot, setSnapshot] = useState<AssistantReviewSnapshot | null>(null);
  const [editing, setEditing] = useState<ReviewEditing | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One per version: repeating a confirmation after a lost reply converges on what it started.
  const request = useRef<{ readonly version: string; readonly id: string } | null>(null);

  const refresh = useCallback(
    async (saved = false) => {
      const result = await read({
        environmentId,
        input: {
          projectId: target.projectId,
          ideaId: target.ideaId,
          managerThreadId,
          kind,
          ...(sourceId === undefined ? {} : { sourceId }),
        },
      });
      if (result._tag === "Failure") {
        setError(reviewFailureText(result.cause));
        return;
      }
      setSnapshot(result.value);
      setEditing((current) =>
        saved || current === null
          ? reviewEditingOf(result.value)
          : reviewEditingAfter(current, result.value),
      );
    },
    [environmentId, kind, managerThreadId, read, sourceId, target.ideaId, target.projectId],
  );

  // Choosing how to deliver it keeps what the owner has typed.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (snapshot === null || editing === null) {
    return (
      <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Review and start</DialogTitle>
            <DialogDescription>
              {error ?? "Reading what a start would capture and run."}
            </DialogDescription>
          </DialogHeader>
        </DialogPopup>
      </Dialog>
    );
  }

  const canEdit = reviewEditable({ permitted: mayEdit, briefTruncated: snapshot.briefTruncated });
  const { draft } = editing;
  const edited = reviewEdited(editing);
  const availability = reviewStartAvailability(snapshot, { permitted, edited });
  const { target: where } = snapshot;

  const save = async () => {
    setPending(true);
    setError(null);
    const result = await revise({ environmentId, input: reviewSaveInput(editing) });
    if (result._tag === "Failure") setError(reviewFailureText(result.cause));
    await refresh(result._tag === "Success");
    setPending(false);
  };

  const confirm = async () => {
    setPending(true);
    setError(null);
    const requestId =
      request.current?.version === snapshot.reviewVersion ? request.current.id : randomUUID();
    request.current = { version: snapshot.reviewVersion, id: requestId };
    const result = await start({
      environmentId,
      input: {
        projectId: snapshot.projectId,
        ideaId: snapshot.ideaId,
        managerThreadId,
        // As the snapshot being confirmed says, whatever was last asked for.
        kind: where.kind,
        ...(where.source === null ? {} : { sourceId: where.source.sourceId }),
        reviewVersion: snapshot.reviewVersion,
        requestId,
      },
    });
    setPending(false);
    if (result._tag === "Success") {
      onStarted();
      onClose();
      return;
    }
    setError(reviewFailureText(result.cause));
    await refresh();
  };

  const text = (name: "title" | "goal") => ({
    value: draft[name],
    disabled: pending || !canEdit,
    onChange: (event: { readonly target: { readonly value: string } }) =>
      setEditing({ ...editing, draft: { ...draft, [name]: event.target.value } }),
  });
  const list = (name: "acceptanceCriteria" | "constraints" | "decisions") => ({
    entries: draft[name],
    disabled: pending || !canEdit,
    onChange: (entries: ReadonlyArray<string>) =>
      setEditing({ ...editing, draft: { ...draft, [name]: entries } }),
  });

  return (
    <Dialog open onOpenChange={(open) => (open || pending ? undefined : onClose())}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{availability.label}</DialogTitle>
          <DialogDescription>{reviewFreezeNote(snapshot.start.mode)}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-3">
            <Section title="Title">
              <Input
                aria-label="Short title"
                placeholder={snapshot.title.text}
                maxLength={80}
                {...text("title")}
              />
            </Section>
            <Section title="Goal">
              <Textarea aria-label="Goal" {...text("goal")} />
            </Section>
            <Section title="Acceptance criteria">
              <Entries label="Acceptance criterion" {...list("acceptanceCriteria")} />
            </Section>
            <Section title="Restrictions">
              <Entries label="Restriction" {...list("constraints")} />
            </Section>
            <Section title="Decisions">
              <Entries label="Decision" {...list("decisions")} />
            </Section>
            {snapshot.openQuestions.length > 0 ? (
              <Section title="Open questions">
                <Lines items={snapshot.openQuestions} />
              </Section>
            ) : null}
            {snapshot.conversationNotes.items.length > 0 ? (
              <Section title="Conversation notes, not delivered">
                <Lines items={snapshot.conversationNotes.items} />
              </Section>
            ) : null}
            <Section title="Changed since the last capture">
              {snapshot.scopeChanges === null ? (
                <p className="text-xs">Not captured yet.</p>
              ) : snapshot.scopeChanges.length === 0 ? (
                <p className="text-xs">Nothing.</p>
              ) : (
                snapshot.scopeChanges.map(({ field: changed, previous, next }) => (
                  <div key={changed} className="text-xs">
                    <p className="font-medium">{changed}</p>
                    <Lines items={previous.map((line) => `- ${line}`)} />
                    <Lines items={next.map((line) => `+ ${line}`)} />
                  </div>
                ))
              )}
            </Section>
            <Section title="Where it goes">
              <Lines
                items={[
                  where.repository === null
                    ? "Repository: could not be resolved"
                    : `Repository: ${where.repository.repository ?? where.repository.workspaceRoot} (${where.repository.provider})`,
                  ...(where.source === null
                    ? []
                    : [`Work source: ${where.source.label} (${where.source.identity})`]),
                  ...(where.sourcesOmitted > 0
                    ? [`${where.sourcesOmitted} more Work sources are not listed here.`]
                    : []),
                  where.item === null
                    ? "Work item: created when you start"
                    : `Work item: ${where.item.key ?? where.item.itemId}`,
                ]}
              />
              <div className="flex flex-wrap gap-1 pt-1">
                {(["single", "parent"] as const).map((option) => (
                  <Button
                    key={option}
                    size="xs"
                    variant={where.kind === option ? "secondary" : "outline"}
                    disabled={pending || where.kindFixed}
                    onClick={() => setKind(option)}
                  >
                    {option === "single" ? "Single item" : "Plan into tasks"}
                  </Button>
                ))}
                {where.sources.length > 1
                  ? where.sources.map((source) => (
                      <Button
                        key={source.sourceId}
                        size="xs"
                        variant={
                          where.source?.sourceId === source.sourceId ? "secondary" : "outline"
                        }
                        disabled={pending}
                        onClick={() => setSourceId(source.sourceId)}
                      >
                        {source.label}
                      </Button>
                    ))
                  : null}
              </div>
            </Section>
            <Section title="What it runs with">
              <Lines
                items={[
                  reviewRoleLine("Author", snapshot.roles.author),
                  reviewRoleLine("Reviewer", snapshot.roles.reviewer),
                  ...(where.kind === "parent"
                    ? [reviewRoleLine("Planner", snapshot.roles.planner)]
                    : []),
                  `Runtime: ${snapshot.runtime.ceiling ?? "could not be resolved"}`,
                  ...reviewLimitLines(snapshot),
                  reviewOverrideLine(snapshot.overrides),
                ]}
              />
            </Section>
            {availability.reasons.length > 0 ? (
              <Section title="Why it cannot start yet">
                <Lines items={availability.reasons} />
              </Section>
            ) : null}
            {reviewEditOvertaken(editing, snapshot) ? (
              <p className="text-destructive text-xs">
                This idea changed after you began editing, so your edits cannot be saved over it.
                Discard them to see what it says now.
              </p>
            ) : null}
            {error ? <p className="text-destructive text-xs">{error}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button size="sm" variant="outline" disabled={pending} onClick={onClose}>
            Close
          </Button>
          {edited ? (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => setEditing(reviewEditingOf(snapshot))}
              >
                Discard edits
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending || !canEdit}
                onClick={() => void save()}
              >
                Save edits
              </Button>
            </>
          ) : null}
          <Button
            size="sm"
            disabled={pending || !availability.canStart}
            onClick={() => void confirm()}
          >
            {availability.label}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
