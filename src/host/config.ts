/** Deployment configuration for the browser tools and their Client round trips. */

import Schema from '@deepseek-ai/schemastery'

/** Deployment-varying browser limits and timings. */
export interface BrowserConfig {
  /** How long a tool waits for a Client poll before reporting the GUI unavailable. */
  clientWaitMs?: number
  /** How long one Client long poll stays open without a command. */
  pollTimeoutMs?: number
  /** Deadline for one claimed browser operation. */
  operationTimeoutMs?: number
  /** Deadline for one managed-script run. */
  codeTimeoutMs?: number
  /** Deadline for one captured dialog awaiting a decision. */
  dialogTimeoutMs?: number
  /** How long the model-control border stays lit after the last operation. */
  lingerMs?: number
  /** Maximum characters one page read returns. */
  maxReadChars?: number
  /** Maximum characters one tool result carries. */
  maxOutputChars?: number
  /** Maximum characters one managed script may carry. */
  maxCodeChars?: number
  /** Maximum encoded bytes one screenshot may carry. */
  maxScreenshotBytes?: number
  /** Maximum viewport tiles one whole-document capture may scroll and stitch. */
  maxFullPageTiles?: number
  /** Width used to lay out a page whose conversation is not on screen. */
  backgroundCaptureWidth?: number
  /** Height used to lay out a page whose conversation is not on screen. */
  backgroundCaptureHeight?: number
}

/** Fully resolved browser configuration. */
export interface ResolvedBrowserConfig {
  readonly clientWaitMs: number
  readonly pollTimeoutMs: number
  readonly operationTimeoutMs: number
  readonly codeTimeoutMs: number
  readonly dialogTimeoutMs: number
  readonly lingerMs: number
  readonly maxReadChars: number
  readonly maxOutputChars: number
  readonly maxCodeChars: number
  readonly maxScreenshotBytes: number
  readonly maxFullPageTiles: number
  readonly backgroundCaptureWidth: number
  readonly backgroundCaptureHeight: number
}

/** Loader schema for every browser limit, with the deployment defaults applied. */
export const BrowserConfigSchema: Schema<BrowserConfig> = Schema.object({
  clientWaitMs: Schema.number().step(1).min(1).default(15_000),
  pollTimeoutMs: Schema.number().step(1).min(1).default(25_000),
  operationTimeoutMs: Schema.number().step(1).min(1).default(30_000),
  codeTimeoutMs: Schema.number().step(1).min(1).default(180_000),
  dialogTimeoutMs: Schema.number().step(1).min(1).default(120_000),
  lingerMs: Schema.number().step(1).min(0).default(2_000),
  maxReadChars: Schema.number().step(1).min(1).default(40_000),
  maxOutputChars: Schema.number().step(1).min(1).default(50_000),
  maxCodeChars: Schema.number().step(1).min(1).default(100_000),
  maxScreenshotBytes: Schema.number().step(1).min(1).default(8_388_608),
  maxFullPageTiles: Schema.number().step(1).min(1).default(8),
  backgroundCaptureWidth: Schema.number().step(1).min(1).default(1_024),
  backgroundCaptureHeight: Schema.number().step(1).min(1).default(768),
})

/**
 * Resolve every browser limit before the plugin activates.
 * @param input - deployment configuration, with schema defaults already applied.
 * @returns the complete immutable configuration.
 */
export function resolveBrowserConfig(input: BrowserConfig = {}): ResolvedBrowserConfig {
  return {
    clientWaitMs: input.clientWaitMs ?? 15_000,
    pollTimeoutMs: input.pollTimeoutMs ?? 25_000,
    operationTimeoutMs: input.operationTimeoutMs ?? 30_000,
    codeTimeoutMs: input.codeTimeoutMs ?? 180_000,
    dialogTimeoutMs: input.dialogTimeoutMs ?? 120_000,
    lingerMs: input.lingerMs ?? 2_000,
    maxReadChars: input.maxReadChars ?? 40_000,
    maxOutputChars: input.maxOutputChars ?? 50_000,
    maxCodeChars: input.maxCodeChars ?? 100_000,
    maxScreenshotBytes: input.maxScreenshotBytes ?? 8_388_608,
    maxFullPageTiles: input.maxFullPageTiles ?? 8,
    backgroundCaptureWidth: input.backgroundCaptureWidth ?? 1_024,
    backgroundCaptureHeight: input.backgroundCaptureHeight ?? 768,
  }
}