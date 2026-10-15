import {
  ProviderDriverKind,
  TrimmedNonEmptyString,
  TrimmedString,
  makeProviderSettingsSchema,
} from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

// Generic provider forms write strings; the server consumes typed API values.
const AcuLimit = Schema.Union([Schema.Number, TrimmedString]).pipe(
  Schema.decodeTo(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
    SchemaTransformation.transform<number, number | string>({
      decode: (value) => (typeof value === "number" ? value : Number(value)),
      encode: String,
    }),
  ),
);

const Repositories = Schema.Union([Schema.Array(TrimmedNonEmptyString), Schema.String]).pipe(
  Schema.decodeTo(
    Schema.Array(TrimmedNonEmptyString),
    SchemaTransformation.transform({
      decode: (value) =>
        typeof value === "string"
          ? value
              .split(/[\n,]+/)
              .map((repo) => repo.trim())
              .filter(Boolean)
          : value,
      encode: (value) => value.join("\n"),
    }),
  ),
);

export const DevinCloudSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    organizationId: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Organization ID",
        description:
          "Find your organization ID in Devin Settings > Devin API. Cloud sessions run in Devin's environment.",
        providerSettingsForm: { placeholder: "org-…", clearWhenEmpty: "persist" },
      }),
    ),
    maxAcuLimit: AcuLimit.pipe(
      Schema.withDecodingDefault(Effect.succeed(10)),
      Schema.annotateKey({
        title: "Session ACU limit",
        description: "Maximum Agent Compute Units for each cloud session. Defaults to 10.",
        providerSettingsForm: { placeholder: "10", clearWhenEmpty: "omit" },
      }),
    ),
    repos: Repositories.pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({
        title: "Cloud repositories",
        description:
          "Repositories Devin can access, separated by commas or new lines. Your local files are not uploaded.",
        providerSettingsForm: {
          control: "textarea",
          placeholder: "owner/repository",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    devinMode: Schema.Literals(["normal", "fast"]).pipe(
      Schema.withDecodingDefault(Effect.succeed("normal")),
      Schema.annotateKey({
        title: "Default cloud mode",
        providerSettingsForm: {
          control: "select",
          options: [
            { value: "normal", label: "Normal" },
            { value: "fast", label: "Fast" },
          ],
        },
      }),
    ),
  },
  { order: ["organizationId", "repos", "maxAcuLimit", "devinMode"] },
);
export type DevinCloudSettings = typeof DevinCloudSettings.Type;

export const DEFAULT_DEVIN_CLOUD_SETTINGS = Schema.decodeSync(DevinCloudSettings)({});

export const devinCloudClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("devinCloud"),
  label: "Devin Cloud",
  hasDefaultInstance: false,
  settingsSchema: DevinCloudSettings,
  environmentFields: [
    {
      name: "DEVIN_API_KEY",
      label: "Devin API key",
      description:
        "A cog_ personal access token or service user API key with session access to this organization.",
      placeholder: "cog_…",
      sensitive: true,
    },
  ],
  icon: {
    viewBox: "0 0 24 24",
    fill: { light: "#9c6512", dark: "#e9b85a" },
    paths: [
      {
        d: "M7 19a5 5 0 0 1-.9-9.92A6.5 6.5 0 0 1 18.6 8.6 5.25 5.25 0 0 1 18.75 19H7Zm0-2h11.75a3.25 3.25 0 0 0-.5-6.46l-1.04.16-.1-1.04a4.5 4.5 0 0 0-8.91.22L8.1 11H7a3 3 0 0 0 0 6Z",
      },
    ],
  },
});
