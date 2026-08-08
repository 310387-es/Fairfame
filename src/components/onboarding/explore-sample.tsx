"use client";

import { Coffee, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useAction } from "@/components/ui/use-action";
import { createSampleWorkspaceAction } from "@/server/onboarding";

/**
 * "Explore with sample data" (positioning win 1 in `docs/remediation-plan.md`).
 *
 * Sits under the create-organization form rather than beside it, and that
 * ordering is the argument: somebody who came here to set up their business
 * should see the form first. This is for the visitor who wants to know what
 * they are signing up for before handing over a Google authorization — which,
 * for a product whose two selling points both need reviews to exist, is
 * otherwise impossible.
 *
 * It builds a **separate organization** (see `src/onboarding/sample.ts`), so
 * pressing it can never put invented reviews anywhere near a real business's
 * numbers, and the workspace switcher moves back out of it.
 */
export function ExploreSample() {
  const t = useTranslations("onboarding");
  const router = useRouter();
  const { run, pending } = useAction();

  return (
    <div className="mt-4 rounded-lg border border-dashed border-line p-4 text-center">
      <p className="text-copy text-muted-foreground">{t("sample.pitch")}</p>

      <Button
        type="button"
        variant="outline"
        className="mt-3"
        disabled={pending}
        onClick={() =>
          run(async () => {
            const result = await createSampleWorkspaceAction();
            // The whole shell changes — nav, entitlements, the branch switcher
            // — so this is a navigation rather than a refresh.
            if (result.ok) router.push("/welcome");
            return result;
          })
        }
      >
        {pending ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : (
          <Coffee className="size-4" aria-hidden />
        )}
        {pending ? t("sample.building") : t("sample.explore")}
      </Button>
    </div>
  );
}
