import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Inbox placeholder. T10 wires this to the ingested reviews for the active
 * location; the empty state below is what a new organization genuinely sees.
 */
export default async function InboxPage() {
  const t = await getTranslations("inbox");

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <Card>
        <CardContent className="flex flex-col items-center gap-4 py-14 text-center">
          <p className="max-w-sm text-sm text-pretty text-muted-foreground">{t("empty")}</p>
          <Button asChild variant="outline" size="sm">
            <Link href="/locations">{t("emptyAction")}</Link>
          </Button>
        </CardContent>
      </Card>
    </>
  );
}
