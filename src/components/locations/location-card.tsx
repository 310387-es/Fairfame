"use client";

import { Link2, MessageSquare, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { connectMockSourceAction, syncNowAction } from "@/server/locations";

export type LocationRow = {
  id: string;
  name: string;
  address: string | null;
  category: string | null;
  connectionId: string | null;
  reviewCount: number;
};

export function LocationCard({
  location,
  canManage,
}: {
  location: LocationRow;
  canManage: boolean;
}) {
  const t = useTranslations("locations");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const connected = location.connectionId !== null;

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.error ?? null);
    });
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 py-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-medium">{location.name}</p>
            {location.address ? (
              <p className="truncate text-sm text-muted-foreground">{location.address}</p>
            ) : null}
          </div>
          <Badge variant={connected ? "default" : "secondary"}>
            {connected ? t("connected") : t("notConnected")}
          </Badge>
        </div>

        <p className="text-sm text-muted-foreground">
          {t("reviewCount", { count: location.reviewCount })}
        </p>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {connected ? (
            <>
              <Button asChild size="sm" variant="outline">
                <Link href="/inbox">
                  <MessageSquare className="size-4" aria-hidden />
                  {t("viewInbox")}
                </Link>
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => run(() => syncNowAction({ connectionId: location.connectionId! }))}
              >
                <RefreshCw className="size-4" aria-hidden />
                {pending ? t("syncing") : t("syncNow")}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              disabled={pending || !canManage}
              onClick={() => run(() => connectMockSourceAction({ locationId: location.id }))}
            >
              <Link2 className="size-4" aria-hidden />
              {pending ? t("connecting") : t("connect")}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
