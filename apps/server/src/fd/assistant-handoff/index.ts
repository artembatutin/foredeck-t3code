import * as Layer from "effect/Layer";

import * as McpCallerPolicy from "../../mcp/McpCallerPolicy.ts";
import { HandoffBackend } from "../assistant/index.ts";
import { FactoryAdmission } from "../factory/index.ts";
import * as CallerPolicy from "./CallerPolicy.ts";
import * as FactoryAdmissionBridge from "./FactoryAdmissionBridge.ts";
import * as FactoryBackend from "./FactoryBackend.ts";
import * as WorkBackend from "./WorkBackend.ts";

/**
 * The bridge between the project assistant and the Work and Factory features it hands work to.
 * The assistant imports neither; the server composes these beneath it.
 */

export * as CallerTools from "./callerTools.ts";
export { callerPolicyText } from "./CallerPolicy.ts";

/** The assistant's Work port over Work's service, which it needs. */
export const layerBackend = Layer.effect(HandoffBackend.HandoffBackend, WorkBackend.make);

/** The assistant's Factory port over Factory's service and settings, which it needs. */
export const layerFactory = Layer.effect(HandoffBackend.HandoffFactory, FactoryBackend.make);

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

/**
 * The MCP caller policy for the threads of the Factory deliveries the assistant manages (see
 * `CallerPolicy`), which the MCP endpoint applies to every thread caller. Needs Factory's service,
 * the assistant's admission and its Work port.
 */
export const layerCallerPolicy = Layer.effect(McpCallerPolicy.McpCallerPolicy, CallerPolicy.make);
