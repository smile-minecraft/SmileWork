export type {
  ParsedEntry,
  TranscriptEntry,
  TranscriptIndexState,
  TranscriptReadEntry,
  TranscriptReadInput,
  TranscriptRole,
  TranscriptSearchHit,
  TranscriptSearchInput,
  TranscriptSource,
  TranscriptWarning,
} from "./types.ts";
export { TRANSCRIPT_ROLES, TRANSCRIPT_SOURCES } from "./types.ts";
export {
  isProjectExcluded,
  normalizeProjectPath,
  readTranscriptConfig,
  transcriptPaths,
  type TranscriptConfig,
  type TranscriptPaths,
} from "./config.ts";
export { buildTranscriptIndex, type BuildOptions, type BuildReport } from "./indexer.ts";
export {
  ensureTranscriptIndex,
  searchTranscripts,
  type TranscriptServiceOptions,
} from "./search.ts";
export { readTranscriptSession, TRANSCRIPT_READ_ERRORS } from "./read.ts";
export {
  acquireBuildLock,
  buildLockPath,
  isBuildLockActive,
  type BuildLock,
} from "./lock.ts";
export {
  openTranscriptIndex,
  openTranscriptIndexReadonly,
  readSchemaVersion,
} from "./index-db.ts";
