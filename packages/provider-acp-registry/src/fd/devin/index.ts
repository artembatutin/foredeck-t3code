import { makeProviderSettingsSchema, ProviderDriverKind, TrimmedString } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { AcpRegistrySettings } from "../../settings.ts";

export const DEVIN_DRIVER_KIND = ProviderDriverKind.make("devin");

/** The native CLI owns its account and session store on the selected environment. */
export const DevinSettings = makeProviderSettingsSchema(
  {
    ...AcpRegistrySettings.fields,
    source: Schema.Literal("local").pipe(
      Schema.withDecodingDefault(Effect.succeed("local")),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    agentId: Schema.Literal("devin").pipe(
      Schema.withDecodingDefault(Effect.succeed("devin")),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    commandPath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("devin")),
      Schema.annotateKey({
        title: "Devin CLI executable",
        description:
          "Executable on this environment. Install Devin CLI and sign in before starting a thread.",
        providerSettingsForm: { placeholder: "devin", clearWhenEmpty: "omit" },
      }),
    ),
    commandArgs: Schema.Tuple([Schema.Literal("acp")]).pipe(
      Schema.withDecodingDefault(Effect.succeed(["acp"] as const)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  { order: ["commandPath", "authMethodId"] },
);
export type DevinSettings = typeof DevinSettings.Type;
export const DEFAULT_DEVIN_SETTINGS = Schema.decodeSync(DevinSettings)({});

export const devinClient = defineProviderClient({
  driverKind: DEVIN_DRIVER_KIND,
  label: "Devin CLI",
  settingsSchema: DevinSettings,
  hasDefaultInstance: false,
  environmentFields: [
    {
      name: "WINDSURF_API_KEY",
      label: "Devin API key",
      description:
        "Optional credential for this instance. Otherwise use Devin CLI sign-in on this environment.",
      sensitive: true,
    },
  ],
  icon: {
    viewBox: "0 0 24 24",
    fill: { light: "#9c6512", dark: "#e9b85a" },
    paths: [{ d: "M5 3h6a9 9 0 0 1 0 18H5V3Zm4 4v10h2a5 5 0 0 0 0-10H9Z" }],
  },
});
