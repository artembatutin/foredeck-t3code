import * as Layer from "effect/Layer";

import { HandoffBackend } from "../assistant/index.ts";
import * as WorkBackend from "./WorkBackend.ts";

/**
 * The bridge between the project assistant and the Work and Factory features it hands work to.
 * The assistant imports neither; the server composes these beneath it.
 */

/** The assistant's Work port over Work's service, which it needs. */
export const layerBackend = Layer.effect(HandoffBackend.HandoffBackend, WorkBackend.make);
