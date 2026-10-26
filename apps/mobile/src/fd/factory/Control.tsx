import { Pressable } from "react-native";

import { AppText as Text } from "../../components/AppText";

/** A Factory section's action pill. */
export function Control({
  label,
  disabled = false,
  onPress,
}: {
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className={
        disabled
          ? "rounded-full bg-subtle-strong px-3 py-1.5 opacity-40"
          : "rounded-full bg-subtle-strong px-3 py-1.5 active:opacity-70"
      }
    >
      <Text className="text-sm font-t3-medium text-foreground">{label}</Text>
    </Pressable>
  );
}
