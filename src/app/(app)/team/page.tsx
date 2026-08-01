import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent } from "@/components/ui/card";

export default async function TeamPage() {
  const t = await getTranslations("team");

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          {t("placeholder")}
        </CardContent>
      </Card>
    </>
  );
}
