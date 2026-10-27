import { factorySettingsDraft } from "@t3tools/client-runtime/fd/factory";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { FactoryProjectSettings } from "@t3tools/contracts/fd/factory";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { factorySettingsMode, factorySettingsSave } from "./settingsSection";

const stored = Schema.decodeSync(FactoryProjectSettings)({
  blockingSeverities: ["medium", "low"],
  highRiskEffort: "max",
  pipelineId: "stored-pipeline",
});
const target = {
  environmentId: EnvironmentId.make("env-a"),
  projectId: ProjectId.make("project-a"),
};
const access = { supported: true, connected: true, writePermitted: true };

describe("Factory settings section review policy", () => {
  it("shows stored values and offers no save until edited", () => {
    const form = { target, draft: factorySettingsDraft(stored) };
    expect(form.draft.blockingSeverities).toStrictEqual(["medium", "low"]);
    expect(form.draft.highRiskEffort).toBe("max");
    expect(factorySettingsMode(access)).toBe("editable");
    expect(factorySettingsSave(target, access, form)).toStrictEqual({ _tag: "Unavailable" });
  });

  it.each([
    {
      blockingSeverities: ["low", "high"] as const,
      highRiskEffort: "max",
      expected: ["high", "low"],
    },
    {
      blockingSeverities: ["medium", "low"] as const,
      highRiskEffort: " high ",
      expected: ["medium", "low"],
    },
    { blockingSeverities: [], highRiskEffort: " custom ", expected: [] },
  ])(
    "saves policy edits through the existing destination-bound request: %j",
    ({ expected, ...edit }) => {
      const form = { target, draft: { ...factorySettingsDraft(stored), ...edit } };
      expect(factorySettingsSave(target, access, form)).toStrictEqual({
        _tag: "Save",
        request: {
          environmentId: target.environmentId,
          input: {
            projectId: target.projectId,
            settings: {
              ...stored,
              blockingSeverities: expected,
              highRiskEffort: edit.highRiskEffort.trim(),
            },
          },
        },
      });
    },
  );

  it("leaves stored policy visible read-only and refuses edited saves without settings permission", () => {
    const denied = { ...access, writePermitted: false };
    const draft = factorySettingsDraft(stored);
    expect(factorySettingsMode(denied)).toBe("read-only");
    expect(draft.blockingSeverities).toStrictEqual(stored.blockingSeverities);
    expect(draft.highRiskEffort).toBe(stored.highRiskEffort);
    expect(
      factorySettingsSave(target, denied, {
        target,
        draft: { ...draft, blockingSeverities: [], highRiskEffort: "high" },
      }),
    ).toStrictEqual({ _tag: "Unavailable" });
  });

  it("returns the effort field error instead of a save request", () => {
    const form = { target, draft: { ...factorySettingsDraft(stored), highRiskEffort: " " } };
    expect(factorySettingsSave(target, access, form)).toStrictEqual({
      _tag: "Invalid",
      errors: { highRiskEffort: "Enter an effort value." },
    });
  });
});
