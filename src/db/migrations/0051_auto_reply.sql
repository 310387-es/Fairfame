-- Auto-reply to a wordless five-star review (W5-6, item 6 on the backlog).
--
-- The remediation plan asks for "auto-post AI reply to 5★ with no text after
-- 24h; queue the rest", and `src/replies/service.ts` has carried a comment
-- since P1a-T6 saying that no future "just auto-post the 5-star ones" should
-- slip in without somebody reading it. It was read. The rule is kept rather
-- than waived, and the shape of these two columns is how:
--
--   * It posts a **template the business wrote**, never generated text. That is
--     not a compromise, it is what the condition forces: a review with no words
--     is exactly what `draftReplyForReview` refuses, because there is nothing
--     to read and a reply generated from a star alone would be inventing the
--     only content it has. So `auto_reply_template_id` points at
--     `reply_templates` — the business's own sentence, with the same variables
--     the composer offers.
--   * **Null is off, and off is the default.** One column, so there is no
--     boolean that can disagree with it, and no organization acquires this
--     behaviour by upgrading.
--   * ON DELETE SET NULL, deliberately. Deleting the template a rule points at
--     turns the rule off rather than leaving it pointing at nothing — the safe
--     direction, and the one somebody tidying up their templates would expect.
--
-- The delay is the human's window. Twenty-four hours is the plan's figure: long
-- enough for anybody watching the Inbox to answer it themselves or switch the
-- rule off, short enough that the reply still reads as attentive.
ALTER TABLE "locations"
  ADD COLUMN "auto_reply_template_id" uuid REFERENCES "reply_templates"("id") ON DELETE SET NULL;--> statement-breakpoint

ALTER TABLE "locations"
  ADD COLUMN "auto_reply_delay_hours" integer NOT NULL DEFAULT 24;
