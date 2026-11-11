import { useAtomValue } from "@effect/atom-react";
import { FACTORY_CANCEL_TEXT, factoryExecutionView } from "@t3tools/client-runtime/fd/factory";
import { workItemLinkTarget } from "@t3tools/client-runtime/fd/work-management";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import type { FactoryDelivery, FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import type { WorkItemSummary } from "@t3tools/contracts/fd/work-management";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, ChevronRightIcon, FactoryIcon } from "lucide-react";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { useDiffPanelStore } from "../../diffPanelStore";
import { PendingActionsList } from "../approvals";
import { FdRelativeTime } from "../list-rows";
import { useRightPanelStore } from "../../rightPanelStore";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { factoryErrorText, factoryParentDeliverable } from "./deliver";
import { FactoryPlanGate } from "./FactoryPlanGate";
import { useFactoryDeliverState, useFactoryStart, useReportOpenWorkItem } from "./hooks";
import {
  type FactoryCancelConfirmation,
  cancelConfirmationTarget,
  factoryItemSection,
  type FactoryReviewLine,
} from "./itemSection";
import { factoryItemPlanGate } from "./planGate";
import { factoryEnvironment } from "./state";

interface FactoryItemSectionProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly item: Pick<WorkItemSummary, "ref" | "key"> &
    Partial<Pick<WorkItemSummary, "status" | "nativeStatus" | "assignee">>;
}

/**
 * The Work item detail's Factory section: Deliver (as a parent too where the server plans), and
 * the item's current delivery: what it comes to now and what it asks of the owner first, then the
 * controls that answer it, its plan while it waits at the plan gate, its allowances, its stage
 * history, and the item's facts. It reads the delivery's current state, so a chat message from earlier in the delivery is
 * contradicted here rather than edited. Renders nothing on a server without Factory. Mounted by the Work route; while
 * mounted it reports its item as the one the palette's Deliver acts on.
 */
export function FactoryItemSection(props: FactoryItemSectionProps) {
  // A pending action, error or start belongs to one destination and item.
  const key = JSON.stringify([
    props.environmentId,
    props.projectId,
    props.item.ref.sourceId,
    props.item.ref.itemId,
  ]);
  return <ItemSection key={key} {...props} />;
}

type Action = "start" | "stop" | "resume" | "cancel";

const OUTCOME_VARIANTS = {
  success: "success",
  error: "error",
  warning: "warning",
  active: "info",
  neutral: "outline",
} as const;

