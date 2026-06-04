/**
 * Temporal client plumbing, isolated behind a tiny `SarSignalSender` interface
 * so the webhook handler can be unit-tested without a live Temporal cluster.
 */
import { Connection, WorkflowClient } from "@temporalio/client";

import { SAR_TEMPORAL_NAMESPACE } from "./constants";

export interface SarSignalSender {
  signalWorkflow(
    workflowId: string,
    signalName: string,
    arg: unknown,
  ): Promise<void>;
}

/** Connect a Temporal WorkflowClient bound to the SAR namespace. */
export async function connectWorkflowClient(
  address: string | undefined = process.env.TEMPORAL_HOSTPORT,
): Promise<WorkflowClient> {
  const connection = await Connection.connect({ address });
  return new WorkflowClient({
    connection,
    namespace: SAR_TEMPORAL_NAMESPACE,
  });
}

/** Wrap a WorkflowClient as a SarSignalSender. */
export function makeSignalSender(client: WorkflowClient): SarSignalSender {
  return {
    async signalWorkflow(workflowId, signalName, arg) {
      await client.getHandle(workflowId).signal(signalName, arg);
    },
  };
}

/**
 * Connect a sender plus a `close()` for the underlying connection — convenient
 * for a per-request caller (e.g. the webhook endpoint) that must not leak the
 * Temporal connection.
 */
export async function createSignalSender(
  address: string | undefined = process.env.TEMPORAL_HOSTPORT,
): Promise<{ sender: SarSignalSender; close: () => Promise<void> }> {
  const connection = await Connection.connect({ address });
  const client = new WorkflowClient({
    connection,
    namespace: SAR_TEMPORAL_NAMESPACE,
  });
  return { sender: makeSignalSender(client), close: () => connection.close() };
}
