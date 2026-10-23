import { SourceControlProviderKind } from "@t3tools/contracts";
import { defineSourceControlDriver } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as OriginPullRequestProvider from "./OriginPullRequestProvider.ts";
import * as OriginCli from "./OriginCli.ts";
import * as OriginSourceControlProvider from "./OriginSourceControlProvider.ts";

export const driver = defineSourceControlDriver({
  kind: SourceControlProviderKind.make("cursor-origin"),
  make: Effect.all({
    sourceControl: OriginSourceControlProvider.make,
    discovery: Effect.succeed(OriginSourceControlProvider.discovery),
    pullRequests: OriginPullRequestProvider.make.pipe(Effect.provide(OriginCli.layer)),
  }),
});