function ItemSection({ environmentId, projectId, item }: FactoryItemSectionProps) {
  const navigate = useNavigate();
  const projects = useProjects();
  const threads = useThreadShells();
  const target = { environmentId, projectId, itemRef: item.ref };
  useReportOpenWorkItem({ ...target, key: item.key });
  const { destination, deliveriesQuery } = useFactoryDeliverState(target);
  const permitted = {
    start: destination.startPermitted,
    stop: useAtomValue(factoryEnvironment.stop.permissionAtom(environmentId)),
    resume: useAtomValue(factoryEnvironment.resume.permissionAtom(environmentId)),
    cancel: useAtomValue(factoryEnvironment.cancel.permissionAtom(environmentId)),
  };
  const planPermitted = {
    update: useAtomValue(factoryEnvironment.updatePlan.permissionAtom(environmentId)),
    approve: useAtomValue(factoryEnvironment.approvePlan.permissionAtom(environmentId)),
    reject: useAtomValue(factoryEnvironment.rejectPlan.permissionAtom(environmentId)),
    replan: useAtomValue(factoryEnvironment.replan.permissionAtom(environmentId)),
  };
  const start = useFactoryStart();
  const stop = useAtomCommand(factoryEnvironment.stop);
  const resume = useAtomCommand(factoryEnvironment.resume);
  const cancel = useAtomCommand(factoryEnvironment.cancel);
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The delivery the open cancel confirmation was opened for, and what it said cancelling ends.
  const [confirmingCancel, setConfirmingCancel] = useState<FactoryCancelConfirmation | null>(null);

  const view = factoryItemSection({
    environmentId,
    itemRef: item.ref,
    ...destination,
    permitted,
    ...(item.status === undefined || item.nativeStatus === undefined || item.assignee === undefined
      ? {}
      : {
          item: { status: item.status, nativeStatus: item.nativeStatus, assignee: item.assignee },
        }),
  });
  const cancelling = cancelConfirmationTarget(view, confirmingCancel);
  // Adjusted during render: a confirmation whose delivery was replaced, can no longer be
  // cancelled or would now end other deliveries closes, and does not come back if that delivery
  // becomes cancellable again.
  if (confirmingCancel !== null && cancelling === null) setConfirmingCancel(null);
  if (view === null) {
    return deliveriesQuery.error === null ? null : (
      <p className="text-destructive text-sm">{deliveriesQuery.error}</p>
    );
  }

  /**
   * Runs one command. The view changes only when the change stream refetches the deliveries (or,
   * for a start, once the start's delivery is recorded), so a refused command leaves it as it
   * was, with the refusal shown.
   */
  const run = async (action: Action, execute: () => Promise<string | null>) => {
    setPending(action);
    setError(null);
    const failure = await execute();
    setPending(null);
    if (failure !== null) setError(failure);
  };
  const command =
    (execute: () => Promise<AtomCommandResult<FactoryDelivery, unknown>>) => async () => {
      const result = await execute();
      return result._tag === "Failure" ? factoryErrorText(result.cause) : null;
    };
  const delivery = view.delivery;
  const control =
    delivery === null ? null : { environmentId, input: { deliveryId: delivery.deliveryId } };
  const deliverParent = factoryParentDeliverable({
    ...destination,
    environmentId,
    itemRef: item.ref,
  });
  const gate = factoryItemPlanGate({
    environmentId,
    itemRef: item.ref,
    ...destination,
    permitted: planPermitted,
  });
  /** Opens the thread whose checkout holds the pull request's changes, on all of them. */
  const reviewChanges = (thread: ScopedThreadRef) => {
    useDiffPanelStore.getState().selectGitScope(thread, "branch");
    useRightPanelStore.getState().open(thread, "diff");
    void navigate({ to: "/$environmentId/$threadId", params: thread });
  };

  return (
    <section className="space-y-2" aria-label="Factory">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium text-sm">Factory</h3>
        {delivery !== null ? (
          <Badge variant={delivery.nextAction.forYou ? "warning" : "outline"}>
            {delivery.label}
          </Badge>
        ) : null}
        {delivery?.stage !== undefined ? (
          <span className="text-muted-foreground text-xs">{delivery.stage}</span>
        ) : null}
        <div className="flex-1" />
        {deliverParent ? (
          <Button
            size="xs"
            variant="outline"
            disabled={pending !== null}
            onClick={() => void run("start", () => start(target, "parent"))}
          >
            <FactoryIcon />
            Deliver as parent
          </Button>
        ) : null}
        {view.deliver ? (
          <Button
            size="xs"
            disabled={pending !== null}
            onClick={() => void run("start", () => start(target))}
          >
            <FactoryIcon />
            Deliver
          </Button>
        ) : null}
      </div>
      {delivery !== null ? (
        <div
          className="space-y-1 rounded-md border p-2 text-sm"
          aria-label="What this delivery needs next"
        >
          <p className={delivery.nextAction.forYou ? "font-medium" : "text-muted-foreground"}>
            {delivery.nextAction.title}
          </p>
          <p className="text-muted-foreground text-xs">{delivery.nextAction.detail}</p>
          {delivery.nextAction.evidence !== null ? (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-2 text-xs">
              <dt className="text-muted-foreground">Verified commit</dt>
              <dd className="font-mono">{delivery.nextAction.evidence.verifiedCommit}</dd>
              <dt className="text-muted-foreground">Verify</dt>
              <dd>{delivery.nextAction.evidence.verify}</dd>
              <dt className="text-muted-foreground">Independent review</dt>
              <dd>{delivery.nextAction.evidence.review}</dd>
            </dl>
          ) : null}
          {delivery.nextAction.pullRequestUrl !== null ||
          delivery.nextAction.reviewThread !== null ||
          delivery.controls.stop ||
          delivery.controls.resume ||
          delivery.controls.cancel ? (
            // Everything the line above asks for is within reach of it.
            <div className="flex flex-wrap gap-2 pt-1">
              {delivery.nextAction.pullRequestUrl !== null ? (
                <Button
                  size="xs"
                  render={
                    <a href={delivery.nextAction.pullRequestUrl} target="_blank" rel="noreferrer" />
                  }
                >
                  Open pull request
                  <ArrowUpRightIcon />
                </Button>
              ) : null}
              {delivery.nextAction.reviewThread !== null ? (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    const { reviewThread } = delivery.nextAction;
                    if (reviewThread !== null) reviewChanges(reviewThread);
                  }}
                >
                  Review changes
                </Button>
              ) : null}
              {delivery.controls.resume && control !== null ? (
                <Button
                  size="xs"
                  // The one way on for a delivery at rest; taking a stop back is the lesser choice.
                  variant={delivery.nextAction.forYou ? "default" : "outline"}
                  disabled={pending !== null}
                  onClick={() =>
                    void run(
                      "resume",
                      command(() => resume(control)),
                    )
                  }
                >
                  {pending === "resume" ? "Resuming…" : "Resume"}
                </Button>
              ) : null}
              {delivery.controls.stop && control !== null ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={pending !== null}
                  onClick={() =>
                    void run(
                      "stop",
                      command(() => stop(control)),
                    )
                  }
                >
                  {pending === "stop" ? "Stopping…" : "Stop after step"}
                </Button>
              ) : null}
              {delivery.controls.cancel ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={pending !== null}
                  onClick={() =>
                    setConfirmingCancel({
                      deliveryId: delivery.deliveryId,
                      family: delivery.family,
                    })
                  }
                >
                  {pending === "cancel" ? "Cancelling…" : "Cancel delivery"}
                </Button>
              ) : null}
            </div>
          ) : null}
          {delivery.controlsNote !== undefined ? (
            <p className="text-muted-foreground text-xs">{delivery.controlsNote}</p>
          ) : null}
          {delivery.capacityNote !== undefined ? (
            <p className="text-muted-foreground text-xs">{delivery.capacityNote}</p>
          ) : null}
        </div>
      ) : null}
      {error !== null ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
      {delivery !== null ? (
        <PendingActionsList
          pending={delivery.pendingActions}
          shownItem={item.ref}
          projectName={(id) =>
            projects.find((project) => project.id === id && project.environmentId === environmentId)
              ?.title
          }
          threadName={(id) =>
            threads.find((thread) => thread.id === id && thread.environmentId === environmentId)
              ?.title
          }
          onOpenThread={(threadId) =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId, threadId },
            })
          }
          onOpenItem={(ref, itemProjectId) =>
            void navigate(workItemLinkTarget({ environmentId, projectId: itemProjectId, ref }))
          }
        />
      ) : null}
      {gate !== null ? (
        // A draft belongs to one delivery; another delivery's plan starts a draft of its own.
        <FactoryPlanGate
          key={JSON.stringify([gate.destination.environmentId, gate.destination.deliveryId])}
          gate={gate}
          itemKey={item.key}
        />
      ) : null}
      {deliveriesQuery.error !== null ? (
        <p className="text-destructive text-sm" role="alert">
          {deliveriesQuery.error}
        </p>
      ) : null}
      {delivery !== null ? (
        <div className="space-y-1" aria-label="Delivery counts">
          <h4 className="font-medium text-muted-foreground text-xs">Allowances</h4>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 text-xs">
            {delivery.counters.lines.map((line) => (
              <div key={line.key} className="contents">
                <dt className="text-muted-foreground">{line.label}</dt>
                <dd className="tabular-nums">{line.text}</dd>
              </div>
            ))}
            {delivery.counters.attempts !== undefined ? (
              <div className="contents">
                <dt className="text-muted-foreground">Attempts run</dt>
                <dd className="tabular-nums">{delivery.counters.attempts}</dd>
              </div>
            ) : null}
          </dl>
          {delivery.counters.scope !== undefined ? (
            <p className="text-muted-foreground text-xs">{delivery.counters.scope}</p>
          ) : null}
        </div>
      ) : null}
      {delivery !== null && delivery.timeline.length > 0 ? (
        <div className="space-y-1">
          <h4 className="font-medium text-muted-foreground text-xs">Stage history</h4>
          <ol className="space-y-1" aria-label="Delivery timeline">
            {delivery.timeline.map(({ thread, ...row }) => (
              <li key={row.key} className="space-y-0.5 rounded-md border p-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{row.stage}</span>
                  {row.round !== null ? (
                    <span className="text-muted-foreground">Attempt {row.round}</span>
                  ) : null}
                  <Badge size="sm" variant={OUTCOME_VARIANTS[row.outcomeTone]}>
                    {row.outcome}
                  </Badge>
                  <div className="flex-1" />
                  {row.startedAt !== undefined ? (
                    <span className="text-muted-foreground">
                      Started <FdRelativeTime at={row.startedAt} />
                    </span>
                  ) : null}
                  {thread !== null ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() =>
                        void navigate({ to: "/$environmentId/$threadId", params: thread })
                      }
                    >
                      Open thread
                    </Button>
                  ) : null}
                </div>
                {row.receipts.map((receipt) => (
                  <p key={receipt.key}>Verify: {receipt.text}</p>
                ))}
                {row.reviews.map((review) => (
                  <ReviewEvidence key={review.key} review={review} />
                ))}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {delivery !== null && (delivery.receipts.length > 0 || delivery.reviews.length > 0) ? (
        <div
          className="space-y-0.5 rounded-md border p-2 text-xs"
          aria-label="Receipts and reviews"
        >
          <p className="text-muted-foreground">Receipts and reviews</p>
          {delivery.receipts.map((receipt) => (
            <p key={receipt.key}>Verify: {receipt.text}</p>
          ))}
          {delivery.reviews.map((review) => (
            <ReviewEvidence key={review.key} review={review} />
          ))}
        </div>
      ) : null}
      {delivery !== null ? (
        <div className="space-y-1">
          <h4 className="font-medium text-muted-foreground text-xs">Item and delivery</h4>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 text-xs" aria-label="Item facts">
            {delivery.facts.map((fact) => (
              <div key={fact.key} className="contents">
                <dt className="text-muted-foreground">{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
            {delivery.branch === undefined ? null : (
              <div className="contents">
                <dt className="text-muted-foreground">Branch</dt>
                <dd className="break-all font-mono">{delivery.branch}</dd>
              </div>
            )}
          </dl>
        </div>
      ) : null}
      {delivery !== null ? (
        <DeliveryRoles environmentId={environmentId} deliveryId={delivery.deliveryId} />
      ) : null}
      <AlertDialog
        open={cancelling !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmingCancel(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel the delivery of {item.key}?</AlertDialogTitle>
            <AlertDialogDescription>
              {FACTORY_CANCEL_TEXT[confirmingCancel?.family ?? "single"]}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Keep it</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={cancelling === null || pending !== null}
              onClick={() => {
                if (cancelling === null) return;
                setConfirmingCancel(null);
                void run(
                  "cancel",
                  command(() => cancel({ environmentId, input: { deliveryId: cancelling } })),
                );
              }}
            >
              Cancel delivery
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}

/**
 * What each role of the delivery runs on, requested and as its provider reported it. It takes its own
 * read of the one delivery on screen, since a listing does not carry it; until that answers, and on a
 * server from before it, this shows nothing.
 */
function DeliveryRoles({
  environmentId,
  deliveryId,
}: {
  readonly environmentId: EnvironmentId;
  readonly deliveryId: FactoryDeliveryId;
}) {
  const { data } = useEnvironmentQuery(
    factoryEnvironment.delivery({ environmentId, input: { deliveryId } }),
  );
  const view = data === null ? null : factoryExecutionView(data);
  if (view === null) return null;
  return (
    // Reference detail, so it stays folded until asked for.
    <details className="group/roles text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-1 rounded-sm font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon className="size-3.5 shrink-0 group-open/roles:rotate-90" />
        What each role runs on
      </summary>
      <div className="space-y-1 pt-1">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3">
          {view.roles.map((role) => (
            <div key={role.key} className="contents">
              <dt className="text-muted-foreground">
                {role.label} · {role.binding}
              </dt>
              <dd>{role.reviewed ?? role.requested}</dd>
              {role.reviewed !== undefined ? (
                <>
                  <dt className="text-muted-foreground">Requested</dt>
                  <dd>{role.requested}</dd>
                </>
              ) : null}
              <dt className="text-muted-foreground">Provider reported</dt>
              <dd>{role.acknowledged}</dd>
            </div>
          ))}
        </dl>
        <p className="text-muted-foreground">{view.note}</p>
      </div>
    </details>
  );
}

/**
 * A review's line and what it raised. Reviewer text is rendered as text, never as HTML or
 * Markdown, so nothing in it can run or link anywhere.
 */
function ReviewEvidence({ review }: { readonly review: FactoryReviewLine }) {
  return (
    <>
      <p>Review: {review.text}</p>
      {review.notes.length > 0 ? (
        <ul className="space-y-1 ps-3" aria-label="Review findings">
          {review.notes.map((note) => (
            <li key={note.key}>
              <p>
                <span className="font-medium">{note.label}</span>
                {note.required ? " · Required" : null}
                {note.blocking ? " · Blocking" : null}
                {note.location !== undefined ? (
                  <span className="font-mono text-muted-foreground"> {note.location}</span>
                ) : null}
              </p>
              <p className="whitespace-pre-wrap break-words">{note.detail}</p>
            </li>
          ))}
        </ul>
      ) : null}
      {review.omitted !== undefined ? (
        <p className="ps-3 text-muted-foreground">{review.omitted}</p>
      ) : null}
    </>
  );
}
