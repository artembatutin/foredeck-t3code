import type { ReactNode } from "react";
import { Platform, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";

/** A Factory action button; `primary` marks the decision a section exists for. */
export function Control({
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

/** A heading for one part of the Factory section, with optional detail beside it. */
export function SectionTitle({
  children,
  trailing,
}: {
  readonly children: ReactNode;
  readonly trailing?: ReactNode;
}) {
  return (
    <View className="min-h-8 flex-row flex-wrap items-center gap-2">
      <Text className="text-base font-t3-semibold text-foreground">{children}</Text>
      {trailing}
    </View>
  );
}
