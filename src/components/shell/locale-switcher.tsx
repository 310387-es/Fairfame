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

      {/* No heading row. The trigger already carries a globe and the
          accessible name, and every item is the language written in its own
          language — a "Language" caption above them restates the icon and
          costs a row in a menu that only ever holds the locales. The name
          lives on the trigger's `aria-label`, where a screen reader reads it
          before the menu opens rather than after. */}
      <DropdownMenuContent align="end" className="w-40">
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
