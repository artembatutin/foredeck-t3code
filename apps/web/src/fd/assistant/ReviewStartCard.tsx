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

import { TriangleAlertIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
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
  REVIEW_KIND_NOTES,
  REVIEW_PROVIDER_NOTE,
  reviewDestinationFacts,
  reviewEditable,
  reviewEdited,
  type ReviewEditing,
  reviewEditingAfter,
  reviewEditingOf,
  reviewEditOvertaken,
  type ReviewFact,
  reviewFailureText,
  reviewFreezeNote,
  reviewLimitFacts,
  reviewOverrideFact,
  reviewRoleFact,
  reviewSaveInput,
  reviewScopeFieldLabel,
  reviewStartAvailability,
} from "./reviewCard";

export interface ReviewTarget {
  readonly projectId: ProjectId;
  readonly ideaId: string;
}

/** One of the review's three parts: what is delivered, where, and with what. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="border-b pb-1 font-medium text-sm">{title}</h3>
      {children}
    </section>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1">
      <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
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
      {entries.length === 0 ? <p className="text-muted-foreground text-xs">None yet.</p> : null}
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
        {`Add ${label.toLowerCase()}`}
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

/** Settings as label and value, so one can be found without reading the rest. */
function Facts({ facts }: { facts: ReadonlyArray<ReviewFact> }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
      {facts.map((fact) => (
        <div key={fact.key} className="contents">
          <dt className="text-muted-foreground">{fact.label}</dt>
          <dd className="min-w-0 break-words">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** One choice among a few, with the current one marked as pressed. */
function Choice<Value extends string>({
  label,
  options,
  value,
  disabled,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<{ readonly value: Value; readonly label: string }>;
  value: Value | undefined;
  disabled: boolean;
  onChange: (value: Value) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1">
      <span className="pe-1 text-muted-foreground text-xs">{label}</span>
      {options.map((option) => (
        <Button
          key={option.value}
          type="button"
          size="xs"
          variant={option.value === value ? "secondary" : "outline"}
          aria-pressed={option.value === value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </div>
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
  // The owner asked to close with edits unsaved, which is said until they are saved or discarded.
  const [closeRefused, setCloseRefused] = useState(false);
  const reviewRead = useRef(0);
  const selectionKey = JSON.stringify([
    environmentId,
    managerThreadId,
    target.projectId,
    target.ideaId,
    kind,
    sourceId,
  ]);
  const [reviewedSelectionKey, setReviewedSelectionKey] = useState<string | null>(null);
  const reviewing = reviewedSelectionKey !== selectionKey;
  // One per version: repeating a confirmation after a lost reply converges on what it started.
  const request = useRef<{ readonly version: string; readonly id: string } | null>(null);

  const refresh = useCallback(
    async (saved = false) => {
      const sequence = ++reviewRead.current;
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
      // Selection changes and closing the card invalidate every older response, including errors.
      if (sequence !== reviewRead.current) return;
      if (result._tag === "Failure") {
        setError(reviewFailureText(result.cause));
        return;
      }
      setReviewedSelectionKey(selectionKey);
      setSnapshot(result.value);
      setEditing((current) =>
        saved || current === null
          ? reviewEditingOf(result.value)
          : reviewEditingAfter(current, result.value),
      );
    },
    [
      environmentId,
      kind,
      managerThreadId,
      read,
      selectionKey,
      sourceId,
      target.ideaId,
      target.projectId,
    ],
  );

  // Choosing how to deliver it keeps what the owner has typed.
  useEffect(() => {
    void refresh();
    return () => {
      reviewRead.current += 1;
    };
  }, [refresh]);

  if (snapshot === null || editing === null) {
    return (
      <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Review and start</DialogTitle>
            <DialogDescription role={error === null ? "status" : "alert"}>
              {error ?? "Reading what a start would capture and run…"}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={onClose}>
              Close
            </Button>
            {error === null ? null : (
              <Button
                size="sm"
                onClick={() => {
                  setError(null);
                  void refresh();
                }}
              >
                Try again
              </Button>
            )}
          </DialogFooter>
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
    else setCloseRefused(false);
    await refresh(result._tag === "Success");
    setPending(false);
  };

  const confirm = async () => {
    if (pending || reviewing || !availability.canStart) return;
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
    if (result._tag === "Success") {
      setPending(false);
      onStarted();
      onClose();
      return;
    }
    setError(reviewFailureText(result.cause));
    await refresh();
    setPending(false);
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

  const overtaken = reviewEditOvertaken(editing, snapshot);
  // Closing would drop what the owner typed, so it waits for them to save or discard it.
  const close = () => {
    if (pending) return;
    if (edited) setCloseRefused(true);
    else onClose();
  };
  const discard = () => {
    setCloseRefused(false);
    setEditing(reviewEditingOf(snapshot));
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : close())}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{availability.label}</DialogTitle>
          <DialogDescription>{reviewFreezeNote(snapshot.start.mode)}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {availability.blockers.length > 0 ? (
            <Alert variant="warning" controlAlignment="first-line">
              <TriangleAlertIcon />
              <AlertTitle>
                {snapshot.start.mode === "amend" ? "It cannot resume yet" : "It cannot start yet"}
              </AlertTitle>
              <AlertDescription>
                <ul className="list-disc space-y-1 ps-4">
                  {availability.blockers.map((reason) => (
                    <li key={reason} className="break-words">
                      {reason}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}
          <Group title="What is delivered">
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
            {snapshot.briefTruncated ? (
              <p className="text-muted-foreground text-xs">
                This text is too long to show whole, so it is edited with the assistant.
              </p>
            ) : null}
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
            {snapshot.scopeChanges !== null && snapshot.scopeChanges.length > 0 ? (
              <Section title="Changed since the last capture">
                {snapshot.scopeChanges.map(({ field: changed, previous, next }) => (
                  <div key={changed} className="space-y-0.5 text-xs">
                    <p className="font-medium">{reviewScopeFieldLabel(changed)}</p>
                    {previous.map((line) => (
                      <p key={`-${line}`} className="break-words text-muted-foreground">
                        <span className="pe-1">Was:</span>
                        <del>{line}</del>
                      </p>
                    ))}
                    {next.map((line) => (
                      <p key={`+${line}`} className="break-words">
                        <span className="pe-1 text-muted-foreground">Now:</span>
                        {line}
                      </p>
                    ))}
                  </div>
                ))}
              </Section>
            ) : null}
          </Group>
          <Group title="Where it goes">
            <Facts facts={reviewDestinationFacts(where)} />
            <Choice
              label="Deliver as"
              options={[
                { value: "single", label: "Single item" },
                { value: "parent", label: "Plan into tasks" },
              ]}
              value={where.kindFixed ? where.kind : kind}
              disabled={pending || where.kindFixed}
              onChange={(option) => {
                if (option === kind) return;
                setReviewedSelectionKey(null);
                setKind(option);
              }}
            />
            <p className="text-muted-foreground text-xs">
              {REVIEW_KIND_NOTES[where.kindFixed ? where.kind : kind]}
              {where.kindFixed ? " An attempt under way keeps how it was started." : ""}
            </p>
            {where.sources.length > 1 ? (
              <Choice
                label="Work source"
                options={where.sources.map((source) => ({
                  value: source.sourceId,
                  label: source.label,
                }))}
                value={sourceId ?? where.source?.sourceId}
                disabled={pending}
                onChange={(option) => {
                  if (option === sourceId) return;
                  setReviewedSelectionKey(null);
                  setSourceId(option);
                }}
              />
            ) : null}
            {reviewing ? (
              <p className="text-muted-foreground text-xs" role="status">
                Updating the review for your selection…
              </p>
            ) : null}
          </Group>
          <Group title="What it runs with">
            <Section title="Roles">
              <Facts
                facts={[
                  reviewRoleFact("Author", snapshot.roles.author),
                  reviewRoleFact("Reviewer", snapshot.roles.reviewer),
                  ...(where.kind === "parent"
                    ? [reviewRoleFact("Planner", snapshot.roles.planner)]
                    : []),
                  {
                    key: "runtime",
                    label: "Runtime mode",
                    value: snapshot.runtime.ceiling ?? "Could not be resolved",
                  },
                  reviewOverrideFact(snapshot.overrides),
                ]}
              />
              <p className="text-muted-foreground text-xs">{REVIEW_PROVIDER_NOTE}</p>
            </Section>
            <Section title="Allowances and checks">
              <Facts facts={reviewLimitFacts(snapshot)} />
            </Section>
          </Group>
          {overtaken ? (
            <p className="text-destructive text-xs" role="alert">
              This idea changed after you began editing, so your edits cannot be saved over it.
              Discard them to see what it says now.
            </p>
          ) : null}
          {error ? (
            <p className="text-destructive text-xs" role="alert">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          {edited ? (
            <p
              className="text-muted-foreground text-xs sm:me-auto sm:self-center"
              role={closeRefused ? "alert" : undefined}
            >
              {closeRefused
                ? "Save or discard your edits before closing."
                : "Unsaved edits. A start uses what is saved."}
            </p>
          ) : null}
          {edited ? (
            <>
              <Button size="sm" variant="outline" disabled={pending} onClick={discard}>
                Discard edits
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending || reviewing || !canEdit}
                onClick={() => void save()}
              >
                Save edits
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" disabled={pending} onClick={onClose}>
              Close
            </Button>
          )}
          <Button
            size="sm"
            disabled={pending || reviewing || !availability.canStart}
            onClick={() => void confirm()}
          >
            {availability.action}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
