ALTER TABLE "orders" ADD COLUMN "tip_paise" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "gstin" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "gst_business_name" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "voice_note" text;