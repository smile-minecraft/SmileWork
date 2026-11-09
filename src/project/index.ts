export { resolveActor, actorHint } from "./actor.ts";
export { gitHeadFor, gitLocationFor, type GitLocation } from "./git.ts";
export { findLegacyProjectIdentity, type LegacyProjectIdentity } from "./legacy.ts";
export {
  resolveProject,
  tryResolveProject,
  requireProject,
  type ResolveProjectOptions,
} from "./resolve.ts";
export {
  findProjectByPath,
  getProject,
  listProjects,
  preferRegisteredAncestor,
  registerProject,
  relinkProject,
  type RelinkProjectOptions,
  type RelinkProjectResult,
} from "./registry.ts";
