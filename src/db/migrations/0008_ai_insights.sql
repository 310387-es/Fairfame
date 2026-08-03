-- pgvector must exist before any `vector` column can be declared. The generated
-- DDL below assumes it, so creating it here is what makes this migration
-- runnable on a fresh database rather than only on one where somebody
-- remembered to enable the extension by hand.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."sentiment" AS ENUM('positive', 'neutral', 'negative');--> statement-breakpoint
CREATE TABLE "review_insights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"sentiment" "sentiment" NOT NULL,
	"sentiment_score" real NOT NULL,
	"topics" text[] DEFAULT '{}'::text[] NOT NULL,
	"language" text,
	"embedding" vector(768),
	"prompt_id" text NOT NULL,
	"model" text NOT NULL,
	"analyzed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_insights_review_id_key" UNIQUE("review_id"),
	CONSTRAINT "review_insights_score_range" CHECK ("review_insights"."sentiment_score" between -1 and 1)
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"review_count" integer DEFAULT 0 NOT NULL,
	"merged_into_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_organization_id_slug_key" UNIQUE("organization_id","slug")
);
--> statement-breakpoint
ALTER TABLE "review_insights" ADD CONSTRAINT "review_insights_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_insights" ADD CONSTRAINT "review_insights_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_insights_organization_id_idx" ON "review_insights" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "review_insights_org_sentiment_idx" ON "review_insights" USING btree ("organization_id","sentiment");--> statement-breakpoint
CREATE INDEX "review_insights_topics_idx" ON "review_insights" USING gin ("topics");--> statement-breakpoint
CREATE INDEX "tags_organization_id_idx" ON "tags" USING btree ("organization_id");--> statement-breakpoint
-- Approximate nearest-neighbour index for theme clustering and "find similar
-- complaints" (P1a-T7). Cosine distance, because embedding similarity is about
-- direction rather than magnitude — two reviews making the same complaint at
-- different lengths should still be neighbours.
--
-- HNSW rather than IVFFlat: IVFFlat needs a representative sample of rows
-- before its lists mean anything, and this table starts empty. HNSW builds
-- incrementally and needs no training pass.
--
-- Note that tenant-filtered queries will usually prefer the organization_id
-- index plus a sort until a single tenant is large; see findSimilarReviews in
-- src/ai/insights.ts for the measured behaviour and the scaling lever.
CREATE INDEX "review_insights_embedding_idx"
  ON "review_insights"
  USING hnsw ("embedding" vector_cosine_ops);
