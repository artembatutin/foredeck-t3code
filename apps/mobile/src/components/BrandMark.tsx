import Constants from "expo-constants";
import { View } from "react-native";

import { AppText as Text } from "./AppText";
import { ForedeckAnchor } from "../fd/branding";
import { FOREDECK_WORDMARK } from "@t3tools/shared/fd/branding";

const appVariant = Constants.expoConfig?.extra?.appVariant;
const DEFAULT_STAGE_LABEL =
  appVariant === "development" ? "Dev" : appVariant === "preview" ? "Preview" : "Alpha";

export function BrandMark(props: { readonly compact?: boolean; readonly stageLabel?: string }) {
  const compact = props.compact ?? false;
  const iconSize = compact ? 32 : 44;
  const stageLabel = props.stageLabel ?? DEFAULT_STAGE_LABEL;

  return (
    <View className="flex-row items-center gap-3">
      <ForedeckAnchor height={iconSize} colorClassName="text-foreground" />
      <View className="gap-1">
        <View className="flex-row items-center gap-2">
          <Text className="font-bold text-foreground" style={{ fontSize: 22, letterSpacing: -0.3 }}>
            {FOREDECK_WORDMARK}
          </Text>
          <View className="rounded-full bg-subtle px-2 py-1">
            <Text className="text-3xs font-semibold tracking-[0.3px] text-foreground-muted">
              {stageLabel}
            </Text>
          </View>
        </View>
        {!compact ? (
          <Text className="text-xs font-medium text-foreground-muted">
            Mobile control surface for your live coding environments
          </Text>
        ) : null}
      </View>
    </View>
  );
}
