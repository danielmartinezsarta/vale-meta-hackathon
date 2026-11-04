"use client";

import type { ValeLanguage } from "@/lib/vale-language";
import { AgendaScreen } from "./AgendaScreen";
import { ClientsScreen } from "./ClientsScreen";
import { PaymentsScreen } from "./PaymentsScreen";
import { ServicesScreen } from "./ServicesScreen";
import { ShoppingScreen } from "./ShoppingScreen";
import { SuppliesScreen } from "./SuppliesScreen";

/**
 * HACK-030 host: every menu item opens its screen in the HomeScreen
 * overlay. Unknown names render nothing; the menu stays.
 */
export function ManageScreensHost({
  name,
  onBack,
  language,
  onLanguageChange,
}: {
  name: string;
  onBack: () => void;
  language: ValeLanguage;
  onLanguageChange?: (next: ValeLanguage) => void;
}) {
  switch (name) {
    case "Agenda":
      return <AgendaScreen onBack={onBack} />;
    case "Client files":
      return <ClientsScreen onBack={onBack} />;
    case "Services":
      return <ServicesScreen onBack={onBack} />;
    case "Supplies & stock":
      return <SuppliesScreen onBack={onBack} />;
    case "Shopping list":
      return <ShoppingScreen onBack={onBack} />;
    case "Payments":
      return <PaymentsScreen onBack={onBack} />;
    default:
      return null;
  }
}
