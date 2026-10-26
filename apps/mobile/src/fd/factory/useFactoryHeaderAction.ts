import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { useCallback } from "react";

import { factoryAnySupportedAtom } from "./state";

/**
 * The header's Factory entry: null until an environment advertises Factory, so each platform's
 * header can add it beside Work's without either knowing the other. Its presence keys header
 * option versions.
 */
export function useFactoryHeaderAction(): { readonly onPress: () => void } | null {
  const supported = useAtomValue(factoryAnySupportedAtom);
  const navigation = useNavigation();
  const onPress = useCallback(() => navigation.navigate("FactoryList"), [navigation]);
  return supported ? { onPress } : null;
}
