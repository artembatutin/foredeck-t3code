import { FOREDECK_ANCHOR_SVG } from "@t3tools/shared/fd/branding";
import type { ColorValue } from "react-native";
import { SvgXml } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedAnchor = withUniwind(SvgXml);

export function ForedeckAnchor(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <ThemedAnchor
      accessibilityLabel="Foredeck"
      xml={FOREDECK_ANCHOR_SVG}
      height={props.height}
      width={props.height}
      color={props.color}
      colorClassName={props.colorClassName}
    />
  );
}
