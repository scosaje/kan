import { TRPCError } from "@trpc/server";
import { z } from "zod";

import * as workspaceRepo from "@kan/db/repository/workspace.repo";
import { createCardForWorkflow } from "@kan/sar-bridge";

import { createTRPCRouter, protectedProcedure } from "../trpc";

/**
 * SAR Intelligence bridge router. Lets a SAR Temporal workflow (via an
 * authenticated principal) represent itself as a Kan card on a SAR board; the
 * card is linked back to the workflow so a later board move can signal it
 * (see @kan/sar-bridge and apps/web/src/pages/api/sar/webhook.ts).
 */
export const sarRouter = createTRPCRouter({
  createCardForWorkflow: protectedProcedure
    .input(
      z.object({
        workspacePublicId: z.string().min(12),
        board: z.enum([
          "watchZoneLifecycle",
          "alertsTriage",
          "taskingQueue",
          "dispatchRequests",
          "retrospectiveCases",
        ]),
        list: z.string().min(1),
        title: z.string().min(1).max(255),
        description: z.string().max(10_000).optional(),
        workflowId: z.string().min(1),
        workflowType: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user?.id;
      if (!userId) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "User not authenticated" });
      }

      const workspace = await workspaceRepo.getByPublicId(
        ctx.db,
        input.workspacePublicId,
      );
      if (!workspace) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found" });
      }

      try {
        return await createCardForWorkflow(ctx.db, {
          workspaceId: workspace.id,
          board: input.board,
          list: input.list,
          title: input.title,
          description: input.description,
          workflowId: input.workflowId,
          workflowType: input.workflowType,
          createdBy: userId,
        });
      } catch (err) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: err instanceof Error ? err.message : "Failed to create SAR card",
        });
      }
    }),
});
