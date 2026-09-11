/**
 * Foreign PTY harness continuity — resume argv + hook install for agents that
 * run as ordinary pane programs. Provider auth lives elsewhere
 * (`plugin-agent-harness` integrations); these adapters are harness-scoped.
 *
 * Host variants:
 * - `./cli` — `amux agent-hook` + adapter registration
 * - `./daemon` — resume adapter registration for restore
 */
export {
  adapters,
  claudeAdapter,
  codexAdapter,
  cursorAdapter,
  opencodeAdapter,
} from "./adapters/index.ts";
export { agentContinuityCliPlugin } from "./cli.ts";
export { agentContinuityDaemonPlugin } from "./daemon.ts";
