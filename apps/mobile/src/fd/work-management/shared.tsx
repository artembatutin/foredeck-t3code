import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { WorkStatus } from "@t3tools/contracts/fd/work-management";
import type { ReactNode } from "react";
import { Platform, View } from "react-native";

import type { AppSymbolName } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";
import { EmptyState } from "../../components/EmptyState";

export const STATUS_LABELS: Record<WorkStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
  cancelled: "Cancelled",
  unknown: "Unknown",
};

/** The symbol a list row leads with for an item's status, as pull request rows do. */
export const STATUS_SYMBOLS: Record<
  WorkStatus,
  { readonly icon: AppSymbolName; readonly tint: string }
> = {
  todo: { icon: "circle", tint: "accent-icon-muted" },
  in_progress: { icon: "circle.inset.filled", tint: "accent-primary-text" },
  done: { icon: "checkmark.circle", tint: "accent-adaptive-emerald-600-400" },
  cancelled: { icon: "xmark.circle.fill", tint: "accent-icon-muted" },
  unknown: { icon: "circle.dashed", tint: "accent-icon-muted" },
};

/** The message a failed Work command shows: the server's own text. */
export function workCommandError(result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The Work request failed.";
}

/** Shown where this device was paired before Work; passive surfaces show nothing instead. */
export function WorkRepairNotice() {
  return (
    <View className="flex-1 justify-center bg-screen">
      <EmptyState
        variant="plain"
        title="This connection cannot read Work"
        detail="It was paired before Work existed. Pair this device again from a session that has Work access."
      />
    </View>
  );
}

/** A heading for one part of the item screen, with an optional action beside it. */
export function SectionTitle({
  children,
  trailing,
}: {
  readonly children: ReactNode;
  readonly trailing?: ReactNode;
}) {
  return (
    <View className="min-h-8 flex-row items-center gap-2">
      <Text className="flex-1 text-base font-t3-semibold text-foreground">{children}</Text>
      {trailing}
    </View>
  );
}

/** A read-only fact about the item, in the shape of a filter pill. */
export function Chip({ label, tone = "neutral" }: { label: string; tone?: "neutral" | "warning" }) {
  return (
    <View
      className={
        tone === "warning"
          ? "h-8 flex-row items-center rounded-full bg-warning px-3"
          : "h-8 flex-row items-center rounded-full bg-subtle px-3"
      }
    >
      <Text
        numberOfLines={1}
        className={
          tone === "warning"
            ? "max-w-[180px] text-sm font-t3-medium text-warning-foreground"
            : "max-w-[180px] text-sm font-t3-medium text-foreground-muted"
        }
      >
        {label}
      </Text>
    </View>
  );
}

/** A Work action button; `primary` marks the one action a form or draft exists for. */
export function Action({
  label,
  disabled = false,
  primary = false,
  onPress,
}: {
  label: string;
  disabled?: boolean;
  primary?: boolean;
  onPress: () => void;
}) {
  return (
    <ControlPill
      label={label}
      variant={primary ? "primary" : "pill"}
      disabled={disabled}
      onPress={onPress}
      // The primary variant and Android's Material button draw their own disabled state.
      className={disabled && !primary && Platform.OS !== "android" ? "opacity-40" : undefined}
    />
  );
}
