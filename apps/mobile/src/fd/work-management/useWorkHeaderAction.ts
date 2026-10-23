import { useNavigation } from "@react-navigation/native";
import { useCallback } from "react";

import { useWorkSupport } from "./state";

/**
 * The header's Work entry: null until an environment advertises Work, so each platform's
 * header can add it without knowing about Work. `supported` keys header option versions.
 */
export function useWorkHeaderAction(): { readonly onPress: () => void } | null {
  const supported = useWorkSupport().size > 0;
  const navigation = useNavigation();
  const onPress = useCallback(() => navigation.navigate("WorkList", {}), [navigation]);
  return supported ? { onPress } : null;
}
