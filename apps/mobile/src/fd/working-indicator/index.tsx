import { useEffect } from "react";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedSvg = withUniwind(Svg);

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Slow, quiet ring for a working thread: a faint track with a short rounded
 * arc orbiting it. Rotation runs on the UI thread and stops under reduced motion.
 */
export function WorkingSpinner(props: { readonly size: number; readonly colorClassName: string }) {
  const reducedMotion = useReducedMotion();
  const rotation = useSharedValue(0);

  useEffect(() => {
    if (reducedMotion) return;
    rotation.set(withRepeat(withTiming(360, { duration: 1800, easing: Easing.linear }), -1));
    return () => cancelAnimation(rotation);
  }, [reducedMotion, rotation]);

  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${rotation.get()}deg` }] }));

  return (
    <Animated.View style={[{ width: props.size, height: props.size }, style]}>
      <ThemedSvg
        width={props.size}
        height={props.size}
        viewBox="0 0 16 16"
        fill="none"
        colorClassName={props.colorClassName}
      >
        <Circle
          cx={8}
          cy={8}
          r={RADIUS}
          stroke="currentColor"
          strokeOpacity={0.18}
          strokeWidth={2}
        />
        <Circle
          cx={8}
          cy={8}
          r={RADIUS}
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray={`${CIRCUMFERENCE * 0.3} ${CIRCUMFERENCE}`}
        />
      </ThemedSvg>
    </Animated.View>
  );
}
