DROP INDEX "product_reviews_user_product_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "product_reviews_user_product_order_uq" ON "product_reviews" USING btree ("user_id","product_id","order_id");