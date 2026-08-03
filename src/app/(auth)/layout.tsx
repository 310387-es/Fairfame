import { Logo } from "@/components/brand/logo";
import { getTranslations } from "next-intl/server";

/** Centred, chrome-free layout for the pre-authentication screens. */
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations("app");

  return (
    <div className="flex min-h-screen flex-1 flex-col items-center justify-center px-4 py-12">
      <Logo className="mb-8 [&>span:last-child]:text-xl" markClassName="size-8" />
      <div className="w-full max-w-sm">{children}</div>
      <p className="mt-8 text-meta text-faint">{t("tagline")}</p>
    </div>
  );
}
