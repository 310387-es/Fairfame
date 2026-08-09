"use client";

import { Check, Languages } from "lucide-react";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { setLocaleAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LOCALE_LABELS, LOCALES, type Locale } from "@/i18n/config";
import { cn } from "@/lib/utils";

export function LocaleSwitcher({ locale, className }: { locale: Locale; className?: string }) {
  const t = useTranslations("shell");
  const [pending, startTransition] = useTransition();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          // `className` exists for the marketing masthead, which is `--ink-900`:
          // a ghost button inherits body ink and is invisible on it.
          className={cn("gap-2", className)}
          aria-label={t("localeSwitcher")}
        >
          <Languages className="size-4" aria-hidden />
          <span className="uppercase">{locale}</span>
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuLabel>{t("localeSwitcher")}</DropdownMenuLabel>
        {LOCALES.map((option) => (
          <DropdownMenuItem
            key={option}
            onSelect={() => {
              if (option === locale) return;
              startTransition(() => {
                void setLocaleAction(option);
              });
            }}
            className="justify-between"
          >
            {LOCALE_LABELS[option]}
            {option === locale ? <Check className="size-4" aria-hidden /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
