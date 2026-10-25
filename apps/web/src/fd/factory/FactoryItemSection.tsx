import { useAtomValue } from "@effect/atom-react";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { FactoryDelivery, FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import type { WorkItemSummary } from "@t3tools/contracts/fd/work-management";
import { useNavigate } from "@tanstack/react-router";
import { FactoryIcon } from "lucide-react";
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
import { useConnectedEnvironmentIds } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { cancelConfirmationTarget, factoryErrorText, factoryItemSection } from "./itemSection";
import { factoryEnvironment } from "./state";

interface FactoryItemSectionProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly item: Pick<WorkItemSummary, "ref" | "key">;
}

/**
 * The Work item detail's Factory section: Deliver, and the item's current delivery with its
 * timeline and controls. Renders nothing on a server without Factory. Mounted by the Work route.
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

function ItemSection({ environmentId, projectId, item }: FactoryItemSectionProps) {
  const navigate = useNavigate();
  const supported = useAtomValue(factoryEnvironment.supported(environmentId));
  const connected = useConnectedEnvironmentIds().includes(environmentId);
  const deliveriesQuery = useEnvironmentQuery(
    factoryEnvironment.deliveries({ environmentId, input: { projectId } }),
  );
  const permitted = {
    start: useAtomValue(factoryEnvironment.start.permissionAtom(environmentId)),
    stop: useAtomValue(factoryEnvironment.stop.permissionAtom(environmentId)),
    resume: useAtomValue(factoryEnvironment.resume.permissionAtom(environmentId)),
    cancel: useAtomValue(factoryEnvironment.cancel.permissionAtom(environmentId)),
  };
  const start = useAtomCommand(factoryEnvironment.start);
  const stop = useAtomCommand(factoryEnvironment.stop);
  const resume = useAtomCommand(factoryEnvironment.resume);
  const cancel = useAtomCommand(factoryEnvironment.cancel);
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<FactoryDelivery | null>(null);
  // The delivery the open cancel confirmation was opened for.
  const [confirmingCancel, setConfirmingCancel] = useState<FactoryDeliveryId | null>(null);

  const view = factoryItemSection({
    environmentId,
    itemRef: item.ref,
    supported,
    connected,
    deliveries: deliveriesQuery.data?.deliveries ?? null,
    started,
    permitted,
  });
  const cancelling = cancelConfirmationTarget(view, confirmingCancel);
  // Adjusted during render: a confirmation whose delivery was replaced or can no longer be
  // cancelled closes, and does not come back if that delivery becomes cancellable again.
  if (confirmingCancel !== null && cancelling === null) setConfirmingCancel(null);
  if (view === null) {
    return deliveriesQuery.error === null ? null : (
      <p className="text-destructive text-sm">{deliveriesQuery.error}</p>
    );
  }

  /**
   * Runs one command. The view changes only when the change stream refetches the deliveries, so
   * a refused command leaves it as it was, with the refusal shown.
   */
  const run = async (
    action: Action,
    execute: () => Promise<AtomCommandResult<FactoryDelivery, unknown>>,
  ) => {
    setPending(action);
    setError(null);
    const result = await execute();
    setPending(null);
    if (result._tag === "Failure") {
      setError(factoryErrorText(result.cause));
    } else if (action === "start") {
      setStarted(result.value);
    }
  };
  const delivery = view.delivery;
  const target =
    delivery === null ? null : { environmentId, input: { deliveryId: delivery.deliveryId } };

  return (
    <section className="space-y-2" aria-label="Factory">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium text-sm">Factory</h3>
        {delivery !== null ? (
          <Badge variant={delivery.needsYou === undefined ? "outline" : "warning"}>
            {delivery.label}
          </Badge>
        ) : null}
        {delivery?.stage !== undefined ? (
          <span className="text-muted-foreground text-xs">{delivery.stage}</span>
        ) : null}
        <div className="flex-1" />
        {view.deliver ? (
          <Button
            size="xs"
            disabled={pending !== null}
            onClick={() =>
              void run("start", () => start({ environmentId, input: { itemRef: item.ref } }))
            }
          >
            <FactoryIcon />
            Deliver
          </Button>
        ) : null}
      </div>
      {delivery?.needsYou !== undefined ? (
        <p className="text-sm text-warning-foreground">{delivery.needsYou}</p>
      ) : null}
      {delivery !== null && target !== null ? (
        <>
          <p className="text-muted-foreground text-xs">
            {delivery.branch === undefined ? "" : `${delivery.branch} · `}
            Fix rounds {delivery.rounds.fix} · Review rounds {delivery.rounds.review}
          </p>
          {delivery.controls.stop || delivery.controls.resume || delivery.controls.cancel ? (
            <div className="flex flex-wrap gap-2">
              {delivery.controls.stop ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={pending !== null}
                  onClick={() => void run("stop", () => stop(target))}
                >
                  Stop after step
                </Button>
              ) : null}
              {delivery.controls.resume ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={pending !== null}
                  onClick={() => void run("resume", () => resume(target))}
                >
                  Resume
                </Button>
              ) : null}
              {delivery.controls.cancel ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={pending !== null}
                  onClick={() => setConfirmingCancel(delivery.deliveryId)}
                >
                  Cancel delivery
                </Button>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
      {error !== null ? <p className="text-destructive text-sm">{error}</p> : null}
      {deliveriesQuery.error !== null ? (
        <p className="text-destructive text-sm">{deliveriesQuery.error}</p>
      ) : null}
      {delivery !== null && delivery.timeline.length > 0 ? (
        <ol className="space-y-1" aria-label="Delivery timeline">
          {delivery.timeline.map(({ thread, ...row }) => (
            <li key={row.key} className="space-y-0.5 rounded-md border p-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-medium">{row.stage}</span>
                {row.round !== null ? (
                  <span className="text-muted-foreground">Round {row.round}</span>
                ) : null}
                <span className="text-muted-foreground">{row.outcome}</span>
                <div className="flex-1" />
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
              {row.startedAt !== undefined ? (
                <p className="text-muted-foreground">
                  Started {new Date(row.startedAt).toLocaleString()}
                </p>
              ) : null}
              {row.receipts.map((receipt) => (
                <p key={receipt.key}>Verify: {receipt.text}</p>
              ))}
              {row.reviews.map((review) => (
                <p key={review.key}>Review: {review.text}</p>
              ))}
            </li>
          ))}
        </ol>
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
              Its agents stop what they are working on and the delivery ends. Its branch, worktree
              and commits stay; delivering the item again starts on a new branch.
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
                void run("cancel", () =>
                  cancel({ environmentId, input: { deliveryId: cancelling } }),
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
