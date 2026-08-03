CREATE TYPE "public"."review_item_type" AS ENUM('review', 'comment', 'mention', 'dm');--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "item_type" "review_item_type" DEFAULT 'review' NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_rating_only_on_reviews" CHECK ("reviews"."item_type" = 'review' or "reviews"."rating" is null);