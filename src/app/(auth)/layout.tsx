import { getTranslations } from "next-intl/server";

/** Centred, chrome-free layout for the pre-authentication screens. */
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations("app");

  return (
    <div className="flex min-h-screen flex-1 flex-col items-center justify-center px-4 py-12">
      <div className="mb-8 flex items-center gap-2">
        <span className="size-6 rounded-[7px] bg-primary" aria-hidden />
        <span className="text-xl font-semibold tracking-tight">{t("name")}</span>
      </div>
      <div className="w-full max-w-sm">{children}</div>
      <p className="mt-8 text-xs text-muted-foreground">{t("tagline")}</p>
    </div>
  );
}
