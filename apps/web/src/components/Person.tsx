"use client";

import { PersonName } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import type { PersonRef } from "../lib/people";

/**
 * A person in a line, cell, option or row: their avatar and name. A person who left (`null`) is
 * "Former member" with the initial; the viewer's own entry reads "You" with their avatar.
 */
export function Person({
  person,
  size,
  viewerId,
  secondary,
}: {
  person: PersonRef | null | undefined;
  size: 16 | 24;
  viewerId?: string;
  secondary?: string;
}) {
  const t = useTranslations("people");
  if (person === null || person === undefined) {
    return (
      <PersonName
        name={t("departed")}
        avatarUrl={null}
        size={size}
        {...(secondary === undefined ? {} : { secondary })}
      />
    );
  }
  return (
    <PersonName
      name={viewerId !== undefined && person.id === viewerId ? t("you") : person.name}
      avatarUrl={person.avatarUrl}
      size={size}
      {...(secondary === undefined ? {} : { secondary })}
    />
  );
}
