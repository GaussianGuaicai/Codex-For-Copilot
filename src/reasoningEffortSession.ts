import { normalizeReasoningEffort, type ReasoningEffort } from './reasoningEffort';

/** Prototype chatProvider API. Only the accompanying VS Code patch supplies this context. */
export interface ReasoningEffortSessionContext {
  readonly protocolVersion: 1;
  readonly sessionId: string;
  readonly taskId: string;
  readonly revision: number;
  readonly state: 'running' | 'ended';
  readonly source: 'request' | 'user' | 'lifecycle';
  readonly configuration: Readonly<{ reasoningEffort?: string }>;
}

interface SessionSelection {
  readonly taskId: string;
  readonly modelId: string;
  revision: number;
  observed: ReasoningEffort | undefined;
  effective: ReasoningEffort | undefined;
  ended?: boolean;
}

/** Live consent only. Request baselines and replay history remain owned by Branch Store. */
export class ReasoningEffortSessions {
  private readonly sessions = new Map<string, SessionSelection>();

  constructor(private readonly confirm: (effort: ReasoningEffort) => PromiseLike<string | undefined>) {}

  resolve(modelId: string, context: ReasoningEffortSessionContext | undefined, selected: ReasoningEffort | undefined):
    { effort: ReasoningEffort | undefined; live: boolean; sessionId?: string } {
    if (!isSessionContext(context) || context.state !== 'running' || context.source !== 'request') {
      return { effort: selected, live: false };
    }
    let session = this.sessions.get(context.sessionId);
    if (!session || session.taskId !== context.taskId || session.modelId !== modelId) {
      // Bound memory without evicting another active task's consent state.
      for (const [sessionId, entry] of this.sessions) {
        if (this.sessions.size < 128) {
          break;
        }
        if (entry.ended) {
          this.sessions.delete(sessionId);
        }
      }
      if (!session && this.sessions.size >= 128) {
        return { effort: selected, live: false, sessionId: context.sessionId };
      }
      const effort = normalizeReasoningEffort(context.configuration.reasoningEffort) ?? selected;
      session = { taskId: context.taskId, modelId, revision: context.revision, observed: effort, effective: effort };
      this.sessions.set(context.sessionId, session);
    }
    // Native request options can be stale for the entire tool loop. Only an
    // explicit, revisioned user event can change this task's selection.
    return session.ended
      ? { effort: selected, live: false, sessionId: context.sessionId }
      : { effort: session.effective, live: true, sessionId: context.sessionId };
  }

  async handleChange(modelId: string, context: ReasoningEffortSessionContext): Promise<void> {
    if (!isSessionContext(context)) {
      return;
    }
    const session = this.sessions.get(context.sessionId);
    if (context.state === 'ended' && !session && this.sessions.size < 128) {
      this.sessions.set(context.sessionId, { taskId: context.taskId, modelId, revision: context.revision,
        observed: undefined, effective: undefined, ended: true });
      return;
    }
    if (!session || session.taskId !== context.taskId || session.modelId !== modelId || session.ended) {
      return;
    }
    if (context.state === 'ended') {
      session.ended = true;
      session.revision++;
      return;
    }
    if (context.source !== 'user' || context.revision <= session.revision) {
      return;
    }
    session.revision = context.revision;
    const effort = normalizeReasoningEffort(context.configuration.reasoningEffort);
    if (!effort || effort === session.observed) {
      return;
    }
    session.observed = effort;
    const choice = await this.confirm(effort);
    if (choice === 'Apply to Current Task'
      && this.sessions.get(context.sessionId) === session
      && session.revision === context.revision) {
      session.effective = effort;
    }
  }

  dispose(): void {
    this.sessions.clear();
  }
}

function isSessionContext(context: ReasoningEffortSessionContext | undefined): context is ReasoningEffortSessionContext {
  return context?.protocolVersion === 1
    && typeof context.sessionId === 'string' && context.sessionId.length > 0
    && typeof context.taskId === 'string' && context.taskId.length > 0
    && Number.isSafeInteger(context.revision) && context.revision >= 0
    && (context.state === 'running' || context.state === 'ended')
    && (context.source === 'request' || context.source === 'user' || context.source === 'lifecycle')
    && typeof context.configuration === 'object' && context.configuration !== null;
}
