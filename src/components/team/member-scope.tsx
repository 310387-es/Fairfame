"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Avatar } from "@/components/ds/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import type { LocationOption } from "@/lib/active-location";
import { useAction } from "@/components/ui/use-action";
import { setMemberLocationsAction } from "@/server/team";

/**
 * Which branches one teammate can see.
 *
 * Two explicit choices — **all locations** or **only these** — rather than a bare
 * set of checkboxes. The database records an unrestricted member as *no rows*,
 * so a plain checkbox list would make "everywhere" and "nowhere" the same empty
 * state, and the person setting it would have no way to tell which they had
 * chosen. Naming the two makes the ambiguity impossible to express: "only
 * these" cannot be saved with nothing ticked.
 *
 * An owner is not offered the choice at all. Somebody who can delete the
 * organization cannot meaningfully be kept out of part of it, and the server
 * refuses it too.
 */

export type MemberRow = {
  userId: string;
  name: string;
  email: string;
  role: "owner" | "admin" | "member" | "client";
  locationIds: string[];
};

export function MemberScope({
  member,
  locations,
  canManage,
  roleLabel,
}: {
  member: MemberRow;
  locations: LocationOption[];
  canManage: boolean;
  roleLabel: string;
}) {
  const t = useTranslations("team");
  const tf = useTranslations("feedback");
  const [restricted, setRestricted] = useState(member.locationIds.length > 0);
  const [selected, setSelected] = useState<string[]>(member.locationIds);
  const [saved, setSaved] = useState(false);
  const { run, pending } = useAction();

  const isOwner = member.role === "owner";
  const dirty =
    restricted !== member.locationIds.length > 0 ||
    selected.join() !== [...member.locationIds].join();

  const toggle = (id: string) => {
    setSaved(false);
    setSelected((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );
  };

  const save = () =>
    run(
      () =>
        setMemberLocationsAction({
          userId: member.userId,
          // "All locations" is the empty set — the same thing the absence of
          // rows has always meant.
          locationIds: restricted ? selected : [],
        }),
      { success: tf("saved"), onSuccess: () => setSaved(true) },
    );

  return (
    <div className="flex flex-col gap-3 rounded-md border border-line p-4">
      <div className="flex flex-wrap items-center gap-2">
        {/*
          A person is a monogram everywhere else in the product — the activity
          timeline, the contact list, the review row, the user menu. Team was
          the one screen where a colleague was bare text, which is the screen
          where the people *are* the content. `Avatar` colours from a hash of
          the name, so the same teammate is the same circle here and in the
          timeline that records what they did.
        */}
        <Avatar name={member.name} className="size-6" />
        <span className="text-copy font-semibold">{member.name}</span>
        <Badge variant="secondary">{roleLabel}</Badge>
        <span className="text-meta text-faint">{member.email}</span>
        {saved ? (
          <span role="status" className="ml-auto text-meta text-faint">
            {t("saved")}
          </span>
        ) : null}
      </div>

      {isOwner ? (
        <p className="text-copy text-muted-foreground">{t("ownerSeesEverything")}</p>
      ) : (
        <>
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">{t("scopeLegend", { name: member.name })}</legend>

            <div className="flex flex-wrap items-center gap-4">
              {[
                { value: false, label: t("allLocations") },
                { value: true, label: t("onlySelected") },
              ].map((option) => (
                <label key={String(option.value)} className="flex items-center gap-2 text-copy">
                  <input
                    type="radio"
                    name={`scope-${member.userId}`}
                    checked={restricted === option.value}
                    disabled={!canManage || pending}
                    onChange={() => {
                      setRestricted(option.value);
                      setSaved(false);
                    }}
                    className="size-4 accent-primary"
                  />
                  {option.label}
                </label>
              ))}
            </div>

            {restricted ? (
              <div className="flex flex-wrap gap-3 pt-1">
                {locations.map((location) => (
                  <div key={location.id} className="flex items-center gap-2">
                    <Checkbox
                      id={`loc-${member.userId}-${location.id}`}
                      checked={selected.includes(location.id)}
                      disabled={!canManage || pending}
                      onCheckedChange={() => toggle(location.id)}
                    />
                    <Label htmlFor={`loc-${member.userId}-${location.id}`}>{location.name}</Label>
                  </div>
                ))}
              </div>
            ) : null}
          </fieldset>

          {canManage ? (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                disabled={pending || !dirty || (restricted && selected.length === 0)}
                title={restricted && selected.length === 0 ? t("pickOne") : undefined}
                onClick={save}
              >
                {t("save")}
              </Button>
              {restricted && selected.length === 0 ? (
                <span className="text-meta text-faint">{t("pickOne")}</span>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
