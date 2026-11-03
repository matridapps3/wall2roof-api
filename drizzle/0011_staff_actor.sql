ALTER TABLE "order_events" ADD COLUMN "actor_user_id" integer;--> statement-breakpoint
ALTER TABLE "order_events" ADD COLUMN "actor_label" text;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;