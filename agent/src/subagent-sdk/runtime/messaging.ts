import type { AgentToolUpdateCallback, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type {
  CancelSubagentParams,
  MessageSubagentParams,
  MessageSubagentResult,
  RuntimeSubagent,
} from "../types.js";
import { emitProgressUpdate, runtimeSubagentError } from "./base.js";
import { SubagentRuntimeExecution } from "./execution.js";

export abstract class SubagentRuntimeMessaging extends SubagentRuntimeExecution {
  async message(
    params: MessageSubagentParams,
    ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback,
  ): Promise<MessageSubagentResult> {
    const { state, autoResumed, resumePrompt } = await this.resolveMessageTarget(
      params.sessionId,
      ctx,
      onUpdate,
    );
    const deliveredState = await this.deliverMessage(state, params, onUpdate);
    return {
      state: this.toPublicState(deliveredState),
      autoResumed,
      resumePrompt,
    };
  }

  protected async resolveMessageTarget(
    sessionId: string,
    ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback,
  ): Promise<{ state: RuntimeSubagent; autoResumed: boolean; resumePrompt?: string }> {
    const existing = this.getStateOrThrow("message", sessionId);

    if (await this.hasLivePane(existing)) {
      this.activeSessionIds.add(existing.sessionId);
      return { state: existing, autoResumed: false };
    }

    this.activeSessionIds.delete(existing.sessionId);
    const resumed = await this.resume(
      {
        sessionId: existing.sessionId,
        task: existing.task,
        mode: existing.mode,
        cwd: existing.cwd,
        autoExit: existing.autoExit,
      },
      ctx,
      onUpdate,
      { progressAction: "message", errorAction: "message" },
    );
    return {
      state: resumed.state,
      autoResumed: true,
      resumePrompt: resumed.prompt,
    };
  }

  protected async deliverMessage(
    state: RuntimeSubagent,
    params: MessageSubagentParams,
    onUpdate?: AgentToolUpdateCallback,
  ): Promise<RuntimeSubagent> {
    const startedAt = Date.now();

    emitProgressUpdate(onUpdate, {
      action: "message",
      phase: "message",
      statusText: `Sending ${params.delivery} to ${state.name}`,
      preview: params.message,
      delivery: params.delivery,
      durationMs: 0,
    });

    await this.persistDeliveredMessageStatus(params, "pending");

    try {
      await this.markParentInjectedInput(state.sessionId);
      await this.adapter.sendText(state.paneId, params.message, params.delivery);
      emitProgressUpdate(onUpdate, {
        action: "message",
        phase: "message",
        statusText: `Delivered ${params.delivery} to ${state.name}`,
        preview: params.message,
        delivery: params.delivery,
        durationMs: Date.now() - startedAt,
      });
      await this.persistDeliveredMessageStatus(params, "delivered", Date.now());

      const updatedState = this.buildDeliveredMessageState(state);

      this.states.set(updatedState.sessionId, updatedState);
      await this.hooks.persistState(updatedState);
      this.refreshWidget();
      return updatedState;
    } catch (error) {
      await this.persistDeliveredMessageStatus(params, "failed");
      throw error;
    }
  }

  protected persistDeliveredMessageStatus(
    params: MessageSubagentParams,
    status: "pending" | "delivered" | "failed",
    deliveredAt?: number,
  ): Promise<void> {
    return this.hooks.persistMessage({
      sessionId: params.sessionId,
      message: params.message,
      delivery: params.delivery,
      createdAt: Date.now(),
      ...(deliveredAt === undefined ? {} : { deliveredAt }),
      status,
    });
  }

  protected buildDeliveredMessageState(state: RuntimeSubagent): RuntimeSubagent {
    return {
      ...state,
      event: "updated",
      status: "running",
      autoExitDeadlineAt: undefined,
      autoExitTimeoutActive: state.autoExitTimeoutActive,
      updatedAt: Date.now(),
    };
  }

  async cancel(params: CancelSubagentParams): Promise<RuntimeSubagent> {
    const state = this.getStateOrThrow("cancel", params.sessionId);
    if (!this.activeSessionIds.has(params.sessionId)) {
      throw runtimeSubagentError(
        "cancel",
        `${state.name} (${state.sessionId}) does not have a live tmux pane/window right now. Inspect subagent list or the tmux state first.`,
      );
    }

    await this.adapter.killPane(state.paneId);
    const cancelled: RuntimeSubagent = {
      ...state,
      event: "cancelled",
      status: "cancelled",
      autoExitDeadlineAt: undefined,
      updatedAt: Date.now(),
      completedAt: Date.now(),
    };

    this.states.set(cancelled.sessionId, cancelled);
    this.activeSessionIds.delete(cancelled.sessionId);
    await this.hooks.persistState(cancelled);
    this.stopPollingIfIdle();
    this.refreshWidget();
    this.hooks.emitStatusMessage({
      content: `Subagent ${state.name} (${state.sessionId}) was cancelled.`,
    });
    return this.toPublicState(cancelled);
  }

  protected abstract markParentInjectedInput(sessionId: string): Promise<void>;
  protected abstract stopPollingIfIdle(): void;
}
