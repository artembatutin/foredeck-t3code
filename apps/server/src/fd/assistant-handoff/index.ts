import * as Layer from "effect/Layer";

import { HandoffBackend } from "../assistant/index.ts";
import { FactoryAdmission } from "../factory/index.ts";
import * as FactoryAdmissionBridge from "./FactoryAdmissionBridge.ts";
import * as WorkBackend from "./WorkBackend.ts";

/**
 * The bridge between the project assistant and the Work and Factory features it hands work to.
 * The assistant imports neither; the server composes these beneath it.
 */

/** The assistant's Work port over Work's service, which it needs. */
export const layerBackend = Layer.effect(HandoffBackend.HandoffBackend, WorkBackend.make);

/**
 * Factory's admission port over the assistant's admission of the roots it manages, and the
 * assistant's redelivery of the automatic turns it reserved a slot for. Needs the assistant's
 * admission, its Work port (for the fresh reads its decisions ask for), core's question reactor
 * and the continuation queue core's worker drains.
 */
export const layerAdmission = Layer.mergeAll(
  Layer.effect(FactoryAdmission.FactoryAdmission, FactoryAdmissionBridge.make),
  Layer.effect(HandoffBackend.HandoffRedelivery, FactoryAdmissionBridge.makeRedelivery),
);
