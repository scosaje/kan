CREATE TABLE IF NOT EXISTS "sar_card_workflow" (
	"cardPublicId" varchar(12) PRIMARY KEY NOT NULL,
	"workflowId" text NOT NULL,
	"workflowType" text NOT NULL,
	"boardSlug" varchar(255) NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sar_card_workflow" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sar_card_workflow" ADD CONSTRAINT "sar_card_workflow_cardPublicId_card_publicId_fk" FOREIGN KEY ("cardPublicId") REFERENCES "public"."card"("publicId") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
