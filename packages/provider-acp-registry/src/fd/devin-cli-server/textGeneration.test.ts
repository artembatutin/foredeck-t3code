import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { DEFAULT_DEVIN_SETTINGS } from "../devin/index.ts";
import { makeDevinTextGeneration } from "./textGeneration.ts";

const fixture = (directory: string, reply: string, stopReason = "end_turn") =>
  writeFakeCli({
    directory,
    name: "devin",
    source: `
  import { createInterface } from 'node:readline';
  import { appendFileSync } from 'node:fs';
  if (process.argv.slice(2).join(' ') !== 'acp --agent-type summarizer') process.exit(2);
  const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
  createInterface({input:process.stdin}).on('line', line => {
    const request=JSON.parse(line), {method,params,id}=request;
    appendFileSync(${JSON.stringify(`${directory}/requests.jsonl`)}, JSON.stringify(request)+'\\n');
    if (!id) return;
    let result={};
    if(method==='initialize') result={protocolVersion:1,agentCapabilities:{},authMethods:[]};
    if(method==='session/new') result={sessionId:'text',configOptions:[{id:'model',name:'Model',category:'model',type:'select',currentValue:'native',options:[{value:'native',name:'Native'}]}]};
    if(method==='session/set_config_option') result={configOptions:[{id:'model',name:'Model',category:'model',type:'select',currentValue:params.value,options:[{value:params.value,name:'Selected'}]}]};
    if(method==='session/prompt') {
      send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'text',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:${JSON.stringify(reply)}}}}});
      result={stopReason:${JSON.stringify(stopReason)}};
    }
    send({jsonrpc:'2.0',id,result});
  });
`,
  });
const selection = { instanceId: ProviderInstanceId.make("local"), model: "native" };
describe("tool-free native text generation", () => {
  it.effect("generates titles, branches, commits and PR content with no workspace tools", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "native-text-" });
      const commandPath = fixture(
        directory,
        JSON.stringify({
          title: "Improve model selection",
          subject: "fix(models): preserve limits",
          body: "Keep native limits.",
          branch: "feature/model-limits",
        }),
      );
      const generator = yield* makeDevinTextGeneration(
        { ...DEFAULT_DEVIN_SETTINGS, commandPath },
        process.env,
      );
      expect(
        (yield* generator.generateThreadTitle({
          cwd: directory,
          message: "Improve models",
          modelSelection: selection,
        })).title,
      ).toBe("Improve model selection");
      expect(
        (yield* generator.generateBranchName({
          cwd: directory,
          message: "Improve models",
          modelSelection: selection,
        })).branch,
      ).toBe("feature/model-limits");
      expect(
        (yield* generator.generateCommitMessage({
          cwd: directory,
          branch: null,
          stagedSummary: "model limits",
          stagedPatch: "diff",
          modelSelection: selection,
        })).subject,
      ).toBe("fix(models): preserve limits");
      expect(
        (yield* generator.generatePrContent({
          cwd: directory,
          baseBranch: "main",
          headBranch: "feature/model-limits",
          commitSummary: "limits",
          diffSummary: "limits",
          diffPatch: "diff",
          modelSelection: selection,
        })).title,
      ).toBe("Improve model selection");
      const log = (yield* fs.readFileString(`${directory}/requests.jsonl`))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const starts = log.filter((request) => request.method === "session/new");
      expect(starts).toHaveLength(4);
      expect(
        starts.every(
          (request) => request.params.cwd !== directory && request.params.mcpServers.length === 0,
        ),
      ).toBe(true);
      expect(
        log
          .filter((request) => request.method === "initialize")
          .every((request) => request.params.clientCapabilities.terminal === false),
      ).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.each([
    ["invalid JSON", "end_turn"],
    ['{"title":"Partial"}', "max_tokens"],
    ['{"title":"Cancelled"}', "cancelled"],
  ] as const)("rejects invalid or incomplete output: %s", ([reply, reason]) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "native-text-failure-" });
      const commandPath = fixture(directory, reply!, reason);
      const generator = yield* makeDevinTextGeneration(
        { ...DEFAULT_DEVIN_SETTINGS, commandPath },
        process.env,
      );
      const failure = yield* generator
        .generateThreadTitle({ cwd: directory, message: "title", modelSelection: selection })
        .pipe(Effect.flip);
      expect(failure._tag).toBe("TextGenerationError");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
