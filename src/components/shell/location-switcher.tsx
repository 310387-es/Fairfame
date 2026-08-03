"use client";

import { Check, ChevronsUpDown, MapPin } from "lucide-react";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { setActiveLocationAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { LocationOption } from "@/lib/active-location";

export function LocationSwitcher({
  locations,
  activeId,
}: {
  locations: LocationOption[];
  activeId: string | null;
}) {
  const t = useTranslations("shell");
  const [pending, startTransition] = useTransition();

  const active = locations.find((location) => location.id === activeId);

  if (locations.length === 0) {
    return (
      <span className="flex items-center gap-2 text-body text-muted-foreground">
        <MapPin className="size-4" aria-hidden />
        {t("noLocations")}
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={pending} className="gap-2">
          <MapPin className="size-4" aria-hidden />
          <span className="max-w-[16ch] truncate">{active?.name ?? t("locationSwitcher")}</span>
          <ChevronsUpDown className="size-3.5 opacity-60" aria-hidden />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>{t("locationSwitcher")}</DropdownMenuLabel>
        {locations.map((location) => (
          <DropdownMenuItem
            key={location.id}
            onSelect={() => {
              if (location.id === activeId) return;
              startTransition(() => {
                void setActiveLocationAction(location.id);
              });
            }}
            className="justify-between"
          >
            <span className="truncate">{location.name}</span>
            {location.id === activeId ? <Check className="size-4" aria-hidden /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
