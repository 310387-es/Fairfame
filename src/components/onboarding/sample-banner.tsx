"use client";

import { Coffee, Loader2, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useAction } from "@/components/ui/use-action";
import { deleteSampleWorkspaceAction } from "@/server/onboarding";

/**
 * "You are in the sample workspace" (W5-14).
 *
 * On every screen, not just the dashboard, and that is the point. The demo
 * exists so somebody can wander through Reviews, Analytics and the weekly plan
 * — which means every one of those screens is a place where they could forget
 * where they are and conclude the product invented data about their business.
 * A banner that appears only on the first screen is a banner that has stopped
 * saying anything by the third.
 *
 * It carries the way out, because a demo you cannot leave is a trap: leaving is
 * the workspace switcher in the user menu, and deleting is here.
 */
export function SampleBanner({ canDelete }: { canDelete: boolean }) {
  const t = useTranslations("onboarding");
  const router = useRouter();
  const { run, pending } = useAction();

  return (
    <div className="flex flex-wrap items-center gap-2.5 rounded-lg border border-line bg-surface-sunken px-3.5 py-2.5">
      <Coffee className="size-4 shrink-0 text-ink-400" aria-hidden />
      <p className="text-copy text-ink-600">
        <span className="font-medium">{t("banner.title")}</span> {t("banner.body")}
      </p>

      {canDelete ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto"
          disabled={pending}
          onClick={() =>
            run(async () => {
              const result = await deleteSampleWorkspaceAction();
              // The organization this page is scoped to no longer exists, so
              // this must be a navigation and not a refresh.
              if (result.ok) router.push("/dashboard");
              return result;
            })
          }
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Trash2 className="size-4" aria-hidden />
          )}
          {t("banner.remove")}
        </Button>
      ) : null}
    </div>
  );
}
