import {
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

import { cards } from "./cards";

/**
 * Card ↔ Temporal-workflow association for the ANSA SAR bridge
 * (@kan/sar-bridge). Kan cards have no free-form metadata column, so this table
 * records which SAR workflow a card represents, keyed by the card's public id.
 * Deleting the card cascades the link away.
 */
export const sarCardWorkflows = pgTable("sar_card_workflow", {
  cardPublicId: varchar("cardPublicId", { length: 12 })
    .primaryKey()
    .references(() => cards.publicId, { onDelete: "cascade" }),
  workflowId: text("workflowId").notNull(),
  workflowType: text("workflowType").notNull(),
  boardSlug: varchar("boardSlug", { length: 255 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}).enableRLS();
