CREATE TABLE "product_group_items" (
	"group_id" integer NOT NULL,
	"sku" text NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_id" integer NOT NULL,
	"name" text NOT NULL,
	"brand_name" text,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_updated_at" text,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_group_items" ADD CONSTRAINT "product_group_items_group_id_product_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."product_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_group_items_sku_uq" ON "product_group_items" USING btree ("sku");--> statement-breakpoint
CREATE INDEX "product_group_items_group_idx" ON "product_group_items" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_groups_source_uq" ON "product_groups" USING btree ("source_id");