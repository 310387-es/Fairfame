"use client";

import { ArrowRight, Plus, Unlink } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { linkClientAction, switchOrganizationAction, unlinkClientAction } from "@/server/agency";

/**
 * The agency console's roster (P4-T5).
 *
 * "Open" switches the session's active organization and lands on that client's
 * Home. **It is a switch, not a window into another tenant**: from that point
 * every screen is the ordinary product, scoped by RLS to the organization the
 * session now names. There is no cross-organization view beyond the summary
 * figures here, and deliberately so — a screen that read two tenants' data at
 * once would be the one shape this architecture has refused everywhere else.
 */

export type ClientCard = {
  organizationId: string;
  name: string;
  label: string | null;
  slug: string;
  role: string;
  locations: number;
  reviews: number;
  /** Already localised, or null when nobody rated anything. */
  rating: string | null;
  openItems: number;
};

export function ClientRoster({
  clients,
  canManage,
}: {
  clients: ClientCard[];
  canManage: boolean;
}) {
  const t = useTranslations("clients");
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [slug, setSlug] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const open = (organizationId: string) => {
    setError(null);
    startTransition(async () => {
      const result = await switchOrganizationAction({ organizationId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push("/home");
    });
  };

  const link = () => {
    setError(null);
    startTransition(async () => {
      const result = await linkClientAction({ slug: slug.trim(), label: label.trim() || null });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSlug("");
      setLabel("");
      setAdding(false);
      router.refresh();
    });
  };

  const unlink = (organizationId: string) => {
    setError(null);
    startTransition(async () => {
      const result = await unlinkClientAction({ clientOrganizationId: organizationId });
      if (!result.ok) setError(result.error);
      else router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-3">
      {clients.length > 0 ? (
        <ul className="divide-y divide-line-soft rounded-lg border border-line bg-card">
          {clients.map((client) => (
            <li
              key={client.organizationId}
              className="grid gap-2 px-(--card-px) py-3 sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1.4fr)_auto] sm:items-center sm:gap-3"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="truncate text-copy font-semibold text-foreground">
                  {client.label ?? client.name}
                </span>
                {/* The role is *in that organization*, which is what decides
                    what "Open" will actually let somebody do. */}
                <Badge variant="secondary">{client.role}</Badge>
              </div>

              <p className="text-meta text-ink-400">
                {t("summary", {
                  locations: client.locations,
                  reviews: client.reviews,
                  open: client.openItems,
                })}
                {client.rating ? ` · ${client.rating}` : ""}
              </p>

              <div className="flex items-center gap-1.5 sm:justify-end">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => open(client.organizationId)}
                >
                  {t("open")}
                  <ArrowRight aria-hidden />
                </Button>

                {canManage ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    aria-label={t("unlink", { name: client.label ?? client.name })}
                    onClick={() => unlink(client.organizationId)}
                  >
                    <Unlink aria-hidden />
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {canManage ? (
        adding ? (
          <div className="flex flex-col gap-3 rounded-lg border border-line bg-card px-(--card-px) py-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="client-slug">{t("slug")}</Label>
                <Input
                  id="client-slug"
                  value={slug}
                  autoFocus
                  maxLength={64}
                  placeholder="kadikoy-kahve"
                  onChange={(event) => setSlug(event.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="client-label">{t("label")}</Label>
                <Input
                  id="client-label"
                  value={label}
                  maxLength={80}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </div>
            </div>

            {/* Says the rule out loud, because it is the thing that will
                surprise somebody: linking is bookkeeping, not access. */}
            <p className="text-meta text-faint">{t("linkHint")}</p>

            <div className="flex items-center gap-2">
              <Button size="sm" onClick={link} disabled={pending || !slug.trim()}>
                {t("linkSubmit")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => {
                  setAdding(false);
                  setError(null);
                }}
              >
                {t("cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              <Plus aria-hidden />
              {t("addClient")}
            </Button>
          </div>
        )
      ) : null}

      {error ? (
        <p role="alert" className="text-copy text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
