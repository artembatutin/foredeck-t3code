import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import { FACTORY_CAPABILITY, factorySupport } from "@t3tools/contracts/fd/factory";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";

const encodeDescriptor = Schema.encodeSync(ExecutionEnvironmentDescriptor);
const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

it.layer(NodeServices.layer)("Factory capability", (it) => {
  it.effect("is advertised in the server's environment descriptor as a client reads it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "fd-factory-environment-",
      });
      const descriptor = yield* Effect.flatMap(
        ServerEnvironment.ServerEnvironment,
        (environment) => environment.getDescriptor,
      ).pipe(
        Effect.provide(
          ServerEnvironment.layer.pipe(
            Layer.provide(ServerSecretStore.layer),
            Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
          ),
        ),
      );
      assert.deepStrictEqual(descriptor.capabilities.factory, FACTORY_CAPABILITY);

      // Encoded by the server and decoded by a client, it still reads as Factory support.
      const received = decodeDescriptor(encodeDescriptor(descriptor));
      assert.deepStrictEqual(factorySupport(received.capabilities), { version: 1 });
    }),
  );
});
